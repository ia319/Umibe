import { z } from 'zod';
import { ContractError } from '#internal/errors';
import { captureDecisionRequest } from '#internal/candidate/context';
import { canonicalJson } from '#internal/candidate/identity';
import { parseJsonValue } from '#internal/validation/json';
import { parseGoalGraph, readGoalRecord } from '#internal/validation/goal';
import { parseRecordedChange } from '#internal/validation/changes';
import { requireObject, requireTimestamp } from '#internal/validation/fields';
import { parsePlanProposal } from '#internal/planner/validation';
import {
  parseRunCheckpoint,
  readActionIntent,
  readActionResult,
} from '#internal/validation/record';
import type { RunCheckpoint } from '#internal/contracts/record';
import type { SessionState } from './session.js';
import { captureLimits } from './limits.js';
import { readChoiceHistory } from '#internal/validation/choice-history';

export const runtimeStateSchemaVersion = 6;
const context = {
  code: 'INVALID_RUN_CHECKPOINT',
  stage: 'runtime_checkpoint',
} as const;
const text = z.string().min(1);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ref = z.strictObject({ id: text, version: count.min(1) });
const planRef = z.strictObject({
  id: text,
  version: count.min(1),
  rootGoalVersion: count.min(1),
});
const cause = z.strictObject({ eventId: text, reasonCode: text }).nullable();
const stage = z.enum([
  'decision',
  'planning',
  'selection',
  'candidates',
  'verification',
]);
const timestamp = z
  .unknown()
  .transform((value) =>
    requireTimestamp(parseJsonValue(value, context.stage), context, ''),
  );
const jsonObject = z
  .unknown()
  .transform((value) =>
    requireObject(parseJsonValue(value, context.stage), context, ''),
  );
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
const graph = z
  .strictObject({
    runId: text,
    rootGoalRef: ref,
    currentGoalRef: ref,
    goals: z.array(z.unknown()),
    goalPath: z.array(ref),
  })
  .transform((value) => {
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
    kind: z.literal('decision'),
    requestId: text,
    goalRef: ref,
  }),
  z.strictObject({
    kind: z.literal('initial'),
    assessment: z.literal('notYet'),
  }),
  z.strictObject({ kind: z.literal('planInvalidated'), eventId: text }),
  z.strictObject({ kind: z.literal('branchExhausted'), goalRef: ref }),
  z.strictObject({
    kind: z.literal('selectionUnavailable'),
    goalRef: ref,
    reason: z.enum(['abstain', 'no_candidates']),
    attempts: count,
  }),
  z.strictObject({
    kind: z.literal('recoveryExhausted'),
    goalRef: ref,
    failures: count,
  }),
]);
const childGoal = z.unknown().transform((value) => {
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
});
const plannerRequest = z
  .strictObject({
    requestId: text,
    decisionEpoch: count,
    context: z.unknown(),
    capabilities: z.array(
      z.strictObject({
        id: text,
        version: count.min(1),
        description: text,
        parameters: jsonObject,
        expectedEffects: jsonObject,
        tags: z.array(text),
      }),
    ),
    trigger,
    pendingGoals: z.array(childGoal).optional(),
  })
  .transform(
    ({
      requestId,
      decisionEpoch,
      context: requestContext,
      pendingGoals,
      ...remaining
    }) => ({
      ...captureDecisionRequest({
        requestId,
        decisionEpoch,
        context: requestContext,
      }),
      ...remaining,
      ...(pendingGoals === undefined ? {} : { pendingGoals }),
    }),
  );
const pendingProposal = z
  .strictObject({
    proposalId: text,
    request: plannerRequest,
    proposal: z.unknown(),
    receivedAt: timestamp,
  })
  .transform((value) => ({
    ...value,
    proposal: parsePlanProposal(value.proposal, value.request, {
      maxNewGoals: null,
      maxTotalGoals: null,
      maxDepth: null,
    }),
  }));
const pendingAdoption = z.strictObject({
  proposalId: text,
  executionId: text,
  decisionRequestId: text,
  decisionEventId: text,
  basis: z.strictObject({
    runId: text,
    decisionEpoch: count,
    rootGoalRef: ref,
    currentGoalRef: ref,
    goalPath: z.array(ref).min(1),
    planRef: planRef.nullable(),
    constraintsVersion: count.min(1),
    observationRef: z.strictObject({ id: text, revision: count }),
    reviewVersion: count,
    throughSequence: count,
    operationSetId: text,
    executionId: text.nullable(),
    selectionId: text.nullable(),
    proposalId: text.nullable(),
  }),
  acceptedAt: timestamp,
});
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
      maxModelAttempts: count.nullable(),
      modelTimeoutMs: count.min(1),
      modelRetries: count,
      callbackTimeoutMs: count.min(1),
      verificationTimeoutMs: count.min(1),
      maxActionAttempts: count.nullable(),
      actionTimeoutMs: count.min(1),
      stopGraceMs: count.min(1),
      actionRetries: count,
      maxGoalDepth: count.nullable(),
      maxSubgoals: count.nullable(),
      maxNoProgress: count.min(1).nullable(),
      maxRecoveryAttempts: count.min(1).nullable(),
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
      progress: jsonObject,
      stopCause: cause,
      continuation: z
        .strictObject({
          executionId: text,
          decisionRequestId: text,
          decisionEventId: text,
          decisionEpoch: count,
          planRef,
          authorizedAt: timestamp,
        })
        .nullable(),
    })
    .nullable(),
  pendingProposal: pendingProposal.nullable(),
  pendingAdoption: pendingAdoption.nullable(),
  scheduling: z.strictObject({
    policyVersion: z.literal(2),
    reviewPending: z.boolean(),
    reviewVersion: count.min(1),
    reviewIntervalMs: count.min(1).max(2_147_483_647).nullable(),
    minDecisionIntervalMs: count.max(2_147_483_647),
    lastDecisionStartedAt: timestamp.nullable(),
    planning: trigger.nullable(),
    planningVersion: count.min(1),
  }),
  observations: z.strictObject({
    initialized: z.boolean(),
    eventSequence: count,
    lastReviewedEventSequence: count,
    unreadChanges: z.array(z.unknown().transform(parseRecordedChange)),
  }),
  goals: z.strictObject({
    created: count,
    order: z.array(ref),
    pending: z.array(childGoal),
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
  recentChoices: z
    .unknown()
    .transform((value) => readChoiceHistory(value, context, '/recentChoices')),
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
    const observations = state.observations;
    if (
      !same(state.recentChoices, state.decision.context.runtime?.recentChoices)
    )
      fail(
        '/decision/context/runtime/recentChoices',
        'choice_history_mismatch',
      );
    if (!observations.initialized) {
      const observation = state.decision.context.observation;
      if (
        !['created', 'pausing', 'paused', 'cancelling', 'cancelled'].includes(
          state.control.status,
        ) ||
        state.modelAttempts !== 0 ||
        state.actionAttempts !== 0 ||
        state.pendingModels.length !== 0 ||
        state.execution !== null ||
        state.pendingProposal !== null ||
        state.pendingAdoption !== null ||
        state.scheduling.lastDecisionStartedAt !== null ||
        state.recentResults.length !== 0 ||
        state.recentChoices.length !== 0 ||
        state.decision.context.lastActionResult !== null ||
        observations.lastReviewedEventSequence !== 0
      )
        fail('/observations/initialized', 'work_before_initial_observation');
      if (
        observation.source !== 'core:initialization' ||
        observation.revision !== 0 ||
        observation.coverage.scope !== 'initialization' ||
        observation.coverage.completeness !== 'partial' ||
        !same(observation.coverage.uncheckedScopes, ['environment']) ||
        Object.keys(observation.data).length !== 0
      )
        fail('/decision/context/observation', 'invalid_initialization_marker');
    }
    if (
      observations.lastReviewedEventSequence > observations.eventSequence ||
      observations.unreadChanges.length !==
        observations.eventSequence - observations.lastReviewedEventSequence ||
      observations.unreadChanges.some(
        (change, index) =>
          change.sequence !==
          observations.lastReviewedEventSequence + index + 1,
      )
    )
      fail('/observations', 'invalid_unread_sequence');
    if (
      observations.unreadChanges.length > 0 &&
      !state.scheduling.reviewPending
    )
      fail('/scheduling/reviewPending', 'unread_changes_without_review');
    if (!same(state.control.rootGoalRef, current.rootGoalRef))
      fail('/control/rootGoalRef', 'root_mismatch');
    if (
      state.pendingProposal !== null &&
      (state.pendingProposal.request.context.graph.runId !== current.runId ||
        state.pendingProposal.request.decisionEpoch >
          state.decision.decisionEpoch ||
        state.pendingProposal.request.pendingGoals?.some(
          (goal) => goal.runId !== current.runId,
        ))
    )
      fail('/pendingProposal/request', 'invalid_planning_basis');
    if (state.pendingAdoption !== null) {
      const adoption = state.pendingAdoption;
      const proposal = state.pendingProposal;
      const basis = adoption.basis;
      if (
        proposal === null ||
        adoption.proposalId !== proposal.proposalId ||
        basis.proposalId !== adoption.proposalId ||
        basis.executionId !== adoption.executionId ||
        adoption.executionId !== state.execution?.intent.executionId ||
        basis.runId !== current.runId ||
        basis.decisionEpoch < proposal.request.decisionEpoch ||
        basis.decisionEpoch > state.decision.decisionEpoch ||
        basis.reviewVersion > state.scheduling.reviewVersion ||
        basis.throughSequence > observations.lastReviewedEventSequence ||
        !same(basis.rootGoalRef, proposal.request.context.graph.rootGoalRef) ||
        !same(
          basis.currentGoalRef,
          proposal.request.context.graph.currentGoalRef,
        ) ||
        !same(basis.goalPath, proposal.request.context.graph.goalPath) ||
        !same(basis.planRef, proposal.request.context.planRef) ||
        basis.constraintsVersion !== proposal.request.context.constraintsVersion
      )
        fail('/pendingAdoption', 'adoption_basis_mismatch');
    }
    const children = new Set(
      [
        ...current.goals.filter((goal) => goal.kind === 'child'),
        ...state.goals.pending,
      ].map((goal) => goal.id),
    );
    if (
      state.goals.created < children.size ||
      (state.limits.maxSubgoals !== null &&
        state.goals.created > state.limits.maxSubgoals)
    )
      fail('/goals/created', 'invalid_subgoal_count');
    if (
      (state.limits.maxModelAttempts !== null &&
        state.modelAttempts > state.limits.maxModelAttempts) ||
      (state.limits.maxActionAttempts !== null &&
        state.actionAttempts > state.limits.maxActionAttempts)
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
        !same(execution.intent.observationRef, {
          id: basis.observation.id,
          revision: basis.observation.revision,
        }) ||
        execution.intent.constraintsVersion !== basis.constraintsVersion
      )
        fail('/execution/basis', 'execution_basis_mismatch');
      const continuation = execution.continuation;
      if (
        continuation !== null &&
        (continuation.executionId !== execution.intent.executionId ||
          continuation.decisionEpoch <= execution.decisionEpoch ||
          continuation.decisionEpoch > state.decision.decisionEpoch ||
          continuation.planRef.rootGoalVersion !==
            execution.intent.rootGoalRef.version)
      )
        fail('/execution/continuation', 'continuation_basis_mismatch');
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
