import { z } from 'zod';
import { ContractError } from '#internal/errors';
import { captureDecisionRequest } from '#internal/candidate/context';
import { canonicalJson } from '#internal/candidate/identity';
import { parseJsonValue } from '#internal/validation/json';
import { parseGoalGraph, readGoalRecord } from '#internal/validation/goal';
import {
  parseRunCheckpoint,
  readActionIntent,
  readActionResult,
} from '#internal/validation/record';
import type { RunCheckpoint } from '#internal/contracts/record';
import type { SessionState } from './session.js';
import { captureLimits } from './limits.js';

export const runtimeStateSchemaVersion = 2;
const context = {
  code: 'INVALID_RUN_CHECKPOINT',
  stage: 'runtime_checkpoint',
} as const;
const text = z.string().min(1);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ref = z.strictObject({ id: text, version: count.min(1) });
const cause = z.strictObject({ eventId: text, reasonCode: text }).nullable();
const stage = z.enum(['planning', 'selection', 'candidates', 'verification']);
const identity = z
  .strictObject({
    applicationId: text.nullable(),
    actionVersions: z
      .array(z.strictObject({ id: text, version: count.min(1) }).readonly())
      .readonly(),
    modelStages: z.array(stage).readonly(),
  })
  .readonly();
export type RuntimeIdentity = z.infer<typeof identity>;
const pendingModel = z
  .strictObject({
    requestId: text,
    decisionEpoch: count,
    purpose: stage,
    attempt: count.min(1),
    phase: z.enum(['reserved', 'dispatched']),
  })
  .readonly();
export type PendingModelAttempt = z.infer<typeof pendingModel>;
const decision = z.unknown().transform(captureDecisionRequest);
const graph = z.unknown().transform((input) => {
  const value = z.record(z.string(), z.unknown()).parse(input);
  const parsed = parseGoalGraph({
    runId: value.runId,
    rootGoalRef: value.rootGoalRef,
    currentGoalRef: value.currentGoalRef,
    goals: value.goals,
  });
  if (
    canonicalJson(parseJsonValue(value.goalPath, context.stage)) !==
    canonicalJson(parseJsonValue(parsed.goalPath, context.stage))
  )
    throw new ContractError(
      context.code,
      context.stage,
      '/goalPath',
      'goal_path_mismatch',
    );
  return parsed;
});
const result = z
  .unknown()
  .transform((value) =>
    readActionResult(parseJsonValue(value, context.stage), context, '/result'),
  );
const trigger = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('initial'),
    assessment: z.literal('notYet'),
  }),
  z.strictObject({ kind: z.literal('planInvalidated'), eventId: text }),
  z.strictObject({ kind: z.literal('branchExhausted'), goalRef: ref }),
  z.strictObject({
    kind: z.literal('recoveryExhausted'),
    goalRef: ref,
    failures: count,
  }),
]);
const schema = z.strictObject({
  identity,
  pendingModels: z.array(pendingModel),
  control: z.strictObject({
    status: z.enum([
      'created',
      'running',
      'pausing',
      'paused',
      'cancelling',
      'cancelled',
      'succeeded',
      'failed',
    ]),
    rootGoalRef: ref,
    stopCause: cause,
    blocker: cause,
  }),
  decision,
  limits: z
    .strictObject({
      maxModelAttempts: count,
      modelTimeoutMs: count.min(1),
      modelRetries: count,
      callbackTimeoutMs: count.min(1),
      verificationTimeoutMs: count.min(1),
      maxActionAttempts: count,
      actionTimeoutMs: count.min(1),
      stopGraceMs: count.min(1),
      actionRetries: count,
      maxGoalDepth: count,
      maxSubgoals: count,
      maxNoProgress: count.min(1),
      maxRecoveryAttempts: count.min(1),
    })
    .transform(captureLimits),
  modelAttempts: count,
  actionAttempts: count,
  execution: z
    .strictObject({
      intent: z
        .unknown()
        .transform((value) =>
          readActionIntent(parseJsonValue(value, context.stage)),
        ),
      basis: decision,
      retryMode: z.enum(['never', 'idempotent', 'reconcile']),
      decisionEpoch: count,
      phase: z.enum([
        'prepared',
        'running',
        'succeeded',
        'failed',
        'cancelled',
        'unknown',
      ]),
      result: result.nullable(),
      retries: count,
      reconciliation: z.enum(['performed', 'notPerformed']).nullable(),
    })
    .nullable(),
  scheduling: z.strictObject({
    policyVersion: z.literal(1),
    planning: trigger.nullable(),
    recoveryAttempts: count,
    lastSelectionBasis: text.nullable(),
    selectionCause: z.enum([
      'initial',
      'action_completed',
      'candidates_changed',
      'resumed',
      'remedy',
    ]),
  }),
  goals: z.strictObject({
    created: count,
    order: z.array(ref),
    pending: z.array(
      z.unknown().transform((value) => {
        const goal = readGoalRecord(
          parseJsonValue(value, context.stage),
          '/goals/pending',
        );
        if (goal.kind !== 'child')
          throw new ContractError(
            context.code,
            context.stage,
            '/goals/pending',
            'expected_child',
          );
        return goal;
      }),
    ),
  }),
  progress: z.array(
    z.strictObject({
      goalRef: ref,
      noProgress: count,
      recoveryAttempts: count,
      recoveryPlanned: z.boolean(),
      highWater: z.number().finite().nullable(),
      achieved: z.array(text),
    }),
  ),
  progressAttempt: z
    .strictObject({
      before: graph,
      failed: z.boolean(),
      executionId: text.nullable(),
    })
    .nullable(),
  recentResults: z.array(result).max(50),
});

/** Validate persisted state without applying defaults, running adapters or granting execution. */
export function parseRuntimeState(input: unknown): SessionState {
  try {
    const state = schema.parse(parseJsonValue(input, context.stage));
    const current = state.decision.context.graph;
    const fail = (path: string, reason: string): never => {
      throw new ContractError(context.code, context.stage, path, reason);
    };
    const same = (a: unknown, b: unknown) =>
      canonicalJson(parseJsonValue(a, context.stage)) ===
      canonicalJson(parseJsonValue(b, context.stage));
    if (!same(state.control.rootGoalRef, current.rootGoalRef))
      fail('/control/rootGoalRef', 'root_mismatch');
    const children = new Set(
      [
        ...current.goals.filter((goal) => goal.kind === 'child'),
        ...state.goals.pending,
      ].map((goal) => goal.id),
    );
    if (
      state.goals.created < children.size ||
      state.goals.created > state.limits.maxSubgoals
    )
      fail('/goals/created', 'invalid_subgoal_count');
    if (
      state.modelAttempts > state.limits.maxModelAttempts ||
      state.actionAttempts > state.limits.maxActionAttempts
    )
      fail('/limits', 'usage_exceeds_limit');
    if (
      new Set(state.identity.actionVersions.map((action) => action.id)).size !==
      state.identity.actionVersions.length
    )
      fail('/identity/actionVersions', 'duplicate_action');
    const orders = new Set<string>();
    for (const goal of state.goals.order) {
      if (
        orders.has(goal.id) ||
        !current.goals.some(
          (entry) => entry.id === goal.id && entry.version === goal.version,
        )
      )
        fail('/goals/order', 'invalid_goal_order');
      orders.add(goal.id);
    }
    if (state.goals.pending.some((goal) => goal.runId !== current.runId))
      fail('/goals/pending', 'cross_run_goal');
    const requests = new Set<string>();
    for (const request of state.pendingModels) {
      const key = `${request.requestId}:${request.attempt}`;
      if (
        requests.has(key) ||
        request.decisionEpoch > state.decision.decisionEpoch
      )
        fail('/pendingModels', 'invalid_request');
      requests.add(key);
    }
    if (state.pendingModels.length > state.modelAttempts)
      fail('/pendingModels', 'unaccounted_request');
    if (
      state.progressAttempt !== null &&
      state.progressAttempt.before.runId !== current.runId
    )
      fail('/progressAttempt', 'cross_run_progress');
    if (state.execution !== null) {
      const execution = state.execution;
      const basis = execution.basis.context;
      if (
        basis.graph.runId !== current.runId ||
        execution.decisionEpoch !== execution.basis.decisionEpoch ||
        !same(execution.intent.rootGoalRef, basis.graph.rootGoalRef) ||
        !same(execution.intent.currentGoalRef, basis.graph.currentGoalRef) ||
        !same(execution.intent.planRef, basis.planRef) ||
        execution.intent.constraintsVersion !== basis.constraintsVersion
      )
        fail('/execution/basis', 'execution_basis_mismatch');
      if (
        execution.result === null
          ? !['prepared', 'running'].includes(execution.phase)
          : execution.result.executionId !== execution.intent.executionId ||
            execution.phase !== execution.result.outcome
      )
        fail('/execution/result', 'execution_result_mismatch');
      if (
        execution.retries > state.limits.actionRetries ||
        state.actionAttempts < (execution.phase === 'cancelled' ? 0 : 1)
      )
        fail('/execution/retries', 'unaccounted_execution');
    }
    const pending: object[] = [state];
    while (pending.length > 0) {
      const value = pending.pop()!;
      Object.freeze(value);
      const children: unknown[] = Object.values(value);
      for (const child of children)
        if (
          child !== null &&
          typeof child === 'object' &&
          !Object.isFrozen(child)
        )
          pending.push(child);
    }
    return state;
  } catch (error) {
    if (error instanceof ContractError) throw error;
    const issue = error instanceof z.ZodError ? error.issues[0] : undefined;
    throw new ContractError(
      context.code,
      context.stage,
      issue ? `/${issue.path.join('/')}` : '',
      issue?.code ?? 'invalid_state',
    );
  }
}

export type RuntimeCheckpoint = Omit<RunCheckpoint, 'state'> & {
  readonly state: SessionState;
};

/** Decode only supported continuation formats; older state is never guessed or reset. */
export function parseRuntimeCheckpoint(input: unknown): RuntimeCheckpoint {
  const checkpoint = parseRunCheckpoint(input);
  if (checkpoint.stateSchemaVersion !== runtimeStateSchemaVersion)
    throw new ContractError(
      context.code,
      context.stage,
      '/stateSchemaVersion',
      'unsupported_state_version',
    );
  const state = parseRuntimeState(checkpoint.state);
  if (
    state.decision.context.graph.runId !== checkpoint.runId ||
    state.control.status !== checkpoint.status
  )
    throw new ContractError(
      context.code,
      context.stage,
      '/state',
      'checkpoint_state_mismatch',
    );
  return Object.freeze({ ...checkpoint, state });
}
