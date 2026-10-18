import { createHash, randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { scheduler } from 'node:timers/promises';
import type { IntervalHistogram } from 'node:perf_hooks';
import type { ActionRegistry } from '#internal/action/registry';
import type {
  AgentOptions,
  RunHandle,
  ResumeRun,
} from '#internal/contracts/runtime';
import type { CallControl } from '#internal/contracts/control';
import type {
  PlannerRequest,
  PlanningTrigger,
  PendingPlanProposal,
} from '#internal/planner/contracts';
import type {
  ControlDecision,
  DecisionOption,
  ExecutionDisposition,
} from '#internal/contracts/decision';
import type { ActionResult } from '#internal/contracts/record';
import type {
  CandidateSelectionResult,
  CandidateGenerationInput,
  SelectedCandidate,
  FilteredCandidates,
} from '#internal/contracts/candidate-processing';
import type { ChoiceHistoryEntry } from '#internal/contracts/choice-history';
import type { OperationSet } from '#internal/contracts/operation';
import type { JsonValue } from '#internal/contracts/json';
import type {
  GoalAssessment,
  GoalGraphSnapshot,
  GoalRecord,
} from '#internal/contracts/goal';
import type { ApplicationEvent } from '#internal/contracts/event';
import type {
  ChangeBatch,
  RecordedChange,
  RecordedChangeBatch,
} from '#internal/contracts/changes';
import type { Observation } from '#internal/contracts/observation';
import { prepareCandidates } from '#internal/candidate/prepare';
import { checkCandidatesWithInvocation } from '#internal/candidate/check';
import { filterCandidates } from '#internal/candidate/filter';
import { selectCandidates } from '#internal/selector/select';
import {
  beginSelection,
  acceptSelectionBatch,
} from '#internal/selector/cursor';
import { createDecisionRequest } from '#internal/decision/request';
import { selectDecision } from '#internal/decision/validation';
import {
  createOperationRequest,
  parseOperationSet,
  createOperationBindingRequest,
  parseBoundCandidates,
} from '#internal/candidate/operations';
import { canonicalJson } from '#internal/candidate/identity';
import { ContractError } from '#internal/errors';
import { requireObject, requireString } from '#internal/validation/fields';
import { parseJsonValue } from '#internal/validation/json';
import { parseObservation } from '#internal/validation/observation';
import { parseGoalGraph } from '#internal/validation/goal';
import { parsePlanProposal } from '#internal/planner/validation';
import { readGoalAssessment } from '#internal/validation/assessment';
import { parseApplicationEvent } from '#internal/validation/event';
import { captureDecisionRequest } from '#internal/candidate/context';
import { ActionCoordinator } from './execution.js';
import { ModelRequestError } from './model.js';
import { captureObservation } from './observation.js';
import { captureCallback } from './callback-receipt.js';
import { invokeRole } from './role-callback.js';
import type { RoleStage } from './role-callback.js';
import { SelectionLifecycle } from './selection-lifecycle.js';
import {
  describeHistoricalCandidate,
  describeSelectionResult,
} from './choice-history.js';
import type { SelectionBatch } from './selection-lifecycle.js';
import type { PendingPlanAdoption, RunSession } from './session.js';
import {
  acceptDecision,
  acceptStoppedPlan,
  decisionApplies,
  proposalApplies,
  rejectDecision,
  stopAdoptionApplies,
} from './decision-acceptance.js';
import type { PreparedPlan } from './decision-acceptance.js';
import type { RunRecordDraft } from '#internal/storage/contracts';
import { requestPlanning, requestReview } from './scheduling.js';
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

interface PlanAdoption<TCriteria extends JsonValue> extends PreparedPlan {
  readonly criteria: Map<string, TCriteria>;
  readonly before: GoalGraphSnapshot;
  readonly verifyGoals: boolean;
}

/** One asynchronous loop per run; control admission never waits for this loop. */
export class RunDriver<TCriteria extends JsonValue> {
  readonly execution: ActionCoordinator;
  #task: Promise<void> | null = null;
  readonly #criteria = new Map<string, TCriteria>();
  readonly #pendingEventReceipts = new Map<
    string,
    { fingerprint: string; committed: Promise<void> }
  >();
  #decisionController = new AbortController();
  #refresh = false;
  #resumeController: AbortController | null = null;
  #pendingEvents = 0;
  #loopDelay: IntervalHistogram | null = null;
  readonly #callbacks = new Map<Promise<unknown>, RoleStage>();
  #plannerTask: Promise<void> | null = null;
  #executionTask: Promise<void> | null = null;
  readonly #selection = new SelectionLifecycle();
  #verifyPending = false;
  #wake: (() => void) | null = null;
  #reviewTimer: ReturnType<typeof setTimeout> | null = null;

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
    const result = this.session.result.then(async (control) => {
      const snapshot = Object.freeze({
        ...control,
        runId: this.session.runId,
        execution: this.session.committedState.execution,
      });
      await this.#task;
      return snapshot;
    });
    void result.catch(() => undefined);
    return Object.freeze({ runId: this.session.runId, result });
  }

  get restoring(): boolean {
    return this.#resumeController !== null;
  }

  get hasPendingEvents(): boolean {
    return this.#pendingEvents !== 0;
  }

  async publish(batch: ChangeBatch): Promise<void> {
    this.#pendingEvents++;
    try {
      await this.session.publishChanges(batch);
    } finally {
      this.#pendingEvents--;
    }
  }

  start(): void {
    if (this.#task !== null) return;
    this.#loopDelay = monitorEventLoopDelay({ resolution: 20 });
    this.#loopDelay.enable();
    this.#task = this.run().finally(() => {
      this.#loopDelay?.disable();
      this.#loopDelay = null;
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
    const previous = this.#pendingEventReceipts.get(event.eventId);
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
    this.#pendingEvents++;
    const committed = this.acceptEvent(event);
    this.#pendingEventReceipts.set(event.eventId, { fingerprint, committed });
    try {
      await committed;
    } finally {
      this.#pendingEvents--;
      this.#pendingEventReceipts.delete(event.eventId);
    }
  }

  private async acceptEvent(event: ApplicationEvent): Promise<void> {
    const session = this.session;
    const receivedAt = new Date().toISOString();
    // Deduplication precedes admission: a repeated stop event must not stop a
    // resumed run. Recompute applicability after the asynchronous history read.
    const previous = await this.options.store.readRecord(
      session.runId,
      event.eventId,
    );
    if (previous !== null) {
      if (
        previous.kind !== 'applicationEvent' ||
        canonicalJson(parseJsonValue(previous.data, 'event')) !==
          canonicalJson(parseJsonValue(event, 'event'))
      )
        throw new ContractError(
          validation.code,
          validation.stage,
          '/eventId',
          'event_conflict',
        );
      return;
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
    // Resume must observe invalidations received on either side of the pause boundary.
    const invalidates =
      applicable &&
      (active ||
        session.state.control.status === 'pausing' ||
        session.state.control.status === 'paused') &&
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
    const observationOnly =
      event.impact === 'observation' && event.control === 'none';
    const requestsReview = observationOnly || invalidates;
    const eventSequence =
      session.state.observations.eventSequence + (observationOnly ? 1 : 0);
    const reviewVersion =
      session.state.scheduling.reviewVersion + (requestsReview ? 1 : 0);
    if (
      !Number.isSafeInteger(eventSequence) ||
      !Number.isSafeInteger(reviewVersion)
    )
      throw new ContractError(
        validation.code,
        validation.stage,
        '/sequence',
        'sequence_exhausted',
      );
    const changes: readonly RecordedChange[] = observationOnly
      ? [
          {
            sourceEvent: event.type,
            occurredAt: event.observedAt,
            data: parseJsonValue(event, 'event'),
            sourceEventId: event.eventId,
            ...(event.executionId === null
              ? {}
              : { executionId: event.executionId }),
            sequence: eventSequence,
            batchId: event.eventId,
            source: `application:${event.source.id}`,
            receivedAt,
          },
        ]
      : [];
    let scheduling =
      invalidates && event.impact === 'plan'
        ? requestPlanning(session.state.scheduling, {
            kind: 'planInvalidated',
            eventId: event.eventId,
          })
        : session.state.scheduling;
    if (requestsReview)
      scheduling = { ...scheduling, reviewPending: true, reviewVersion };
    const records: RunRecordDraft[] = [
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
    ];
    if (observationOnly) {
      const batch: RecordedChangeBatch = {
        id: event.eventId,
        runId: session.runId,
        source: `application:${event.source.id}`,
        receivedAt,
        changes,
      };
      records.push(
        session.event('observation_changes', 'facts_received', {
          batch: parseJsonValue(batch, 'change_batch'),
        }),
      );
    }
    const state = {
      ...session.state,
      decision,
      scheduling,
      pendingProposal:
        invalidates && event.impact === 'plan'
          ? null
          : session.state.pendingProposal,
      pendingAdoption: invalidates ? null : session.state.pendingAdoption,
      observations: observationOnly
        ? {
            ...session.state.observations,
            eventSequence,
            unreadChanges: [
              ...session.state.observations.unreadChanges,
              ...changes,
            ],
          }
        : session.state.observations,
    };
    if (invalidates && session.state.pendingAdoption !== null)
      records.push(
        session.event('plan_adoption_discarded', 'decision_invalidated', {
          proposalId: session.state.pendingAdoption.proposalId,
          executionId: session.state.pendingAdoption.executionId,
          decisionRequestId: session.state.pendingAdoption.decisionRequestId,
          decisionEventId: session.state.pendingAdoption.decisionEventId,
        }),
      );
    if (
      invalidates &&
      event.impact === 'plan' &&
      session.state.pendingProposal !== null
    )
      records.push(
        session.event('proposal_discarded', 'plan_invalidated', {
          proposalId: session.state.pendingProposal.proposalId,
        }),
      );
    const controlsRun =
      applicable &&
      (event.control === 'pauseRun' || event.control === 'cancelRun');
    const committed = controlsRun
      ? session.transition(
          {
            kind: event.control === 'pauseRun' ? 'pause' : 'cancel',
            cause: { eventId: event.eventId, reasonCode: event.reasonCode },
          },
          records,
          state,
        )
      : session.commit(state, records);
    if (invalidates) {
      this.#refresh = true;
      this.#decisionController.abort();
      this.#decisionController = new AbortController();
    }
    if (applicable && event.control !== 'none') {
      const cause = { eventId: event.eventId, reasonCode: event.reasonCode };
      if (event.control === 'pauseRun' || event.control === 'cancelRun') {
        this.#resumeController?.abort();
      } else if (session.state.execution !== null)
        this.execution.interrupt(
          session.state.execution.intent.executionId,
          cause,
        );
    }
    await committed;
    if (this.#task === null) {
      if (active && requestsReview) this.start();
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
    await this.session.transition(
      {
        kind,
        cause: { eventId: record.eventId, reasonCode },
      },
      [record],
    );
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
        const current = () =>
          this.#resumeController === controller &&
          !controller.signal.aborted &&
          !session.ownershipSignal.aborted &&
          session.failure === null &&
          session.state.control.status === 'paused' &&
          session.state.decision.decisionEpoch === epoch;
        const supported = await captureCallback(
          session,
          {
            stage: 'support',
            phase: 'resume',
            decisionEpoch: epoch,
            input: root.criteria,
          },
          {
            ...control,
            signal: AbortSignal.any([
              controller.signal,
              session.ownershipSignal,
            ]),
          },
          current,
          (control) => this.options.verifier.support(root.criteria, control),
        );
        if (supported.outcome !== 'returned')
          throw new ContractError(
            validation.code,
            'resume',
            '/goal',
            `support_${supported.outcome}`,
          );
        if (!current())
          throw new ContractError(
            validation.code,
            'resume',
            '/goal',
            'resume_invalidated',
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
      let initialObservation: Observation | undefined;
      if (!session.state.observations.initialized) {
        const observed = await captureObservation(
          session,
          this.options.environment.observe,
          null,
          {
            ...control,
            signal: AbortSignal.any([
              controller.signal,
              session.ownershipSignal,
            ]),
          },
        );
        if (observed.outcome !== 'returned')
          throw new ContractError(
            validation.code,
            'resume',
            '/observation',
            `initial_observation_${observed.outcome}`,
          );
        initialObservation = parseObservation(observed.value);
        if (initialObservation.runId !== session.runId)
          throw new ContractError(
            validation.code,
            'resume',
            '/observation/runId',
            'cross_run_observation',
          );
      }
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
      if (initialObservation !== undefined)
        next = {
          ...next,
          observations: { ...next.observations, initialized: true },
          decision: {
            ...next.decision,
            context: {
              ...next.decision.context,
              observation: initialObservation,
            },
          },
        };
      if (criteria !== undefined) {
        this.#criteria.clear();
        this.#criteria.set(`${root.id}:${root.version}`, criteria);
      }
      await session.transition(
        { kind: 'resume' },
        [
          record,
          ...(initialObservation === undefined
            ? []
            : [
                session.event('observation_accepted', 'initial_observation', {
                  observation: parseJsonValue(
                    initialObservation,
                    'observation',
                  ),
                }),
              ]),
        ],
        next,
      );
      if (
        controller.signal.aborted ||
        !session.canDispatch(session.state.decision.decisionEpoch)
      )
        throw new ContractError(
          validation.code,
          'resume',
          '',
          'resume_invalidated',
        );
      const handle = this.handle();
      this.start();
      return handle;
    } finally {
      this.#resumeController = null;
    }
  }

  private control(stage: RoleStage): CallControl {
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
            : stage === 'decision' ||
                stage === 'planning' ||
                stage === 'selection'
              ? limits.modelTimeoutMs
              : limits.callbackTimeoutMs),
      ).toISOString(),
    };
  }

  private call<T>(
    stage: RoleStage,
    input: unknown,
    invoke: (control: CallControl) => Promise<T>,
    requestId: string = randomUUID(),
    control: CallControl = this.control(stage),
    retryAttempt?: number,
  ): Promise<T> {
    const session = this.session;
    const epoch = session.state.decision.decisionEpoch;
    const modelStage =
      stage === 'decision' ||
      stage === 'planning' ||
      stage === 'selection' ||
      stage === 'candidates' ||
      stage === 'verification'
        ? stage
        : null;
    const perRequest =
      stage === 'selection' &&
      this.options.selector.modelAccounting === 'perRequest';
    const model =
      modelStage !== null &&
      this.options.modelStages?.includes(modelStage) === true &&
      !perRequest;
    const modelIdentity =
      stage === 'decision'
        ? this.options.decisionPolicy.model
        : stage === 'planning'
          ? this.options.planner.model
          : stage === 'selection'
            ? this.options.selector.model
            : undefined;
    const request = {
      requestId,
      decisionEpoch: epoch,
      input,
      ...(retryAttempt === undefined ? {} : { retryAttempt }),
    };
    const pending = invokeRole(
      session,
      perRequest
        ? { ...request, stage: 'selection', accounting: 'perRequest' }
        : model
          ? {
              ...request,
              stage: modelStage,
              accounting: 'model',
              ...(modelIdentity === undefined ? {} : { model: modelIdentity }),
            }
          : { ...request, stage, accounting: 'local' },
      control,
      this.#loopDelay,
      invoke,
    ).then(async (result) => {
      if (!session.canDispatch(epoch) || result.outcome === 'interrupted')
        throw new CallStopped();
      if (result.outcome === 'failed') {
        if (result.retryError !== null) throw result.retryError;
        await this.block(result.reasonCode);
        throw new CallStopped();
      }
      return result.value;
    });
    this.#callbacks.set(pending, stage);
    // Pipeline timeouts may return before callback accounting has committed.
    // Track the bounded gateway, never the uncooperative underlying adapter.
    void pending
      .finally(() => this.#callbacks.delete(pending))
      .catch(() => undefined);
    return pending;
  }

  private async support(goal: GoalRecord): Promise<TCriteria> {
    const result = await this.call('support', goal, (control) =>
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
      await this.call('observation', context, (control) =>
        this.options.environment.observe.snapshot(context, control),
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
    const acceptedAt = Date.now();
    await session.replaceDecision(
      {
        ...session.state.decision,
        context: { ...session.state.decision.context, observation },
      },
      [
        session.event('observation_accepted', 'run_observation', {
          observationRef: {
            id: observation.id,
            revision: observation.revision,
          },
          observedAt: observation.observedAt,
          acceptedAt: new Date(acceptedAt).toISOString(),
          observationLagMs: acceptedAt - Date.parse(observation.observedAt),
        }),
      ],
    );
  }

  private async verifyGoal(goal: GoalRecord): Promise<GoalAssessment> {
    const session = this.session;
    const context = session.state.decision.context;
    const key = `${goal.id}:${goal.version}`;
    const criteria = this.#criteria.get(key) ?? (await this.support(goal));
    this.#criteria.set(key, criteria);
    const request = Object.freeze({
      goal,
      criteria,
      context,
      actionResults: session.state.recentResults,
    });
    const result = await this.call('verification', request, (control) =>
      this.options.verifier.verify(request, control),
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
                assessment.outcome === 'passed'
                  ? 'succeeded'
                  : context.graph.goalPath.some((ref) => ref.id === goal.id)
                    ? 'inProgress'
                    : item.lifecycle,
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
    const completed = goal.kind === 'root' && assessment.outcome === 'passed';
    const attempt = session.state.progressAttempt;
    const progress = completed
      ? assessProgress(
          session.state.progress,
          attempt?.before ?? context.graph,
          graph,
          attempt === null ? 'baseline' : 'action',
          attempt?.failed ?? false,
        )
      : session.state.progress;
    const epoch = session.state.decision.decisionEpoch;
    await session.commit(
      {
        ...session.state,
        decision,
        progress,
        progressAttempt: completed ? null : attempt,
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
        ...(completed && attempt !== null
          ? [
              session.event('progress_assessed', 'action', {
                executionId: attempt.executionId,
                progress: parseJsonValue(progress, 'progress'),
              }),
            ]
          : []),
        ...(closed.size === 0
          ? []
          : [
              session.event('goal_scope_closed', 'goal_passed', {
                goalRef: { id: goal.id, version: goal.version },
                cancelledGoalRefs: context.graph.goals
                  .filter(
                    (item) =>
                      item.id !== goal.id &&
                      closed.has(item.id) &&
                      (item.lifecycle === 'pending' ||
                        item.lifecycle === 'inProgress'),
                  )
                  .map((item) => ({ id: item.id, version: item.version })),
              }),
            ]),
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
    // Adoption may focus another branch while the retained action finishes.
    // Assess its surviving original goals before consuming that action's progress.
    const retained = [...(session.state.progressAttempt?.before.goalPath ?? [])]
      .reverse()
      .filter(
        (ref) =>
          !path.some((current) => current.id === ref.id) &&
          session.state.decision.context.graph.goals.some(
            (goal) =>
              goal.id === ref.id &&
              goal.version === ref.version &&
              (goal.lifecycle === 'pending' || goal.lifecycle === 'inProgress'),
          ),
      );
    for (const ref of [...retained, ...path]) {
      const goal = session.state.decision.context.graph.goals.find(
        (item) => item.id === ref.id && item.version === ref.version,
      );
      if (goal === undefined) continue;
      await this.verifyGoal(goal);
      if (session.state.control.status !== 'running') return;
    }
    const attempt = session.state.progressAttempt;
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
        scheduling:
          planned === null
            ? requestPlanning(session.state.scheduling, {
                kind: 'branchExhausted',
                goalRef: next,
              })
            : session.state.scheduling,
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
    const { maxNoProgress, maxRecoveryAttempts } = session.state.limits;
    const blocked = progress.find(
      (item) => maxNoProgress !== null && item.noProgress >= maxNoProgress,
    );
    const recovery = [...session.state.decision.context.graph.goalPath]
      .reverse()
      .flatMap((ref) => progress.filter((item) => item.goalRef.id === ref.id))
      .find(
        (item) =>
          !item.recoveryPlanned &&
          maxRecoveryAttempts !== null &&
          item.recoveryAttempts >= maxRecoveryAttempts,
      );
    if (recovery && !blocked)
      progress = progress.map((item) =>
        maxRecoveryAttempts !== null &&
        item.recoveryAttempts >= maxRecoveryAttempts
          ? { ...item, recoveryPlanned: true }
          : item,
      );
    const epoch = session.state.decision.decisionEpoch;
    // Consume the attempt with its counters so a pause cannot count it twice.
    await session.commit(
      {
        ...session.state,
        progress,
        progressAttempt:
          attempt === 'action' ? null : session.state.progressAttempt,
        scheduling:
          recovery && !blocked
            ? requestPlanning(session.state.scheduling, {
                kind: 'recoveryExhausted',
                goalRef: recovery.goalRef,
                failures: recovery.recoveryAttempts,
              })
            : session.state.scheduling,
      },
      [
        session.event('progress_assessed', attempt, {
          executionId:
            attempt === 'action'
              ? (session.state.progressAttempt?.executionId ?? null)
              : null,
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

  private clearReviewTimer(): void {
    if (this.#reviewTimer !== null) clearTimeout(this.#reviewTimer);
    this.#reviewTimer = null;
  }

  private scheduleReview(): void {
    this.clearReviewTimer();
    const interval = this.session.state.scheduling.reviewIntervalMs;
    if (interval === null || this.session.state.control.status !== 'running')
      return;
    this.#reviewTimer = setTimeout(() => {
      this.#reviewTimer = null;
      void this.session.markReview('review_interval').catch(() => undefined);
    }, interval);
  }

  /** Wakeups own no external work and end immediately on direct run controls. */
  private async waitForWake(until?: number): Promise<void> {
    const signal = this.session.signal;
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wake = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener('abort', wake);
        if (this.#wake === wake) this.#wake = null;
        resolve();
      };
      this.#wake = wake;
      signal.addEventListener('abort', wake, { once: true });
      if (until !== undefined)
        timer = setTimeout(wake, Math.max(0, until - Date.now()));
      if (signal.aborted) wake();
    });
  }

  private async drainLightCallbacks(): Promise<void> {
    await Promise.allSettled(
      [...this.#callbacks]
        .filter(([, stage]) => stage !== 'planning')
        .map(([pending]) => pending),
    );
  }

  private decisionOptions(
    operations: OperationSet,
  ): readonly ControlDecision[] {
    const state = this.session.state;
    const execution = this.execution.active;
    const pending = state.pendingProposal;
    const selection = this.#selection.snapshot()?.summary ?? null;
    type Undisposed =
      | { kind: 'continueAction' | 'stopAction'; executionId: string }
      | { kind: 'continueSelection'; selectionId: string }
      | { kind: 'wait' | 'abstain' }
      | { kind: 'selectOperation'; operationId: string }
      | {
          kind: 'replan';
          execution:
            { kind: 'none' } | { kind: 'keep' | 'stop'; executionId: string };
        };
    const choices: Undisposed[] = [];
    if (execution !== null && execution.stopCause === null) {
      choices.push({
        kind: 'continueAction',
        executionId: execution.intent.executionId,
      });
      choices.push({
        kind: 'stopAction',
        executionId: execution.intent.executionId,
      });
    }
    if (selection !== null)
      choices.push({
        kind: 'continueSelection',
        selectionId: selection.selectionId,
      });
    if (execution === null && selection === null)
      choices.push({ kind: 'wait' });
    if (state.decision.context.planRef !== null)
      for (const operation of operations.operations)
        if (operation.availability.status === 'available')
          choices.push({
            kind: 'selectOperation',
            operationId: operation.operationId,
          });
    if (this.#plannerTask === null) {
      if (execution === null)
        choices.push({ kind: 'replan', execution: { kind: 'none' } });
      else {
        choices.push({
          kind: 'replan',
          execution: {
            kind: 'keep',
            executionId: execution.intent.executionId,
          },
        });
        choices.push({
          kind: 'replan',
          execution: {
            kind: 'stop',
            executionId: execution.intent.executionId,
          },
        });
      }
    }
    choices.push({ kind: 'abstain' });
    const decisions: ControlDecision[] = [];
    for (const choice of choices) {
      if (pending === null) decisions.push({ ...choice, proposal: null });
      else {
        if (choice.kind !== 'replan')
          decisions.push({
            ...choice,
            proposal: { kind: 'defer', proposalId: pending.proposalId },
          });
        decisions.push({
          ...choice,
          proposal: { kind: 'discard', proposalId: pending.proposalId },
        });
      }
    }
    if (pending !== null && proposalApplies(this.session, pending)) {
      if (execution === null)
        decisions.push({
          kind: 'adoptPlan',
          proposalId: pending.proposalId,
          execution: { kind: 'none' },
        });
      else if (execution.stopCause === null) {
        if (this.canKeepPlan(pending))
          decisions.push({
            kind: 'adoptPlan',
            proposalId: pending.proposalId,
            execution: {
              kind: 'keep',
              executionId: execution.intent.executionId,
            },
          });
        decisions.push({
          kind: 'adoptPlan',
          proposalId: pending.proposalId,
          execution: {
            kind: 'stop',
            executionId: execution.intent.executionId,
          },
        });
      }
    }
    return decisions;
  }

  private canKeepPlan(pending: PendingPlanProposal): boolean {
    const execution = this.execution.active;
    const proposal = pending.proposal;
    if (
      execution === null ||
      proposal.outcome === 'blocked' ||
      proposal.outcome === 'claimComplete' ||
      !proposalApplies(this.session, pending)
    )
      return false;
    if (
      (proposal.outcome === 'revise' || proposal.outcome === 'reconfirm') &&
      proposal.revisions.some((revision) =>
        execution.basis.context.graph.goalPath.some(
          (ref) => ref.id === revision.goalRef.id,
        ),
      )
    )
      return false;
    return (
      this.execution.continuationInvalidationReason(
        execution.intent.executionId,
        this.session.state.decision,
      ) === null
    );
  }

  private async prepareAdoption(
    pending: PendingPlanProposal,
    execution: ExecutionDisposition,
  ): Promise<PlanAdoption<TCriteria> | null> {
    const session = this.session;
    if (
      !proposalApplies(this.session, pending) ||
      (execution.kind === 'keep'
        ? !this.canKeepPlan(pending) ||
          this.execution.active?.intent.executionId !== execution.executionId
        : session.hasExecution)
    )
      throw new CallStopped();
    const current = session.state.decision.context;
    // Revalidate live goal membership while retaining the proposal's original response identity.
    const proposal = parsePlanProposal(
      pending.proposal,
      {
        ...pending.request,
        context: {
          ...current,
          observation: pending.request.context.observation,
        },
      },
      {
        maxDepth:
          session.state.limits.maxGoalDepth === null
            ? null
            : session.state.limits.maxGoalDepth + 1,
        maxNewGoals:
          session.state.limits.maxSubgoals === null
            ? null
            : Math.max(1, session.state.limits.maxSubgoals),
        maxTotalGoals:
          session.state.limits.maxSubgoals === null
            ? null
            : session.state.limits.maxSubgoals + 1,
      },
    );
    if (proposal.outcome === 'blocked' || proposal.outcome === 'claimComplete')
      return null;
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
    const criteria = new Map<string, TCriteria>();
    for (const goal of prepared.changed)
      criteria.set(`${goal.id}:${goal.version}`, await this.support(goal));
    return {
      graph: prepared.graph,
      planRef,
      guidance: proposal.guidance,
      goals: prepared.state,
      criteria,
      before: current.graph,
      verifyGoals:
        prepared.changed.length > 0 ||
        current.graph.currentGoalRef.id !== prepared.graph.currentGoalRef.id,
      records: [
        session.event('plan_accepted', pending.request.trigger.kind, {
          requestId: pending.request.requestId,
          proposalId: pending.proposalId,
          planRef: { ...planRef },
          proposal: parseJsonValue(proposal, 'planning'),
          acceptedGoals: parseJsonValue(prepared.changed, 'planning'),
          nextGoalRef: { ...prepared.graph.currentGoalRef },
          goalOrder: prepared.state.order.map((ref) => ({ ...ref })),
        }),
      ],
    };
  }

  private launchPlanning(trigger: PlanningTrigger): void {
    if (
      this.#plannerTask !== null ||
      this.session.state.pendingProposal !== null
    )
      throw new ContractError(
        validation.code,
        validation.stage,
        '/planning',
        'planning_busy',
      );
    const session = this.session;
    const version = session.state.scheduling.planningVersion;
    const request: PlannerRequest = Object.freeze({
      ...session.state.decision,
      requestId: randomUUID(),
      capabilities: this.registry.capabilities,
      trigger,
      pendingGoals: session.state.goals.pending,
    });
    const task = (async () => {
      const raw = await this.call(
        'planning',
        request,
        (control) => this.options.planner.plan(request, control),
        request.requestId,
      );
      const proposal = parsePlanProposal(raw, request, {
        maxDepth:
          session.state.limits.maxGoalDepth === null
            ? null
            : session.state.limits.maxGoalDepth + 1,
        maxNewGoals:
          session.state.limits.maxSubgoals === null
            ? null
            : Math.max(1, session.state.limits.maxSubgoals),
        maxTotalGoals:
          session.state.limits.maxSubgoals === null
            ? null
            : session.state.limits.maxSubgoals + 1,
      });
      if (!session.canDispatch(request.decisionEpoch)) throw new CallStopped();
      if (session.state.pendingProposal !== null)
        throw new ContractError(
          validation.code,
          validation.stage,
          '/pendingProposal',
          'proposal_not_disposed',
        );
      const pending: PendingPlanProposal = {
        proposalId: randomUUID(),
        request,
        proposal,
        receivedAt: new Date().toISOString(),
      };
      await session.commit(
        {
          ...session.state,
          pendingProposal: pending,
          scheduling: requestReview({
            ...session.state.scheduling,
            planning:
              session.state.scheduling.planningVersion === version
                ? null
                : session.state.scheduling.planning,
          }),
        },
        [
          session.event('proposal_received', proposal.outcome, {
            proposal: parseJsonValue(pending, 'planning'),
          }),
        ],
      );
    })()
      .catch(async (error: unknown) => {
        if (
          session.failure !== null ||
          session.state.control.status !== 'running'
        )
          return;
        if (error instanceof CallStopped)
          await session.markReview('planning_invalidated');
        else
          await this.block(
            error instanceof ContractError ? error.reason : 'planning_failed',
          );
      })
      .finally(() => {
        if (this.#plannerTask === task) this.#plannerTask = null;
        this.#wake?.();
      });
    this.#plannerTask = task;
    void task.catch(() => undefined);
  }

  private async review(): Promise<void> {
    const session = this.session;
    const timing = session.state.scheduling;
    const earliest =
      timing.lastDecisionStartedAt === null
        ? 0
        : Date.parse(timing.lastDecisionStartedAt) +
          timing.minDecisionIntervalMs;
    while (Date.now() < earliest && session.state.control.status === 'running')
      await this.waitForWake(earliest);
    if (session.state.control.status !== 'running') throw new CallStopped();
    if (this.#verifyPending && !session.hasExecution) return;
    // Facts received during collection belong to the following review, even if the snapshot overlaps them.
    const epoch = session.state.decision.decisionEpoch;
    const reviewVersion = session.state.scheduling.reviewVersion;
    const throughSequence = session.state.observations.eventSequence;
    const changes = session.state.observations.unreadChanges.filter(
      (change) => change.sequence <= throughSequence,
    );
    await this.observe();
    const context = session.state.decision.context;
    const operationRequest = createOperationRequest(
      session.state.decision,
      this.registry,
    );
    const operations = parseOperationSet(
      await this.call(
        'operations',
        operationRequest,
        (control) =>
          this.options.candidateProvider.listOperations(
            operationRequest,
            control,
          ),
        operationRequest.requestId,
      ),
      operationRequest,
    );
    if (!session.canDispatch(epoch)) throw new CallStopped();
    if (
      (this.#verifyPending || this.#executionTask !== null) &&
      this.execution.active === null
    )
      return;
    const execution = this.execution.active;
    if (execution?.stopCause != null) return;
    const selectionState = this.#selection.snapshot();
    const selection = selectionState?.summary ?? null;
    const request = createDecisionRequest({
      requestId: randomUUID(),
      decisionEpoch: epoch,
      context,
      reviewVersion,
      throughSequence,
      changes,
      capabilities: this.registry.capabilities,
      operations,
      execution:
        execution === null
          ? null
          : {
              intent: execution.intent,
              phase: execution.phase,
              progress: execution.progress,
            },
      selection,
      planning: {
        need: session.state.scheduling.planning,
        inFlight: this.#plannerTask !== null,
        pending: session.state.pendingProposal,
      },
      decisions: this.decisionOptions(operations),
    });
    this.#selection.suspend();
    this.clearReviewTimer();
    await session.commit(
      {
        ...session.state,
        scheduling: {
          ...session.state.scheduling,
          lastDecisionStartedAt: new Date().toISOString(),
        },
      },
      [
        session.event('decision_requested', 'review_pending', {
          projectionVersion: 1,
          request: parseJsonValue(request, 'decision'),
          source: parseJsonValue(
            {
              context,
              changes,
              operations,
              execution,
              selectionCursor: selectionState?.source.selectionCursor ?? null,
              completedSelection:
                selectionState?.source.completedSelection ?? null,
              pendingProposal: session.state.pendingProposal,
            },
            'decision',
          ),
        }),
      ],
    );
    let option: DecisionOption;
    try {
      option = selectDecision(
        request,
        await this.call(
          'decision',
          request,
          (control) => this.options.decisionPolicy.decide(request, control),
          request.requestId,
        ),
      );
    } catch (error) {
      await rejectDecision(
        session,
        request,
        error instanceof ContractError
          ? error.reason
          : (session.state.control.stopCause?.reasonCode ??
              'decision_interrupted'),
        null,
      );
      throw error;
    } finally {
      this.scheduleReview();
    }
    if (!decisionApplies(session, request, this.execution, this.#selection)) {
      await rejectDecision(session, request, 'basis_changed', option.id);
      return;
    }
    const chosen = option.decision;
    const pending = session.state.pendingProposal;
    let adoption: PlanAdoption<TCriteria> | null = null;
    let continuationBasis: CandidateGenerationInput | null = null;
    try {
      if (chosen.kind === 'adoptPlan') {
        if (pending === null) throw new CallStopped();
        if (chosen.execution.kind !== 'stop')
          adoption = await this.prepareAdoption(pending, chosen.execution);
        if (chosen.execution.kind === 'keep') {
          const execution = this.execution.active;
          if (adoption === null || execution === null) throw new CallStopped();
          continuationBasis = {
            requestId: request.requestId,
            decisionEpoch: epoch,
            context: {
              ...session.state.decision.context,
              graph: focusGoal(adoption.graph, execution.intent.currentGoalRef),
              planRef: adoption.planRef,
              planGuidance: adoption.guidance,
            },
          };
          const continuation = await this.execution.checkContinuation(
            chosen.execution.executionId,
            continuationBasis,
            this.control('checking'),
          );
          if (continuation.outcome !== 'allowed') {
            await rejectDecision(
              session,
              request,
              `continuation_${continuation.outcome}`,
              option.id,
            );
            return;
          }
        }
      }
    } catch (error) {
      await rejectDecision(
        session,
        request,
        error instanceof ContractError
          ? error.reason
          : (session.state.control.stopCause?.reasonCode ??
              'adoption_interrupted'),
        option.id,
      );
      throw error;
    }
    const accepted = await acceptDecision(
      session,
      this.execution,
      this.#selection,
      {
        request,
        option,
        prepared: adoption,
        continuationBasis,
      },
    );
    if (accepted.outcome === 'rejected') return;
    if (chosen.kind === 'selectOperation') this.#selection.discard();
    if (chosen.kind === 'adoptPlan') {
      this.#selection.discard();
      if (pending === null) throw new CallStopped();
      if (chosen.execution.kind === 'stop') {
        if (accepted.pendingAdoption === null) throw new CallStopped();
        await this.adoptAfterStop(pending, accepted.pendingAdoption);
      } else if (session.canDispatch(accepted.decisionEpoch))
        await this.completeAdoption(pending, adoption);
      return;
    }
    if (!session.canDispatch(epoch)) return;
    switch (chosen.kind) {
      case 'continueAction':
      case 'wait':
        return;
      case 'continueSelection': {
        if (!this.#selection.authorize(chosen.selectionId))
          throw new CallStopped();
        const selection = this.#selection.snapshot();
        if (selection === null) throw new CallStopped();
        if (Date.now() >= Date.parse(selection.summary.deadlineAt)) {
          await this.discardSelection('selection_deadlineExceeded');
          await this.block('selection_deadlineExceeded');
          return;
        }
        // Facts arriving during this review remain unread. Consume its accepted
        // authorization for one step before they request another review, otherwise
        // a continuous source can prevent every batch or ready result from advancing.
        const ready = this.#selection.takeReady();
        if (ready !== null) await this.finishSelection(ready);
        else {
          const batch = this.#selection.nextBatch(session.state.recentChoices);
          if (batch?.kind === 'batch') await this.advanceSelection(batch);
        }
        return;
      }
      case 'abstain':
        await this.block('decision_abstained');
        return;
      case 'stopAction':
        await this.stopExecution(chosen.executionId, accepted.decisionEventId);
        return;
      case 'selectOperation':
        if (execution !== null)
          await this.stopExecution(
            execution.intent.executionId,
            accepted.decisionEventId,
          );
        if (session.canDispatch(epoch) && !session.hasExecution)
          await this.bindOperation(operations, chosen.operationId);
        return;
      case 'replan': {
        if (chosen.execution.kind === 'stop')
          await this.stopExecution(
            chosen.execution.executionId,
            accepted.decisionEventId,
          );
        if (!session.canDispatch(epoch)) return;
        const trigger = session.state.scheduling.planning ?? {
          kind: 'decision' as const,
          requestId: request.requestId,
          goalRef: session.state.decision.context.graph.currentGoalRef,
        };
        if (session.state.scheduling.planning === null)
          await session.commit(
            {
              ...session.state,
              scheduling: requestPlanning(session.state.scheduling, trigger),
            },
            [],
          );
        if (session.canDispatch(epoch)) this.launchPlanning(trigger);
        return;
      }
    }
  }

  private async completeAdoption(
    pending: PendingPlanProposal,
    adoption: PlanAdoption<TCriteria> | null,
  ): Promise<void> {
    const session = this.session;
    if (adoption === null) {
      if (pending.proposal.outcome === 'blocked')
        await this.block(pending.proposal.reason);
      else if (pending.proposal.outcome === 'claimComplete') {
        const claimedGoal = pending.proposal.goalRef;
        await this.observe();
        await this.verify();
        this.#verifyPending = false;
        if (
          session.state.control.status === 'running' &&
          session.state.decision.context.graph.goals.find(
            (goal) =>
              goal.id === claimedGoal.id &&
              goal.version === claimedGoal.version,
          )?.lastAssessment?.outcome !== 'passed'
        )
          await this.block('completion_not_verified');
      }
      return;
    }
    for (const [key, criteria] of adoption.criteria)
      this.#criteria.set(key, criteria);
    const live = new Set(
      adoption.graph.goals
        .filter(
          (goal) =>
            goal.lifecycle === 'pending' || goal.lifecycle === 'inProgress',
        )
        .map((goal) => `${goal.id}:${goal.version}`),
    );
    for (const key of this.#criteria.keys())
      if (!live.has(key)) this.#criteria.delete(key);
    this.#verifyPending ||= adoption.verifyGoals;
    if (this.#verifyPending && !session.hasExecution) {
      await this.observe();
      await this.verify();
      this.#verifyPending = false;
      if (
        adoption.verifyGoals &&
        session.state.control.status === 'running' &&
        session.state.scheduling.planning !== null
      )
        await this.recordProgress(adoption.before, 'planning', false);
    }
  }

  /** A live stop decision authorizes adoption after settlement, without another policy call. */
  private async adoptAfterStop(
    pending: PendingPlanProposal,
    authorization: PendingPlanAdoption,
  ): Promise<void> {
    const session = this.session;
    let discardReason = 'basis_changed';
    try {
      if (!stopAdoptionApplies(session, authorization)) throw new CallStopped();
      await this.awaitExecutionStop(
        authorization.executionId,
        authorization.decisionEventId,
      );
      if (!stopAdoptionApplies(session, authorization)) throw new CallStopped();
      // Verify only after applying the plan; old-plan verification could advance
      // its goal and invalidate an otherwise applicable approved proposal.
      await this.observe();
      if (!stopAdoptionApplies(session, authorization)) throw new CallStopped();
      const adoption = await this.prepareAdoption(pending, { kind: 'none' });
      const accepted = await acceptStoppedPlan(
        session,
        authorization,
        adoption,
      );
      if (accepted.outcome === 'rejected') throw new CallStopped();
      if (session.canDispatch(accepted.decisionEpoch))
        await this.completeAdoption(pending, adoption);
    } catch (error) {
      discardReason =
        error instanceof ContractError
          ? error.reason
          : error instanceof CallStopped
            ? stopAdoptionApplies(session, authorization)
              ? 'execution_unsettled'
              : 'basis_changed'
            : (session.state.control.stopCause?.reasonCode ??
              'adoption_failed');
      throw error;
    } finally {
      if (
        session.failure === null &&
        session.state.pendingAdoption?.decisionEventId ===
          authorization.decisionEventId
      )
        await session.commit(
          {
            ...session.state,
            pendingAdoption: null,
            scheduling: requestReview(session.state.scheduling),
          },
          [
            session.event('plan_adoption_discarded', discardReason, {
              proposalId: authorization.proposalId,
              executionId: authorization.executionId,
              decisionRequestId: authorization.decisionRequestId,
              decisionEventId: authorization.decisionEventId,
            }),
          ],
        );
    }
  }

  private async awaitExecutionStop(
    executionId: string,
    eventId: string,
  ): Promise<void> {
    this.execution.interrupt(executionId, {
      eventId,
      reasonCode: 'decision_stop',
    });
    await this.#executionTask;
    const execution = this.session.state.execution;
    if (
      this.session.hasExecution ||
      execution?.intent.executionId !== executionId ||
      execution.result === null ||
      execution.result.outcome === 'unknown' ||
      !execution.result.underlyingSettled
    )
      throw new CallStopped();
  }

  private async stopExecution(
    executionId: string,
    eventId: string,
  ): Promise<void> {
    await this.awaitExecutionStop(executionId, eventId);
    if (
      this.#verifyPending &&
      this.session.state.control.status === 'running'
    ) {
      await this.observe();
      await this.verify();
      this.#verifyPending = false;
    }
  }

  private async bindOperation(
    operations: OperationSet,
    operationId: string,
  ): Promise<void> {
    const session = this.session;
    await this.observe();
    const input = { ...session.state.decision, requestId: randomUUID() };
    const request = createOperationBindingRequest(
      input,
      this.registry,
      operations,
      operationId,
    );
    const bound = parseBoundCandidates(
      await this.call(
        'candidates',
        request,
        (control) => this.options.candidateProvider.bind(request, control),
        request.requestId,
      ),
      request,
    );
    const prepared = await prepareCandidates(
      input,
      this.registry,
      { generate: () => Promise.resolve(bound) },
      this.control('candidates'),
    );
    await this.drainLightCallbacks();
    if (!session.canDispatch(input.decisionEpoch)) throw new CallStopped();
    if (prepared.outcome !== 'prepared') {
      await this.block(`candidates_${prepared.outcome}`);
      return;
    }
    const checkingStartedAt = Date.now();
    const checked = await checkCandidatesWithInvocation(
      prepared.prepared,
      this.control('checking'),
      (input, control, check) =>
        captureCallback(
          session,
          {
            stage: 'checking',
            phase: 'selection',
            decisionEpoch: input.basis.decisionEpoch,
            input,
          },
          control,
          () => session.canDispatch(input.basis.decisionEpoch),
          check,
        ),
    );
    if (!session.canDispatch(input.decisionEpoch)) throw new CallStopped();
    if (checked.outcome !== 'checked') {
      await this.block(`checking_${checked.outcome}`);
      return;
    }
    const filtered = await filterCandidates(
      checked.checked,
      this.control('filtering'),
      this.options.candidateFilter === undefined
        ? undefined
        : {
            filter: (request, control) =>
              this.call(
                'filtering',
                request,
                (control) =>
                  this.options.candidateFilter!.filter(request, control),
                request.requestId,
                control,
              ),
          },
    );
    await this.drainLightCallbacks();
    if (!session.canDispatch(input.decisionEpoch)) throw new CallStopped();
    if (filtered.outcome !== 'filtered') {
      await this.block(`filtering_${filtered.outcome}`);
      return;
    }
    await session.commit(session.state, [
      session.event('candidates_processed', 'operation_bound', {
        requestId: input.requestId,
        operationSetId: operations.id,
        operationId,
        generation: parseJsonValue(prepared.prepared.report, 'generation'),
        checking: parseJsonValue(checked.checked.report, 'checking'),
        checkingDurationMs: Math.max(0, Date.now() - checkingStartedAt),
        filtering: parseJsonValue(filtered.filtered.report, 'filtering'),
        candidates: parseJsonValue(filtered.filtered.set, 'candidates'),
      }),
    ]);
    if (!session.canDispatch(input.decisionEpoch)) throw new CallStopped();
    const selector = this.options.selector;
    if (selector.kind === 'resumable') {
      const capacity =
        this.options.selectorCapacity === undefined
          ? selector.capacity
          : selector.capacity === undefined
            ? this.options.selectorCapacity
            : Math.min(this.options.selectorCapacity, selector.capacity);
      const started = beginSelection(
        filtered.filtered,
        operations.id,
        operationId,
        selector.batchCapacity,
        this.control('selection'),
        capacity,
      );
      if (started.outcome === 'pending') {
        this.#selection.start({ kind: 'comparing', cursor: started.cursor });
        await this.recordSelectionStart(
          started.cursor.selectionId,
          operationId,
          filtered.filtered,
        );
      } else {
        await session.commit(
          session.state,
          [],
          [describeSelectionResult(started, input.requestId, operationId)],
        );
        await this.finishSelection(started);
      }
      return;
    }
    const selectionControl = this.control('selection');
    await this.recordSelectionStart(
      input.requestId,
      operationId,
      filtered.filtered,
    );
    const selected = await selectCandidates(
      filtered.filtered,
      {
        kind: 'single',
        ...(selector.capacity === undefined
          ? {}
          : { capacity: selector.capacity }),
        select: (original, control) => {
          const request =
            original.context.runtime === undefined
              ? original
              : Object.freeze({
                  ...original,
                  context: Object.freeze({
                    ...original.context,
                    runtime: Object.freeze({
                      ...original.context.runtime,
                      recentChoices: session.state.recentChoices,
                    }),
                  }),
                });
          return this.call(
            'selection',
            request,
            (control) => selector.select(request, control),
            request.requestId,
            control,
          );
        },
      },
      selectionControl,
      this.options.selectorCapacity,
    );
    await this.drainLightCallbacks();
    if (!session.canDispatch(input.decisionEpoch)) throw new CallStopped();
    await session.commit(
      session.state,
      [],
      [describeSelectionResult(selected, input.requestId, operationId)],
    );
    if (selected.outcome === 'selected') {
      this.#selection.start({
        kind: 'ready',
        selection: {
          selectionId: input.requestId,
          operationId,
          deadlineAt: selectionControl.deadlineAt,
          round: 0,
          completedBatches: 1,
          result: selected,
        },
      });
    } else await this.finishSelection(selected);
  }

  private async advanceSelection(batch: SelectionBatch): Promise<void> {
    const { cursor, request, attempt } = batch;
    const selector = this.options.selector;
    if (selector.kind !== 'resumable') return;
    const control = {
      ...this.control('selection'),
      deadlineAt: cursor.deadlineAt,
    };
    try {
      const raw = await this.call(
        'selection',
        request,
        (control) => selector.advance(request, control),
        request.requestId,
        control,
        attempt,
      );
      if (
        this.#selection.snapshot()?.source.selectionCursor !== cursor ||
        !this.session.canDispatch(request.decisionEpoch)
      )
        throw new CallStopped();
      const result = acceptSelectionBatch(cursor, raw);
      let history: ChoiceHistoryEntry;
      if (result.outcome === 'pending') {
        const candidate =
          raw.outcome === 'selected'
            ? request.candidates.candidates.find(
                (candidate) => candidate.id === raw.candidateId,
              )!
            : null;
        history = {
          kind: 'selectionResult',
          recordedAt: new Date().toISOString(),
          goalRef: request.context.graph.currentGoalRef,
          selectionId: cursor.selectionId,
          operationId: cursor.operationId,
          round: request.round,
          batchIndex: request.batchIndex,
          comparisonComplete: false,
          outcome: raw.outcome,
          candidate: describeHistoricalCandidate(candidate),
          reasonCode: raw.outcome === 'abstain' ? raw.reason : null,
        };
      } else
        history = {
          ...describeSelectionResult(
            result,
            cursor.selectionId,
            cursor.operationId,
          ),
          round: request.round,
          batchIndex: request.batchIndex,
        };
      await this.session.commit(
        this.session.state,
        [
          this.session.event('selection_batch_finished', result.outcome, {
            selectionId: cursor.selectionId,
            request: parseJsonValue(request, 'selection'),
            response: parseJsonValue(raw, 'selection'),
          }),
        ],
        [history],
      );
      if (!this.#selection.advance(cursor, result)) throw new CallStopped();
      if (result.outcome !== 'pending' && result.outcome !== 'selected')
        await this.finishSelection(result);
    } catch (error) {
      if (
        !this.#selection.retry(
          cursor,
          error,
          this.session.state.limits.modelRetries,
        )
      )
        throw error;
    }
    // Let queued source and timer callbacks run between finite synchronous batches.
    await scheduler.yield();
  }

  private async finishSelection(
    selected: CandidateSelectionResult,
  ): Promise<void> {
    await this.session.commit(this.session.state, [
      this.session.event('selection_finished', selected.outcome, {
        ...(selected.outcome === 'selected' || selected.outcome === 'abstain'
          ? { selection: parseJsonValue(selected.selection, 'selection') }
          : {}),
      }),
    ]);
    if (selected.outcome !== 'selected') {
      await this.block(`selection_${selected.outcome}`);
      return;
    }
    await this.startExecution(selected);
  }

  private recordSelectionStart(
    selectionId: string,
    operationId: string,
    filtered: FilteredCandidates,
  ): Promise<void> {
    const history: ChoiceHistoryEntry = {
      kind: 'selectionStarted',
      recordedAt: new Date().toISOString(),
      goalRef: filtered.checked.prepared.request.context.graph.currentGoalRef,
      selectionId,
      operationId,
      candidateCount: filtered.set.candidates.length,
    };
    return this.session.commit(
      this.session.state,
      [
        this.session.event('selection_started', 'operation_bound', {
          selectionId,
          operationId,
          candidateCount: filtered.set.candidates.length,
        }),
      ],
      [history],
    );
  }

  private async discardSelection(reasonCode: string): Promise<void> {
    const history = this.#selection.describeDiscard(reasonCode);
    this.#selection.discard();
    if (history === null || this.session.failure !== null) return;
    await this.session.commit(
      this.session.state,
      [
        this.session.event('selection_discarded', reasonCode, {
          selectionId: history.selectionId,
        }),
      ],
      [history],
    );
  }

  private async startExecution(selected: SelectedCandidate): Promise<void> {
    const session = this.session;
    if (this.#verifyPending) {
      await session.markReview('execution_verification_pending');
      return;
    }
    const started = await this.execution.start(selected);
    if (started.outcome === 'notExecuted') {
      if (session.state.control.status === 'running')
        await session.markReview(started.reasonCode);
      return;
    }
    const task = started.completion
      .then((result: ActionResult) => {
        if (result.outcome !== 'unknown') this.#verifyPending = true;
        this.#wake?.();
      })
      .catch(async (error: unknown) => {
        if (
          session.failure === null &&
          session.state.control.status === 'running'
        )
          await this.block(
            error instanceof ContractError ? error.reason : 'execution_failed',
          );
      })
      .finally(() => {
        if (this.#executionTask === task) this.#executionTask = null;
        this.#wake?.();
      });
    this.#executionTask = task;
    void task.catch(() => undefined);
  }

  private async run(): Promise<void> {
    const session = this.session;
    const unwatch = session.subscribe(() => this.#wake?.());
    try {
      this.#refresh = false;
      this.#verifyPending = true;
      while (
        session.state.control.status === 'running' &&
        session.failure === null
      ) {
        try {
          if (this.#refresh) {
            this.#refresh = false;
            await this.discardSelection('basis_changed');
          }
          if (
            session.hasExecution &&
            session.state.execution?.phase === 'unknown'
          ) {
            await this.block('execution_unsettled');
            break;
          }
          if (this.#executionTask !== null && this.execution.active === null) {
            await this.#executionTask;
            continue;
          }
          if (this.execution.active?.stopCause != null) {
            await this.#executionTask;
            continue;
          }
          if (this.#verifyPending && !session.hasExecution) {
            await this.observe();
            await this.verify();
            this.#verifyPending = false;
            if (session.state.control.status === 'running')
              await session.markReview('flow_advanced');
            continue;
          }
          const pending = session.state.pendingProposal;
          if (pending !== null && !proposalApplies(this.session, pending)) {
            await session.commit(
              {
                ...session.state,
                pendingProposal: null,
                scheduling: requestReview(session.state.scheduling),
              },
              [
                session.event('proposal_discarded', 'basis_changed', {
                  proposalId: pending.proposalId,
                }),
              ],
            );
            continue;
          }
          const selection = this.#selection.snapshot()?.summary ?? null;
          if (
            selection !== null &&
            Date.now() >= Date.parse(selection.deadlineAt)
          ) {
            await this.discardSelection('selection_deadlineExceeded');
            await this.block('selection_deadlineExceeded');
            break;
          }
          // A completed, still-authorized comparison already chose this call.
          // Recheck it against a fresh observation before ordinary review can
          // replace it. Epoch changes, cancellation and deadlines still win.
          const ready = this.#selection.takeReady();
          if (ready !== null) {
            await this.finishSelection(ready);
            continue;
          }
          if (session.state.scheduling.reviewPending) {
            await this.review();
            continue;
          }
          const batch = this.#selection.nextBatch(session.state.recentChoices);
          if (batch !== null) {
            if (batch.kind === 'wait') await this.waitForWake(batch.until);
            else await this.advanceSelection(batch);
            continue;
          }
          await this.waitForWake(
            selection === null ? undefined : Date.parse(selection.deadlineAt),
          );
        } catch (error) {
          if (error instanceof CallStopped) continue;
          throw error;
        }
      }
    } catch (error) {
      if (
        session.failure === null &&
        session.state.control.status === 'running'
      )
        await this.block(
          error instanceof ContractError
            ? error.reason
            : error instanceof ModelRequestError
              ? error.code
              : 'callback_failed',
        );
    } finally {
      this.clearReviewTimer();
      await Promise.allSettled([
        this.discardSelection(
          session.state.control.stopCause?.reasonCode ?? 'run_stopped',
        ),
        ...this.#callbacks.keys(),
        this.#plannerTask,
        this.#executionTask,
      ]);
      unwatch();
      if (session.failure === null) await this.settleStop();
    }
  }
  private async block(reasonCode: string): Promise<void> {
    if (this.session.state.control.status !== 'running') return;
    const record = this.session.event('run_blocked', reasonCode, {});
    await this.session.transition(
      {
        kind: 'pause',
        cause: { eventId: record.eventId, reasonCode },
      },
      [record],
    );
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
