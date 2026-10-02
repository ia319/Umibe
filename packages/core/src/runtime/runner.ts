import { randomUUID } from 'node:crypto';
import type { ActionRegistry } from '#internal/action/registry';
import type {
  AgentOptions,
  ModelStage,
  RunHandle,
} from '#internal/contracts/runtime';
import type { CallControl, PlannerRequest } from '#internal/contracts/adapters';
import type { JsonValue } from '#internal/contracts/json';
import type { GoalAssessment, GoalRecord } from '#internal/contracts/goal';
import type { PlanningTrigger } from '#internal/contracts/planning';
import { captureControl, invokeControlled } from '#internal/candidate/control';
import { prepareCandidates } from '#internal/candidate/prepare';
import { checkCandidates } from '#internal/candidate/check';
import { filterCandidates } from '#internal/candidate/filter';
import { selectCandidates } from '#internal/candidate/select';
import { canonicalJson } from '#internal/candidate/identity';
import { ContractError } from '#internal/errors';
import { requireObject, requireString } from '#internal/validation/fields';
import { parseJsonValue } from '#internal/validation/json';
import { parseObservation } from '#internal/validation/observation';
import { parseGoalGraph } from '#internal/validation/goal';
import { parsePlanProposal } from '#internal/validation/planning';
import { readGoalAssessment } from '#internal/validation/assessment';
import { ActionCoordinator } from './execution.js';
import { invokeModel } from './model.js';
import type { RunSession } from './session.js';

const validation = { code: 'INVALID_RUN_CONTROL', stage: 'run_loop' } as const;
class CallStopped extends Error {}
type CallbackStage =
  ModelStage | 'support' | 'observation' | 'checking' | 'filtering';

/** One asynchronous loop per run; control admission never waits for this loop. */
export class RunDriver<TCriteria extends JsonValue> {
  readonly execution: ActionCoordinator;
  #task: Promise<void> | null = null;
  readonly #criteria = new Map<string, TCriteria>();

  constructor(
    readonly session: RunSession,
    private readonly registry: ActionRegistry,
    private readonly options: AgentOptions<TCriteria>,
  ) {
    this.execution = new ActionCoordinator(
      session,
      registry,
      options.environment,
    );
  }

  handle(): RunHandle {
    const result = this.session.result.then((control) =>
      Object.freeze({
        ...control,
        runId: this.session.runId,
        execution: this.session.committedState.execution,
      }),
    );
    void result.catch(() => undefined);
    return Object.freeze({ runId: this.session.runId, result });
  }

  start(): void {
    if (this.#task !== null) return;
    this.#task = this.run().finally(() => {
      this.#task = null;
    });
    void this.#task.catch(() => undefined);
  }

  async stop(kind: 'pause' | 'cancel', reasonCode: string): Promise<void> {
    const record = this.session.event(
      'application_control',
      requireString(reasonCode, validation, '/reasonCode'),
      { control: kind },
    );
    await this.session.transition({
      kind,
      cause: { eventId: record.eventId, reasonCode },
    });
    await this.session.commit(this.session.state, [record]);
    await this.#task;
    await this.settleStop();
  }

  async resume(): Promise<RunHandle> {
    await this.#task;
    await this.session.transition({ kind: 'resume' });
    const handle = this.handle();
    this.start();
    return handle;
  }

  private control(stage: CallbackStage): CallControl {
    const limits = this.session.state.limits;
    return {
      signal: this.session.signal,
      deadlineAt: new Date(
        Date.now() +
          (stage === 'verification' || stage === 'support'
            ? limits.verificationTimeoutMs
            : stage === 'planning' || stage === 'selection'
              ? limits.modelTimeoutMs
              : limits.callbackTimeoutMs),
      ).toISOString(),
    };
  }

  private async call<T>(
    stage: CallbackStage,
    invoke: (control: CallControl) => Promise<T>,
    requestId: string = randomUUID(),
  ): Promise<T> {
    const session = this.session;
    const epoch = session.state.decision.decisionEpoch;
    const control = this.control(stage);
    const startedAt = Date.now();
    await session.commit(session.state, [
      session.event('callback_started', stage, {
        requestId,
        decisionEpoch: epoch,
      }),
    ]);
    if (!session.canDispatch(epoch)) throw new CallStopped();
    const modelStage =
      stage === 'planning' ||
      stage === 'selection' ||
      stage === 'candidates' ||
      stage === 'verification'
        ? stage
        : null;
    const model =
      modelStage !== null &&
      this.options.modelStages?.includes(modelStage) === true;
    const result = model
      ? await invokeModel(
          session,
          { requestId, decisionEpoch: epoch, purpose: modelStage },
          control,
          async (control) => ({ value: await invoke(control), usage: null }),
        )
      : await invokeControlled(captureControl(control), invoke);
    if (!session.canDispatch(epoch)) throw new CallStopped();
    await session.commit(session.state, [
      session.event('callback_finished', stage, {
        requestId,
        decisionEpoch: epoch,
        outcome: result.outcome,
        durationMs: Date.now() - startedAt,
        ...(result.outcome === 'returned'
          ? { response: parseJsonValue(result.value, stage) }
          : {}),
      }),
    ]);
    if (!session.canDispatch(epoch)) throw new CallStopped();
    if (result.outcome !== 'returned') {
      await this.block(`${stage}_${result.outcome}`);
      throw new CallStopped();
    }
    return result.value;
  }

  private async support(goal: GoalRecord): Promise<void> {
    const key = `${goal.id}:${goal.version}`;
    if (this.#criteria.has(key)) return;
    const result = await this.call('support', (control) =>
      this.options.verifier.support(goal.criteria, control),
    );
    const raw = requireObject(
      parseJsonValue(result, validation.stage),
      validation,
      '/support',
    );
    if (raw.outcome !== 'supported') {
      if (raw.outcome !== 'unsupported' && raw.outcome !== 'needsInput')
        throw new ContractError(
          validation.code,
          validation.stage,
          '/support',
          'invalid_support',
        );
      await this.block(
        requireString(raw.reason, validation, '/support/reason'),
      );
      throw new CallStopped();
    }
    if (
      raw.criteria === null ||
      raw.criteria === undefined ||
      !Array.isArray(raw.requiredEvidence) ||
      raw.requiredEvidence.some((path) => typeof path !== 'string')
    )
      throw new ContractError(
        validation.code,
        validation.stage,
        '/support',
        'invalid_support',
      );
    // The verifier owns the decoded type; JSON capture preserves its structure and detaches ownership.
    this.#criteria.set(key, raw.criteria as TCriteria);
  }

  private async observe(): Promise<void> {
    const session = this.session;
    const context = session.state.decision.context;
    const observation = parseObservation(
      await this.call('observation', (control) =>
        this.options.environment.observe(context, control),
      ),
    );
    const previous = session.state.decision.context.observation;
    if (
      observation.runId !== session.runId ||
      observation.revision < previous.revision ||
      (observation.revision === previous.revision &&
        canonicalJson(parseJsonValue(observation, 'observation')) !==
          canonicalJson(parseJsonValue(previous, 'observation')))
    )
      throw new ContractError(
        validation.code,
        validation.stage,
        '/observation',
        'stale_observation',
      );
    await session.replaceDecision({
      ...session.state.decision,
      context: { ...session.state.decision.context, observation },
    });
  }

  private async verify(): Promise<GoalAssessment> {
    const session = this.session;
    const context = session.state.decision.context;
    const goal = context.graph.goals.find(
      (goal) => goal.id === context.graph.currentGoalRef.id,
    )!;
    await this.support(goal);
    const criteria = this.#criteria.get(`${goal.id}:${goal.version}`)!;
    const result = await this.call('verification', (control) =>
      this.options.verifier.verify(
        {
          goal,
          criteria,
          context,
          actionResults:
            context.lastActionResult === null ? [] : [context.lastActionResult],
        },
        control,
      ),
    );
    const assessment = readGoalAssessment(
      parseJsonValue(result, 'verification'),
      validation,
      '/assessment',
    );
    if (
      assessment.goalRef.id !== goal.id ||
      assessment.goalRef.version !== goal.version ||
      assessment.observationRef.id !== context.observation.id ||
      assessment.observationRef.revision !== context.observation.revision
    )
      throw new ContractError(
        validation.code,
        validation.stage,
        '/assessment',
        'stale_assessment',
      );
    const graph = parseGoalGraph({
      runId: context.graph.runId,
      rootGoalRef: context.graph.rootGoalRef,
      currentGoalRef: context.graph.currentGoalRef,
      goals: context.graph.goals.map((item) =>
        item.id === goal.id
          ? {
              ...item,
              lastAssessment: assessment,
              lifecycle:
                assessment.outcome === 'passed' ? 'succeeded' : 'inProgress',
            }
          : item,
      ),
    });
    const decision = {
      ...session.state.decision,
      context: { ...session.state.decision.context, graph },
    };
    await session.commit({ ...session.state, decision }, [
      {
        formatVersion: 1,
        runId: session.runId,
        eventId: randomUUID(),
        kind: 'goalAssessment',
        data: assessment,
      },
    ]);
    if (assessment.outcome === 'needsInput') {
      await this.block(assessment.reason);
      throw new CallStopped();
    }
    if (assessment.outcome === 'passed')
      await session.transition({
        kind: 'succeed',
        assessment,
        observationRef: assessment.observationRef,
      });
    return assessment;
  }

  private async plan(trigger: PlanningTrigger): Promise<void> {
    const session = this.session;
    const request: PlannerRequest = Object.freeze({
      ...session.state.decision,
      requestId: randomUUID(),
      capabilities: this.registry.capabilities,
      trigger,
    });
    const proposal = parsePlanProposal(
      await this.call(
        'planning',
        (control) => this.options.planner.plan(request, control),
        request.requestId,
      ),
      request,
      { maxDepth: 1, maxNewGoals: 1, maxTotalGoals: 1 },
    );
    if (proposal.outcome === 'blocked') {
      await this.block(proposal.reason);
      throw new CallStopped();
    }
    if (proposal.outcome === 'claimComplete') {
      await this.observe();
      const assessment = await this.verify();
      if (assessment.outcome !== 'passed')
        await this.block('completion_not_verified');
      throw new CallStopped();
    }
    if (proposal.outcome !== 'continue')
      throw new ContractError(
        validation.code,
        validation.stage,
        '/proposal',
        'invalid_goal_transition',
      );
    const current = session.state.decision.context;
    const planRef = Object.freeze({
      id: current.planRef?.id ?? randomUUID(),
      version: (current.planRef?.version ?? 0) + 1,
      rootGoalVersion: current.graph.rootGoalRef.version,
    });
    await session.replaceDecision({
      requestId: randomUUID(),
      decisionEpoch: session.state.decision.decisionEpoch + 1,
      context: { ...current, planRef, planGuidance: proposal.guidance },
    });
    await session.commit(session.state, [
      session.event('plan_accepted', trigger.kind, {
        requestId: request.requestId,
        planRef: { ...planRef },
        proposal: parseJsonValue(proposal, 'planning'),
      }),
    ]);
  }

  private async run(): Promise<void> {
    const session = this.session;
    try {
      await this.observe();
      await this.verify();
      while (session.state.control.status === 'running') {
        if (session.state.decision.context.planRef === null)
          await this.plan({ kind: 'initial', assessment: 'notYet' });
        const input = { ...session.state.decision, requestId: randomUUID() };
        const prepared = await prepareCandidates(
          input,
          this.registry,
          {
            generate: (request) =>
              this.call(
                'candidates',
                (control) =>
                  this.options.candidateProvider.generate(request, control),
                request.requestId,
              ),
          },
          this.control('candidates'),
        );
        if (prepared.outcome !== 'prepared') {
          if (session.state.control.status === 'running')
            await this.block(`candidates_${prepared.outcome}`);
          break;
        }
        const checked = await checkCandidates(
          prepared.prepared,
          this.control('checking'),
        );
        if (checked.outcome !== 'checked') {
          if (session.state.control.status === 'running')
            await this.block(`checking_${checked.outcome}`);
          break;
        }
        const filtered = await filterCandidates(
          checked.checked,
          this.control('filtering'),
          this.options.candidateFilter,
        );
        if (filtered.outcome !== 'filtered') {
          if (session.state.control.status === 'running')
            await this.block(`filtering_${filtered.outcome}`);
          break;
        }
        const selected = await selectCandidates(
          filtered.filtered,
          {
            select: (request) =>
              this.call(
                'selection',
                (control) => this.options.selector.select(request, control),
                request.requestId,
              ),
          },
          this.control('selection'),
          this.options.selectorCapacity,
        );
        if (selected.outcome !== 'selected') {
          if (session.state.control.status === 'running')
            await this.block(`selection_${selected.outcome}`);
          break;
        }
        const result = await this.execution.execute(selected);
        if (session.state.control.status !== 'running') break;
        if (result.outcome !== 'recorded') {
          await this.block(result.reasonCode);
          break;
        }
        await this.verify();
      }
    } catch (error) {
      if (
        !(error instanceof CallStopped) &&
        session.failure === null &&
        session.state.control.status === 'running'
      )
        await this.block(
          error instanceof ContractError ? error.reason : 'callback_failed',
        );
    } finally {
      if (session.failure === null) await this.settleStop();
    }
  }

  private async block(reasonCode: string): Promise<void> {
    if (this.session.state.control.status !== 'running') return;
    const record = this.session.event('run_blocked', reasonCode, {});
    await this.session.transition({
      kind: 'pause',
      cause: { eventId: record.eventId, reasonCode },
    });
    await this.session.commit(this.session.state, [record]);
  }

  private async settleStop(): Promise<void> {
    if (this.session.hasExecution) return;
    const control = this.session.state.control;
    if (control.status === 'pausing' || control.status === 'cancelling')
      await this.session.transition({
        kind: 'stopSettled',
        blocker: control.status === 'pausing' ? control.stopCause : null,
      });
  }
}
