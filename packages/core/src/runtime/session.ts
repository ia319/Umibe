import { randomUUID } from 'node:crypto';
import type { JsonObject } from '#internal/contracts/json';
import type { CandidateGenerationInput } from '#internal/contracts/candidate-processing';
import type { RunCheckpoint, RunRecord } from '#internal/contracts/record';
import { captureDecisionRequest } from '#internal/candidate/context';
import { canonicalJson } from '#internal/candidate/identity';
import { ContractError } from '#internal/errors';
import type {
  RunRecordDraft,
  RunStore,
  RunLease,
} from '#internal/storage/contracts';
import { requireObject } from '#internal/validation/fields';
import { parseJsonValue } from '#internal/validation/json';
import { parseGoalGraph } from '#internal/validation/goal';
import { createRunControl, transitionRun } from './state.js';
import type { RunCommand, RunControlState } from './state.js';
import { captureLimits } from './limits.js';
import type { RuntimeLimits } from './limits.js';
import type { ExecutionSnapshot } from './execution.js';
import type { SchedulingState } from './scheduling.js';
import type { GoalState } from './goals.js';
import type { GoalProgress, ProgressAttempt } from './progress.js';
import type { ActionResult } from '#internal/contracts/record';
import {
  parseRuntimeCheckpoint,
  runtimeStateSchemaVersion,
} from './checkpoint.js';
import type { RuntimeIdentity, PendingModelAttempt } from './checkpoint.js';

export interface SessionState {
  readonly identity: RuntimeIdentity;
  readonly pendingModels: readonly PendingModelAttempt[];
  readonly control: RunControlState;
  readonly decision: CandidateGenerationInput;
  readonly limits: RuntimeLimits;
  readonly modelAttempts: number;
  readonly actionAttempts: number;
  readonly execution: ExecutionSnapshot | null;
  readonly scheduling: SchedulingState;
  readonly goals: GoalState;
  readonly progress: readonly GoalProgress[];
  readonly progressAttempt: ProgressAttempt | null;
  readonly recentResults: readonly ActionResult[];
}

export interface RuntimeDiagnostic {
  readonly code:
    | 'store_failed'
    | 'store_conflict'
    | 'subscriber_failed'
    | 'environment_event_failed'
    | 'environment_subscription_failed';
  readonly runId: string;
  readonly eventId: string | null;
}

const validation = {
  code: 'INVALID_RUN_CONTROL',
  stage: 'run_session',
} as const;

/**
 * One in-process writer for a run. State admission is synchronous; persistence
 * is ordered separately so a pending commit cannot delay a stop signal.
 * The injected store remains owned by its caller. Restoring requires a fresh lease
 * and a validated checkpoint; construction alone never authorizes dispatch.
 */
export class RunSession {
  readonly runId: string;
  #state: SessionState;
  #checkpoint: RunCheckpoint | null = null;
  #committedState: SessionState | null = null;
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;
  #closed = false;
  #executionOwned = false;
  #failure: ContractError | null = null;
  #controller = new AbortController();
  readonly #listeners = new Set<(record: RunRecord) => void>();
  #resolveResult!: (state: RunControlState) => void;
  #rejectResult!: (error: unknown) => void;
  #result!: Promise<RunControlState>;
  #closing: Promise<void> | null = null;
  readonly #ownershipLost = () => this.fail('store_failed');

  private constructor(
    private readonly store: RunStore,
    private readonly lease: RunLease,
    state: SessionState,
    private readonly diagnose: (diagnostic: RuntimeDiagnostic) => void,
    checkpoint: RunCheckpoint | null,
  ) {
    this.runId = state.decision.context.graph.runId;
    this.#state = state;
    this.#checkpoint = checkpoint;
    this.#committedState = checkpoint === null ? null : state;
    this.beginInterval();
    lease.signal.addEventListener('abort', this.#ownershipLost, { once: true });
    if (lease.signal.aborted) this.#ownershipLost();
  }

  static async create(
    store: RunStore,
    input: CandidateGenerationInput,
    diagnose: (diagnostic: RuntimeDiagnostic) => void,
    limits: Partial<RuntimeLimits> = {},
    identity: RuntimeIdentity = {
      applicationId: null,
      actionVersions: [],
      modelStages: [],
    },
  ): Promise<RunSession> {
    const decision = captureDecisionRequest(input);
    const capturedLimits = captureLimits(limits);
    const runId = decision.context.graph.runId;
    if (store.info.durable && identity.applicationId === null)
      throw new ContractError(
        validation.code,
        validation.stage,
        '/applicationId',
        'missing_application_id',
      );
    const state: SessionState = Object.freeze({
      identity,
      pendingModels: [],
      control: createRunControl(decision.context.graph.rootGoalRef),
      decision,
      limits: capturedLimits,
      modelAttempts: 0,
      actionAttempts: 0,
      execution: null,
      progress: [],
      progressAttempt: null,
      recentResults: [],
      goals: {
        created: decision.context.graph.goals.length - 1,
        pending: [],
        order: [],
      },
      scheduling: {
        policyVersion: 1,
        planning: { kind: 'initial', assessment: 'notYet' },
        recoveryAttempts: 0,
        lastSelectionBasis: null,
        selectionCause: 'initial',
      } satisfies SchedulingState,
    });
    const lease = await store.acquireRun(runId);
    const session = new RunSession(store, lease, state, diagnose, null);
    try {
      await session.commit(session.state, [
        session.event('run_created', 'created', {}),
      ]);
      return session;
    } catch (error) {
      lease.signal.removeEventListener('abort', session.#ownershipLost);
      await lease.release();
      throw error;
    }
  }

  /** Re-read under ownership so validation never authorizes an obsolete checkpoint. */
  static async restore(
    store: RunStore,
    runId: string,
    diagnose: (diagnostic: RuntimeDiagnostic) => void,
    identity: RuntimeIdentity,
  ): Promise<RunSession> {
    const read = async () => {
      const stored = await store.readRun(runId);
      if (stored === null)
        throw new ContractError(
          validation.code,
          'recovery',
          '/runId',
          'run_not_found',
        );
      const checkpoint = parseRuntimeCheckpoint(stored.checkpoint);
      const state = checkpoint.state;
      for (const key of [
        'applicationId',
        'actionVersions',
        'modelStages',
      ] as const)
        if (
          canonicalJson(parseJsonValue(state.identity[key], 'recovery')) !==
          canonicalJson(parseJsonValue(identity[key], 'recovery'))
        )
          throw new ContractError(
            validation.code,
            'recovery',
            `/identity/${key}`,
            'identity_mismatch',
          );
      if (store.info.durable && identity.applicationId === null)
        throw new ContractError(
          validation.code,
          'recovery',
          '/applicationId',
          'missing_application_id',
        );
      if (
        state.control.status === 'succeeded' ||
        state.control.status === 'failed'
      )
        throw new ContractError(
          validation.code,
          'recovery',
          '/status',
          'terminal_run',
        );
      const summary = stored.summary;
      if (
        summary.checkpointRevision !== checkpoint.revision ||
        summary.lastSequence !== checkpoint.committedSequence ||
        summary.status !== checkpoint.status ||
        canonicalJson(parseJsonValue(summary.rootGoalRef, 'recovery')) !==
          canonicalJson(
            parseJsonValue(state.control.rootGoalRef, 'recovery'),
          ) ||
        canonicalJson(parseJsonValue(summary.currentGoalRef, 'recovery')) !==
          canonicalJson(
            parseJsonValue(
              state.decision.context.graph.currentGoalRef,
              'recovery',
            ),
          )
      )
        throw new ContractError(
          validation.code,
          'recovery',
          '/checkpoint',
          'checkpoint_summary_mismatch',
        );
      return { checkpoint: stored.checkpoint, state };
    };
    await read();
    const lease = await store.acquireRun(runId);
    let session: RunSession | undefined;
    try {
      const { checkpoint, state } = await read();
      const tail = await store.readRecords(
        runId,
        checkpoint.committedSequence <= 1
          ? null
          : { runId, sequence: checkpoint.committedSequence - 1 },
        2,
      );
      if (
        (checkpoint.committedSequence === 0
          ? tail.records.length !== 0
          : tail.records.length !== 1 ||
            tail.records[0]?.sequence !== checkpoint.committedSequence) ||
        tail.nextCursor !== null
      )
        throw new ContractError(
          validation.code,
          'recovery',
          '/committedSequence',
          'history_mismatch',
        );
      session = new RunSession(store, lease, state, diagnose, checkpoint);
      const record = session.event('run_restored', 'checkpoint_loaded', {
        previous: state.control.status,
      });
      const cause = state.control.stopCause ?? {
        eventId: record.eventId,
        reasonCode: 'process_interrupted',
      };
      const execution = state.execution;
      const unknown: ActionResult | null =
        execution !== null && execution.result === null
          ? Object.freeze({
              executionId: execution.intent.executionId,
              outcome: 'unknown',
              reasonCode: 'process_interrupted',
              underlyingSettled: false,
              confirmedEffects: {},
              unresolvedEffects: { execution: 'dispatch_unconfirmed' },
              progress: {},
              stopCauseEventId: cause.eventId,
            })
          : null;
      const unresolved = unknown !== null || execution?.phase === 'unknown';
      await session.commit(
        {
          ...state,
          control: {
            ...state.control,
            status: ['created', 'running', 'pausing'].includes(
              state.control.status,
            )
              ? 'pausing'
              : state.control.status,
            stopCause: cause,
            blocker: unresolved
              ? { eventId: cause.eventId, reasonCode: 'execution_unsettled' }
              : state.control.blocker,
          },
          execution:
            unknown !== null && execution !== null
              ? { ...execution, result: unknown, phase: 'unknown' }
              : execution,
          decision:
            unknown === null
              ? state.decision
              : {
                  ...state.decision,
                  context: {
                    ...state.decision.context,
                    lastActionResult: unknown,
                  },
                },
          recentResults:
            unknown === null
              ? state.recentResults
              : [...state.recentResults, unknown].slice(-50),
        },
        [
          record,
          ...(unknown === null
            ? []
            : [
                {
                  formatVersion: 1 as const,
                  runId,
                  eventId: randomUUID(),
                  kind: 'actionResult' as const,
                  data: unknown,
                },
              ]),
        ],
      );
      if (
        session.state.control.status === 'pausing' ||
        session.state.control.status === 'cancelling'
      )
        await session.transition({
          kind: 'stopSettled',
          blocker:
            session.state.control.blocker ??
            (session.state.control.status === 'pausing' ? cause : null),
        });
      return session;
    } catch (error) {
      if (session !== undefined)
        lease.signal.removeEventListener('abort', session.#ownershipLost);
      await lease.release();
      throw error;
    }
  }

  /** Ownership cancellation also applies to cleanup while the run itself is paused. */
  get ownershipSignal(): AbortSignal {
    return this.lease.signal;
  }

  get state(): SessionState {
    return this.#state;
  }
  get checkpoint(): RunCheckpoint | null {
    return this.#checkpoint;
  }
  get committedState(): SessionState {
    // Creation and restoration return only after a checkpoint is acknowledged.
    return this.#committedState!;
  }
  get signal(): AbortSignal {
    return this.#controller.signal;
  }
  get result(): Promise<RunControlState> {
    return this.#result;
  }
  get failure(): ContractError | null {
    return this.#failure;
  }

  get hasExecution(): boolean {
    return this.#executionOwned;
  }

  get hasPendingCommits(): boolean {
    return this.#pending > 0;
  }

  /** Holds the run across preparation, dispatch and uncertain external effects. */
  claimExecution(): () => void {
    this.ensureOpen();
    if (this.#executionOwned)
      throw new ContractError(
        validation.code,
        validation.stage,
        '/execution',
        'execution_busy',
      );
    this.#executionOwned = true;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.#executionOwned = false;
      }
    };
  }

  /** Resolves after commit; invalid commands reject without changing admitted state. */
  async transition(command: RunCommand): Promise<void> {
    this.ensureOpen();
    if (
      (command.kind === 'resume' || command.kind === 'succeed') &&
      this.#executionOwned
    ) {
      throw new ContractError(
        validation.code,
        validation.stage,
        '/execution',
        'execution_unsettled',
      );
    }
    if (
      command.kind === 'resume' &&
      (this.#pending !== 0 || this.#checkpoint?.status !== 'paused')
    ) {
      throw new ContractError(
        validation.code,
        validation.stage,
        '/status',
        'pause_not_committed',
      );
    }
    if (command.kind === 'succeed') {
      const observation = this.#state.decision.context.observation;
      if (
        command.observationRef.id !== observation.id ||
        command.observationRef.revision !== observation.revision
      )
        throw new ContractError(
          validation.code,
          validation.stage,
          '/observationRef',
          'stale_assessment',
        );
    }
    const control = transitionRun(this.#state.control, command);
    if (control === this.#state.control) return;
    if (command.kind === 'resume') this.beginInterval();
    const record = this.event('run_transition', command.kind, {
      previous: this.#state.control.status,
      status: control.status,
      stopCause: control.stopCause === null ? null : { ...control.stopCause },
      blocker: control.blocker === null ? null : { ...control.blocker },
    });
    let state = {
      ...this.#state,
      control,
      progressAttempt:
        control.status === 'succeeded' ||
        control.status === 'cancelled' ||
        control.status === 'failed'
          ? null
          : this.#state.progressAttempt,
    };
    const closed =
      control.status === 'cancelled'
        ? state.decision.context.graph.goals.filter(
            (goal) =>
              goal.lifecycle === 'pending' || goal.lifecycle === 'inProgress',
          )
        : [];
    if (closed.length > 0) {
      const current = state.decision.context.graph;
      const graph = parseGoalGraph({
        runId: current.runId,
        rootGoalRef: current.rootGoalRef,
        currentGoalRef: current.currentGoalRef,
        goals: current.goals.map((goal) =>
          closed.includes(goal) ? { ...goal, lifecycle: 'cancelled' } : goal,
        ),
      });
      state = {
        ...state,
        decision: {
          ...state.decision,
          context: { ...state.decision.context, graph },
        },
        goals: { ...state.goals, order: [] },
        progress: [],
      };
    }
    const committed = this.commit(state, [
      record,
      ...(closed.length === 0
        ? []
        : [
            this.event('goal_scope_closed', 'run_cancelled', {
              cancelledGoalRefs: closed.map((goal) => ({
                id: goal.id,
                version: goal.version,
              })),
            }),
          ]),
    ]);
    if (control.status !== 'running' && control.status !== 'created')
      this.#controller.abort();
    await committed;
  }

  /** Context owners must advance the epoch for semantic changes, never for sampling alone. */
  async replaceDecision(
    input: CandidateGenerationInput,
    records: readonly RunRecordDraft[] = [],
  ): Promise<void> {
    const decision = captureDecisionRequest(input);
    if (
      decision.context.graph.runId !== this.runId ||
      decision.decisionEpoch < this.#state.decision.decisionEpoch
    ) {
      throw new ContractError(
        validation.code,
        validation.stage,
        '/decision',
        'stale_or_foreign_decision',
      );
    }
    if (this.#state.control.status !== 'running')
      throw new ContractError(
        validation.code,
        validation.stage,
        '/status',
        'run_not_running',
      );
    await this.commit(
      {
        ...this.#state,
        control: Object.freeze({
          ...this.#state.control,
          rootGoalRef: decision.context.graph.rootGoalRef,
        }),
        decision,
      },
      [
        this.event('context_accepted', 'context_updated', {
          decisionEpoch: decision.decisionEpoch,
        }),
        ...records,
      ],
    );
  }

  /** Check again immediately before dispatch, after awaiting the authorizing commit. */
  canDispatch(epoch: number): boolean {
    return (
      !this.#closed &&
      !this.lease.signal.aborted &&
      this.#failure === null &&
      !this.signal.aborted &&
      this.#state.control.status === 'running' &&
      this.#state.decision.decisionEpoch === epoch
    );
  }

  /** Internal atomic checkpoint/event submission; callers must supply detached validated data. */
  commit(
    state: SessionState,
    records: readonly RunRecordDraft[],
  ): Promise<void> {
    this.ensureOpen();
    const path = new Set(
      state.decision.context.graph.goalPath.map((ref) => ref.id),
    );
    state = {
      ...state,
      decision: Object.freeze({
        ...state.decision,
        context: Object.freeze({
          ...state.decision.context,
          runtime: Object.freeze({
            execution:
              state.execution === null
                ? null
                : Object.freeze({
                    executionId: state.execution.intent.executionId,
                    phase: state.execution.phase,
                  }),
            recentResults: state.recentResults,
            progress: Object.freeze(
              state.progress.map(
                ({ goalRef, noProgress, recoveryAttempts, highWater }) =>
                  Object.freeze({
                    goalRef,
                    noProgress,
                    recoveryAttempts,
                    highWater,
                  }),
              ),
            ),
            blocker: state.control.blocker,
            completedSiblings: Object.freeze(
              state.decision.context.graph.goals
                .filter(
                  (goal) =>
                    !path.has(goal.id) &&
                    goal.lifecycle === 'succeeded' &&
                    goal.parentGoalRef !== null &&
                    path.has(goal.parentGoalRef.id),
                )
                .flatMap((goal) =>
                  goal.lastAssessment === null
                    ? []
                    : [
                        Object.freeze({
                          goalRef: { id: goal.id, version: goal.version },
                          assessment: goal.lastAssessment,
                        }),
                      ],
                ),
            ),
          }),
        }),
      }),
    };
    const checkpointState = requireObject(
      parseJsonValue(state, validation.stage),
      validation,
      '/state',
    );
    // Preserve execution identity while freezing nested policy state exposed to adapters.
    const pendingObjects: object[] = [state];
    const frozen = new Set<object>();
    while (pendingObjects.length > 0) {
      const value = pendingObjects.pop()!;
      if (frozen.has(value)) continue;
      frozen.add(value);
      Object.freeze(value);
      const children: unknown[] = Object.values(value);
      for (const child of children)
        if (child !== null && typeof child === 'object')
          pendingObjects.push(child);
    }
    this.#state = Object.freeze(state);
    this.#pending += 1;
    const pending = this.#tail.then(async () => {
      if (this.#failure !== null) throw this.#failure;
      const result = await this.store.commit({
        ownerToken: this.lease.token,
        runId: this.runId,
        expectedRevision: this.#checkpoint?.revision ?? null,
        status: state.control.status,
        rootGoalRef: state.control.rootGoalRef,
        currentGoalRef: state.decision.context.graph.currentGoalRef,
        stateSchemaVersion: runtimeStateSchemaVersion,
        state: checkpointState,
        records,
      });
      if (result.outcome === 'conflict')
        throw new ContractError(
          validation.code,
          validation.stage,
          '/revision',
          'store_conflict',
        );
      this.#checkpoint = result.checkpoint;
      this.#committedState = state;
      for (const record of result.records) {
        for (const listener of [...this.#listeners]) {
          try {
            // Async subscriber failures must also remain outside the transaction.
            void Promise.resolve(listener(record)).catch(() =>
              this.report('subscriber_failed', record.eventId),
            );
          } catch {
            this.report('subscriber_failed', record.eventId);
          }
        }
      }
      if (
        state.control.status === 'paused' ||
        state.control.status === 'cancelled' ||
        state.control.status === 'succeeded' ||
        state.control.status === 'failed'
      ) {
        this.#resolveResult(state.control);
      }
    });
    this.#tail = pending.then(
      () => {
        this.#pending -= 1;
      },
      (error: unknown) => {
        this.#pending -= 1;
        if (this.#failure !== null) return;
        const code =
          error instanceof ContractError && error.reason === 'store_conflict'
            ? 'store_conflict'
            : 'store_failed';
        this.fail(code);
      },
    );
    return pending;
  }

  event(type: string, reasonCode: string, details: JsonObject): RunRecordDraft {
    return {
      formatVersion: 1,
      runId: this.runId,
      eventId: randomUUID(),
      kind: 'coreEvent',
      data: {
        source: 'core',
        type,
        reasonCode,
        goalRef: this.#state.decision.context.graph.currentGoalRef,
        requestId:
          typeof details.requestId === 'string' ? details.requestId : null,
        decisionId:
          typeof details.decisionId === 'string' ? details.decisionId : null,
        executionId:
          typeof details.executionId === 'string' ? details.executionId : null,
        details,
      },
    };
  }

  subscribe(listener: (record: RunRecord) => void): () => void {
    this.ensureOpen();
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    if (
      this.#pending > 0 ||
      this.#executionOwned ||
      (this.#failure === null &&
        ['running', 'pausing', 'cancelling'].includes(
          this.#state.control.status,
        ))
    ) {
      throw new ContractError(
        validation.code,
        validation.stage,
        '/status',
        'run_active',
      );
    }
    this.#closed = true;
    this.lease.signal.removeEventListener('abort', this.#ownershipLost);
    this.#controller.abort();
    this.#listeners.clear();
    this.#closing = this.lease.release();
    await this.#closing;
  }

  private fail(code: 'store_failed' | 'store_conflict'): void {
    if (this.#failure !== null || this.#closed) return;
    this.#failure = new ContractError(
      validation.code,
      validation.stage,
      '/store',
      code,
    );
    this.#controller.abort();
    this.#rejectResult(this.#failure);
    this.report(code, null);
  }

  private beginInterval(): void {
    this.#controller = new AbortController();
    this.#result = new Promise((resolve, reject) => {
      this.#resolveResult = resolve;
      this.#rejectResult = reject;
    });
    // Callers may obtain result after an initialization failure has already occurred.
    void this.#result.catch(() => undefined);
  }

  report(code: RuntimeDiagnostic['code'], eventId: string | null): void {
    try {
      void Promise.resolve(
        this.diagnose({ code, runId: this.runId, eventId }),
      ).catch(() => undefined);
    } catch {
      // Diagnostic observers cannot recursively fail the writer they observe.
    }
  }

  private ensureOpen(): void {
    if (this.#closed)
      throw new ContractError(
        validation.code,
        validation.stage,
        '',
        'run_closed',
      );
    if (this.#failure !== null) throw this.#failure;
  }
}
