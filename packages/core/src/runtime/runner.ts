import { createHash, randomUUID } from 'node:crypto';
import type { ActionRegistry } from '#internal/action/registry';
import type {
  AgentOptions,
  ModelStage,
  RunHandle,
  ResumeRun,
} from '#internal/contracts/runtime';
import type { CallControl, PlannerRequest } from '#internal/contracts/adapters';
import type { JsonValue } from '#internal/contracts/json';
import type {
  GoalAssessment,
  GoalGraphSnapshot,
  GoalRecord,
} from '#internal/contracts/goal';
import type { PlanningTrigger } from '#internal/contracts/planning';
import type { ApplicationEvent } from '#internal/contracts/event';
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
import { parseApplicationEvent } from '#internal/validation/event';
import { captureDecisionRequest } from '#internal/candidate/context';
import { ActionCoordinator } from './execution.js';
import { invokeModel } from './model.js';
import type { RunSession } from './session.js';
import { selectionBasis } from './scheduling.js';
import { assessProgress } from './progress.js';
import { prepareResume } from './resume.js';
import {
  assertAssessmentEvidence,
  focusGoal,
  nextPlannedGoal,
  preparePlan,
} from './goals.js';

const validation = { code: 'INVALID_RUN_CONTROL', stage: 'run_loop' } as const;
class CallStopped extends Error {}
type CallbackStage =
  ModelStage | 'support' | 'observation' | 'checking' | 'filtering';

/** One asynchronous loop per run; control admission never waits for this loop. */
export class RunDriver<TCriteria extends JsonValue> {
  readonly execution: ActionCoordinator;
  #task: Promise<void> | null = null;
  readonly #criteria = new Map<string, TCriteria>();
  readonly #events = new Map<
    string,
    { fingerprint: string; committed: Promise<void> }
  >();
  #decisionController = new AbortController();
  #refresh = false;
  #progressAttempt: { before: GoalGraphSnapshot; failed: boolean } | null =
    null;
  #resumeController: AbortController | null = null;

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

  get restoring(): boolean {
    return this.#resumeController !== null;
  }

  start(): void {
    if (this.#task !== null) return;
    this.#task = this.run().finally(() => {
      this.#task = null;
      if (
        this.#refresh &&
        this.session.state.control.status === 'running' &&
        this.session.failure === null
      )
        this.start();
    });
    void this.#task.catch(() => undefined);
  }

  async emit(input: ApplicationEvent): Promise<void> {
    const event = parseApplicationEvent(input);
    const session = this.session;
    if (event.runId !== session.runId)
      throw new ContractError(
        validation.code,
        validation.stage,
        '/runId',
        'cross_run_event',
      );
    const fingerprint = createHash('sha256')
      .update(canonicalJson(parseJsonValue(event, 'event')), 'utf8')
      .digest('hex');
    const previous = this.#events.get(event.eventId);
    if (previous !== undefined) {
      if (previous.fingerprint !== fingerprint)
        throw new ContractError(
          validation.code,
          validation.stage,
          '/eventId',
          'event_conflict',
        );
      return previous.committed;
    }
    const context = session.state.decision.context;
    const matches = (ref: { id: string; version: number }) =>
      context.graph.goals.some(
        (goal) =>
          goal.id === ref.id &&
          goal.version === ref.version &&
          (goal.lifecycle === 'pending' || goal.lifecycle === 'inProgress'),
      );
    const applicable =
      (event.currentGoalRef === null ||
        (event.currentGoalRef.id === context.graph.currentGoalRef.id &&
          event.currentGoalRef.version ===
            context.graph.currentGoalRef.version)) &&
      event.affectedGoalRefs.every(matches) &&
      (event.planRef === null ||
        canonicalJson({ ...event.planRef }) ===
          canonicalJson(
            context.planRef === null ? null : { ...context.planRef },
          )) &&
      (event.executionId === null ||
        event.executionId === session.state.execution?.intent.executionId);
    const active = session.state.control.status === 'running';
    const invalidates =
      applicable &&
      active &&
      (event.impact !== 'observation' || event.control === 'interruptAction');
    const decision = captureDecisionRequest({
      ...session.state.decision,
      decisionEpoch:
        session.state.decision.decisionEpoch + (invalidates ? 1 : 0),
      context: {
        ...context,
        recentEvents: [...context.recentEvents, event].slice(-50),
      },
    });
    const scheduling = invalidates
      ? {
          ...session.state.scheduling,
          planning:
            event.impact === 'plan'
              ? { kind: 'planInvalidated' as const, eventId: event.eventId }
              : session.state.scheduling.planning,
          selectionCause: 'candidates_changed' as const,
        }
      : session.state.scheduling;
    const committed = session.commit(
      { ...session.state, decision, scheduling },
      [
        {
          formatVersion: 1,
          runId: session.runId,
          eventId: event.eventId,
          kind: 'applicationEvent',
          data: event,
        },
        session.event(
          'event_scheduled',
          !applicable
            ? 'stale_event'
            : invalidates
              ? 'decision_invalidated'
              : 'observation_recorded',
          {
            sourceEventId: event.eventId,
            impact: event.impact,
            timing: event.timing,
            affectedGoalRefs: event.affectedGoalRefs.map((ref) => ({ ...ref })),
          },
        ),
      ],
    );
    this.#events.set(event.eventId, { fingerprint, committed });
    if (invalidates) {
      this.#refresh = true;
      this.#decisionController.abort();
      this.#decisionController = new AbortController();
    }
    let controlCommit: Promise<void> | undefined;
    if (applicable && event.control !== 'none') {
      const cause = { eventId: event.eventId, reasonCode: event.reasonCode };
      if (event.control === 'pauseRun' || event.control === 'cancelRun') {
        this.#resumeController?.abort();
        controlCommit = session.transition({
          kind: event.control === 'pauseRun' ? 'pause' : 'cancel',
          cause,
        });
      } else if (session.state.execution !== null)
        this.execution.interrupt(
          session.state.execution.intent.executionId,
          cause,
        );
    }
    await committed;
    await controlCommit;
    if (this.#task === null) {
      if (active && invalidates) this.start();
      else await this.settleStop();
    }
  }

  async stop(kind: 'pause' | 'cancel', reasonCode: string): Promise<void> {
    this.#resumeController?.abort();
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

  async reconcile() {
    return this.execution.reconcile({
      signal: new AbortController().signal,
      deadlineAt: new Date(
        Date.now() + this.session.state.limits.verificationTimeoutMs,
      ).toISOString(),
    });
  }

  async resume(input: ResumeRun = {}): Promise<RunHandle> {
    const session = this.session;
    if (this.restoring || session.state.control.status !== 'paused')
      throw new ContractError(
        validation.code,
        'resume',
        '/status',
        'resume_unavailable',
      );
    const controller = new AbortController();
    const update = parseJsonValue(input, 'resume');
    this.#resumeController = controller;
    try {
      await this.#task;
      const record = session.event('resume_updated', 'application_resume', {
        update,
      });
      let next = prepareResume(session.state, update, record.eventId);
      const epoch = session.state.decision.decisionEpoch;
      const root = next.decision.context.graph.goals.find(
        (goal) => goal.kind === 'root',
      )!;
      let criteria: TCriteria | undefined;
      const control = {
        signal: controller.signal,
        deadlineAt: new Date(
          Date.now() + session.state.limits.verificationTimeoutMs,
        ).toISOString(),
      };
      if (root.version !== session.state.control.rootGoalRef.version) {
        const supported = await invokeControlled(
          captureControl(control),
          (control) => this.options.verifier.support(root.criteria, control),
        );
        if (supported.outcome !== 'returned')
          throw new ContractError(
            validation.code,
            'resume',
            '/goal',
            `support_${supported.outcome}`,
          );
        criteria = this.decodeSupport(supported.value);
      }
      if (session.hasExecution) await this.execution.reconcile(control);
      if (session.hasExecution)
        throw new ContractError(
          validation.code,
          'resume',
          '/execution',
          'execution_unsettled',
        );
      if (
        controller.signal.aborted ||
        session.state.control.status !== 'paused' ||
        session.state.decision.decisionEpoch !== epoch
      )
        throw new ContractError(
          validation.code,
          'resume',
          '',
          'resume_invalidated',
        );
      // Reconciliation and event delivery may have added records while validation was pending.
      next = prepareResume(session.state, update, record.eventId);
      await session.commit(next, [record]);
      if (
        controller.signal.aborted ||
        session.state.control.status !== 'paused'
      )
        throw new ContractError(
          validation.code,
          'resume',
          '',
          'resume_invalidated',
        );
      if (criteria !== undefined) {
        this.#criteria.clear();
        this.#criteria.set(`${root.id}:${root.version}`, criteria);
      }
      this.#progressAttempt = null;
      await session.transition({ kind: 'resume' });
      const handle = this.handle();
      this.start();
      return handle;
    } finally {
      this.#resumeController = null;
    }
  }

  private control(stage: CallbackStage): CallControl {
    const limits = this.session.state.limits;
    return {
      signal: AbortSignal.any([
        this.session.signal,
        this.#decisionController.signal,
      ]),
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

  private async support(goal: GoalRecord): Promise<TCriteria> {
    const result = await this.call('support', (control) =>
      this.options.verifier.support(goal.criteria, control),
    );
    return this.decodeSupport(result);
  }

  private decodeSupport(result: unknown): TCriteria {
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
      throw new ContractError(
        validation.code,
        validation.stage,
        '/support',
        requireString(raw.reason, validation, '/support/reason'),
      );
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
    return raw.criteria as TCriteria;
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

  private async verifyGoal(goal: GoalRecord): Promise<GoalAssessment> {
    const session = this.session;
    const context = session.state.decision.context;
    const key = `${goal.id}:${goal.version}`;
    const criteria = this.#criteria.get(key) ?? (await this.support(goal));
    this.#criteria.set(key, criteria);
    const result = await this.call('verification', (control) =>
      this.options.verifier.verify(
        {
          goal,
          criteria,
          context,
          actionResults: session.state.recentResults,
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
    assertAssessmentEvidence(assessment, context);
    const closed = new Set<string>();
    if (assessment.outcome === 'passed') {
      closed.add(goal.id);
      for (let size = -1; size !== closed.size;) {
        size = closed.size;
        for (const item of context.graph.goals)
          if (item.kind === 'child' && closed.has(item.parentGoalRef.id))
            closed.add(item.id);
      }
    }
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
          : closed.has(item.id) &&
              (item.lifecycle === 'pending' || item.lifecycle === 'inProgress')
            ? { ...item, lifecycle: 'cancelled' }
            : item,
      ),
    });
    const decision = {
      ...session.state.decision,
      context: { ...session.state.decision.context, graph },
    };
    const epoch = session.state.decision.decisionEpoch;
    await session.commit(
      {
        ...session.state,
        decision,
        progress:
          goal.kind === 'root' && assessment.outcome === 'passed'
            ? assessProgress(
                session.state.progress,
                context.graph,
                graph,
                'baseline',
                false,
              )
            : session.state.progress,
        scheduling:
          closed.size === 0
            ? session.state.scheduling
            : { ...session.state.scheduling, recoveryAttempts: 0 },
        goals: {
          ...session.state.goals,
          order: session.state.goals.order.filter((ref) => !closed.has(ref.id)),
        },
      },
      [
        {
          formatVersion: 1,
          runId: session.runId,
          eventId: randomUUID(),
          kind: 'goalAssessment',
          data: assessment,
        },
      ],
    );
    if (!session.canDispatch(epoch)) throw new CallStopped();
    if (assessment.outcome === 'needsInput') {
      await this.block(assessment.reason);
      throw new CallStopped();
    }
    if (assessment.outcome === 'passed' && goal.kind === 'root')
      await session.transition({
        kind: 'succeed',
        assessment,
        observationRef: assessment.observationRef,
      });
    return assessment;
  }

  private async verify(): Promise<void> {
    const session = this.session;
    const path = [...session.state.decision.context.graph.goalPath].reverse();
    for (const ref of path) {
      const goal = session.state.decision.context.graph.goals.find(
        (item) => item.id === ref.id,
      )!;
      await this.verifyGoal(goal);
      if (session.state.control.status !== 'running') return;
    }
    const attempt = this.#progressAttempt;
    this.#progressAttempt = null;
    await this.recordProgress(
      attempt?.before ?? session.state.decision.context.graph,
      attempt === null ? 'baseline' : 'action',
      attempt?.failed ?? false,
    );
    const graph = session.state.decision.context.graph;
    const current = graph.goals.find(
      (goal) => goal.id === graph.currentGoalRef.id,
    )!;
    if (current.lifecycle === 'pending' || current.lifecycle === 'inProgress')
      return;
    const planned = nextPlannedGoal(graph, session.state.goals.order);
    const fallback = path
      .map((ref) => graph.goals.find((goal) => goal.id === ref.id)!)
      .find(
        (goal) =>
          goal.lifecycle === 'pending' || goal.lifecycle === 'inProgress',
      )!;
    const next = planned ?? { id: fallback.id, version: fallback.version };
    const focused = focusGoal(graph, next);
    const decision = captureDecisionRequest({
      requestId: randomUUID(),
      decisionEpoch: session.state.decision.decisionEpoch + 1,
      context: { ...session.state.decision.context, graph: focused },
    });
    await session.commit(
      {
        ...session.state,
        decision,
        goals: {
          ...session.state.goals,
          order: session.state.goals.order.filter(
            (ref) =>
              !focused.goalPath.some((ancestor) => ancestor.id === ref.id),
          ),
        },
        scheduling: {
          ...session.state.scheduling,
          planning:
            planned === null
              ? { kind: 'branchExhausted', goalRef: next }
              : session.state.scheduling.planning,
          lastSelectionBasis: null,
          selectionCause: 'candidates_changed',
        },
      },
      [
        session.event(
          'goal_advanced',
          planned === null ? 'branch_exhausted' : 'accepted_order',
          { nextGoalRef: { ...next } },
        ),
      ],
    );
    if (planned !== null) await this.verify();
  }

  private async recordProgress(
    before: GoalGraphSnapshot,
    attempt: 'baseline' | 'action' | 'planning',
    failed: boolean,
  ): Promise<void> {
    const session = this.session;
    let progress = assessProgress(
      session.state.progress,
      before,
      session.state.decision.context.graph,
      attempt,
      failed,
    );
    const blocked = progress.find(
      (item) => item.noProgress >= session.state.limits.maxNoProgress,
    );
    const recovery = [...session.state.decision.context.graph.goalPath]
      .reverse()
      .flatMap((ref) => progress.filter((item) => item.goalRef.id === ref.id))
      .find(
        (item) =>
          !item.recoveryPlanned &&
          item.recoveryAttempts >= session.state.limits.maxRecoveryAttempts,
      );
    if (recovery && !blocked)
      progress = progress.map((item) =>
        item.recoveryAttempts >= session.state.limits.maxRecoveryAttempts
          ? { ...item, recoveryPlanned: true }
          : item,
      );
    const epoch = session.state.decision.decisionEpoch;
    await session.commit(
      {
        ...session.state,
        progress,
        scheduling:
          recovery && !blocked
            ? {
                ...session.state.scheduling,
                planning: {
                  kind: 'recoveryExhausted',
                  goalRef: recovery.goalRef,
                  failures: recovery.recoveryAttempts,
                },
              }
            : session.state.scheduling,
      },
      [
        session.event('progress_assessed', attempt, {
          progress: parseJsonValue(progress, 'progress'),
        }),
      ],
    );
    if (!session.canDispatch(epoch)) throw new CallStopped();
    if (blocked) {
      await this.block('no_progress');
      throw new CallStopped();
    }
  }

  private async plan(trigger: PlanningTrigger): Promise<void> {
    const session = this.session;
    const request: PlannerRequest = Object.freeze({
      ...session.state.decision,
      requestId: randomUUID(),
      capabilities: this.registry.capabilities,
      trigger,
      pendingGoals: session.state.goals.pending,
    });
    const proposal = parsePlanProposal(
      await this.call(
        'planning',
        (control) => this.options.planner.plan(request, control),
        request.requestId,
      ),
      request,
      {
        maxDepth: session.state.limits.maxGoalDepth + 1,
        maxNewGoals: Math.max(1, session.state.limits.maxSubgoals),
        maxTotalGoals: session.state.limits.maxSubgoals + 1,
      },
    );
    if (proposal.outcome === 'blocked') {
      await this.block(proposal.reason);
      throw new CallStopped();
    }
    if (proposal.outcome === 'claimComplete') {
      await session.commit(
        {
          ...session.state,
          scheduling: { ...session.state.scheduling, planning: null },
        },
        [
          session.event('completion_claimed', 'planner_claim', {
            goalRef: { ...proposal.goalRef },
          }),
        ],
      );
      await this.observe();
      await this.verify();
      if (
        session.state.decision.context.graph.goals.find(
          (goal) => goal.id === proposal.goalRef.id,
        )?.lastAssessment?.outcome !== 'passed'
      ) {
        await this.block('completion_not_verified');
        throw new CallStopped();
      }
      return;
    }
    const current = session.state.decision.context;
    const planRef = Object.freeze({
      id: current.planRef?.id ?? randomUUID(),
      version: (current.planRef?.version ?? 0) + 1,
      rootGoalVersion: current.graph.rootGoalRef.version,
    });
    const prepared = preparePlan(
      current.graph,
      session.state.goals,
      proposal,
      planRef,
      session.state.limits.maxSubgoals,
    );
    const supported = new Map<string, TCriteria>();
    for (const goal of prepared.changed)
      supported.set(`${goal.id}:${goal.version}`, await this.support(goal));
    if (!session.canDispatch(request.decisionEpoch)) throw new CallStopped();
    const decision = captureDecisionRequest({
      requestId: randomUUID(),
      decisionEpoch: session.state.decision.decisionEpoch + 1,
      context: {
        ...session.state.decision.context,
        graph: prepared.graph,
        planRef,
        planGuidance: proposal.guidance,
      },
    });
    await session.commit(
      {
        ...session.state,
        decision,
        goals: prepared.state,
        scheduling: {
          ...session.state.scheduling,
          planning:
            session.state.scheduling.planning === trigger
              ? null
              : session.state.scheduling.planning,
        },
      },
      [
        session.event('plan_accepted', trigger.kind, {
          requestId: request.requestId,
          planRef: { ...planRef },
          proposal: parseJsonValue(proposal, 'planning'),
        }),
      ],
    );
    for (const [key, criteria] of supported) this.#criteria.set(key, criteria);
    const liveCriteria = new Set(
      prepared.graph.goals
        .filter(
          (goal) =>
            goal.lifecycle === 'pending' || goal.lifecycle === 'inProgress',
        )
        .map((goal) => `${goal.id}:${goal.version}`),
    );
    for (const key of this.#criteria.keys())
      if (!liveCriteria.has(key)) this.#criteria.delete(key);
    if (!session.canDispatch(decision.decisionEpoch)) throw new CallStopped();
    if (
      prepared.changed.length > 0 ||
      current.graph.currentGoalRef.id !== prepared.graph.currentGoalRef.id
    ) {
      await this.verify();
      if (
        session.state.control.status === 'running' &&
        session.state.scheduling.planning !== null
      )
        await this.recordProgress(current.graph, 'planning', false);
    }
  }

  private async run(): Promise<void> {
    const session = this.session;
    try {
      this.#refresh = false;
      await this.observe();
      await this.verify();
      while (session.state.control.status === 'running') {
        if (this.#refresh) {
          this.#refresh = false;
          await this.observe();
          await this.verify();
        }
        if (session.state.control.status !== 'running') break;
        const planning = session.state.scheduling.planning;
        if (planning !== null) await this.plan(planning);
        if (
          this.#refresh ||
          session.state.control.status !== 'running' ||
          session.state.scheduling.planning !== null
        )
          continue;
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
        if (!session.canDispatch(input.decisionEpoch)) {
          if (this.#refresh) continue;
          break;
        }
        if (prepared.outcome !== 'prepared') {
          if (session.state.control.status === 'running')
            await this.block(`candidates_${prepared.outcome}`);
          break;
        }
        const checked = await checkCandidates(
          prepared.prepared,
          this.control('checking'),
        );
        if (!session.canDispatch(input.decisionEpoch)) {
          if (this.#refresh) continue;
          break;
        }
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
        if (!session.canDispatch(input.decisionEpoch)) {
          if (this.#refresh) continue;
          break;
        }
        if (filtered.outcome !== 'filtered') {
          if (session.state.control.status === 'running')
            await this.block(`filtering_${filtered.outcome}`);
          break;
        }
        const basis = selectionBasis(
          session.state.decision.context,
          filtered.filtered.set,
        );
        await session.commit(session.state, [
          session.event('candidates_processed', 'candidates_ready', {
            requestId: input.requestId,
            generation: parseJsonValue(prepared.prepared.report, 'generation'),
            checking: parseJsonValue(checked.checked.report, 'checking'),
            filtering: parseJsonValue(filtered.filtered.report, 'filtering'),
            candidates: parseJsonValue(filtered.filtered.set, 'candidates'),
          }),
        ]);
        if (!session.canDispatch(input.decisionEpoch)) continue;
        const scheduling = session.state.scheduling;
        if (
          basis === scheduling.lastSelectionBasis &&
          scheduling.selectionCause !== 'action_completed' &&
          scheduling.selectionCause !== 'resumed'
        ) {
          await this.block('decision_basis_unchanged');
          break;
        }
        await session.commit(session.state, [
          session.event('selection_requested', scheduling.selectionCause, {
            requestId: input.requestId,
            decisionEpoch: input.decisionEpoch,
          }),
        ]);
        if (!session.canDispatch(input.decisionEpoch)) continue;
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
        if (!session.canDispatch(input.decisionEpoch)) {
          if (this.#refresh) continue;
          break;
        }
        await session.commit(
          {
            ...session.state,
            scheduling: {
              ...session.state.scheduling,
              lastSelectionBasis: basis,
            },
          },
          [
            session.event('selection_finished', selected.outcome, {
              requestId: input.requestId,
              ...(selected.outcome === 'selected' ||
              selected.outcome === 'abstain'
                ? { selection: parseJsonValue(selected.selection, 'selection') }
                : {}),
            }),
          ],
        );
        if (!session.canDispatch(input.decisionEpoch)) continue;
        if (selected.outcome !== 'selected') {
          if (
            (selected.outcome === 'no_candidates' ||
              selected.outcome === 'abstain') &&
            session.state.scheduling.recoveryAttempts === 0
          ) {
            await session.commit(
              {
                ...session.state,
                scheduling: {
                  ...session.state.scheduling,
                  recoveryAttempts: 1,
                  selectionCause: 'remedy',
                  planning: {
                    kind: 'recoveryExhausted',
                    goalRef:
                      session.state.decision.context.graph.currentGoalRef,
                    failures: 1,
                  },
                },
              },
              [
                session.event('decision_remedy', selected.outcome, {
                  requestId: input.requestId,
                }),
              ],
            );
            await this.observe();
            await this.verify();
            continue;
          }
          if (session.state.control.status === 'running')
            await this.block(`selection_${selected.outcome}`);
          break;
        }
        const before = session.state.decision.context.graph;
        const result = await this.execution.execute(selected);
        if (session.state.control.status !== 'running') break;
        if (result.outcome !== 'recorded') {
          if (this.#refresh) continue;
          await this.block(result.reasonCode);
          break;
        }
        await session.commit(
          {
            ...session.state,
            scheduling: {
              ...session.state.scheduling,
              selectionCause: 'action_completed',
            },
          },
          [],
        );
        this.#progressAttempt = {
          before,
          failed: result.result.outcome !== 'succeeded',
        };
        if (this.#refresh) continue;
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
    if (
      this.session.hasExecution &&
      this.session.state.execution?.phase !== 'unknown'
    )
      return;
    const control = this.session.state.control;
    if (control.status === 'pausing' || control.status === 'cancelling')
      await this.session.transition({
        kind: 'stopSettled',
        blocker: control.status === 'pausing' ? control.stopCause : null,
      });
  }
}
