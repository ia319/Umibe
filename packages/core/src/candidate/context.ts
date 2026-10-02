import type {
  ActionCapability,
  CandidateRequest,
} from '#internal/contracts/adapters';
import type { CandidateGenerationInput } from '#internal/contracts/candidate-processing';
import type { CandidateSet } from '#internal/contracts/candidate';
import { ContractError } from '#internal/errors';
import { parseApplicationEvent } from '#internal/validation/event';
import {
  requireInteger,
  requireKeys,
  requireObject,
  requireString,
} from '#internal/validation/fields';
import type { FieldContext } from '#internal/validation/fields';
import { parseGoalGraph } from '#internal/validation/goal';
import { isJsonArray, parseJsonValue } from '#internal/validation/json';
import { parseObservation } from '#internal/validation/observation';
import { readActionResult } from '#internal/validation/record';
import { readGoalRef, readPlanRef } from '#internal/validation/references';

const context: FieldContext = {
  code: 'INVALID_CANDIDATE_REQUEST',
  stage: 'candidate_request',
};

/** Validate and detach a request; each stage checks lifecycle and plan availability. */
export function captureDecisionRequest(
  input: Omit<CandidateRequest, 'capabilities'>,
): Omit<CandidateRequest, 'capabilities'> {
  const object = requireObject(
    parseJsonValue(input, context.stage),
    context,
    '',
  );
  requireKeys(object, ['requestId', 'decisionEpoch', 'context'], context, '');
  const raw = requireObject(object.context, context, '/context');
  requireKeys(
    raw,
    [
      'graph',
      'planRef',
      'planGuidance',
      'observation',
      'constraintsVersion',
      'effectiveConstraints',
      'lastActionResult',
      'recentEvents',
    ],
    context,
    '/context',
  );
  const rawGraph = requireObject(raw.graph, context, '/context/graph');
  requireKeys(
    rawGraph,
    ['runId', 'rootGoalRef', 'currentGoalRef', 'goals', 'goalPath'],
    context,
    '/context/graph',
  );
  const graph = parseGoalGraph({
    runId: rawGraph.runId,
    rootGoalRef: rawGraph.rootGoalRef,
    currentGoalRef: rawGraph.currentGoalRef,
    goals: rawGraph.goals,
  });
  if (!isJsonArray(rawGraph.goalPath)) {
    throw new ContractError(
      context.code,
      context.stage,
      '/context/graph/goalPath',
      'expected_array',
    );
  }
  const suppliedPath = rawGraph.goalPath.map((ref, index) =>
    readGoalRef(ref, context, `/context/graph/goalPath/${index}`),
  );
  if (
    suppliedPath.length !== graph.goalPath.length ||
    suppliedPath.some(
      (ref, index) =>
        ref.id !== graph.goalPath[index]?.id ||
        ref.version !== graph.goalPath[index]?.version,
    )
  ) {
    throw new ContractError(
      context.code,
      context.stage,
      '/context/graph/goalPath',
      'goal_path_mismatch',
    );
  }
  const planRef =
    raw.planRef === null
      ? null
      : readPlanRef(raw.planRef, context, '/context/planRef');
  if (
    planRef !== null &&
    planRef.rootGoalVersion !== graph.rootGoalRef.version
  ) {
    throw new ContractError(
      context.code,
      context.stage,
      '/context/planRef/rootGoalVersion',
      'stale_root_version',
    );
  }
  const observation = parseObservation(raw.observation);
  if (observation.runId !== graph.runId) {
    throw new ContractError(
      context.code,
      context.stage,
      '/context/observation/runId',
      'cross_run_observation',
    );
  }
  if (!isJsonArray(raw.recentEvents)) {
    throw new ContractError(
      context.code,
      context.stage,
      '/context/recentEvents',
      'expected_array',
    );
  }
  const recentEvents = raw.recentEvents.map((value, index) => {
    const event = parseApplicationEvent(value);
    if (event.runId !== graph.runId) {
      throw new ContractError(
        context.code,
        context.stage,
        `/context/recentEvents/${index}/runId`,
        'cross_run_event',
      );
    }
    return event;
  });
  return Object.freeze({
    requestId: requireString(object.requestId, context, '/requestId'),
    decisionEpoch: requireInteger(
      object.decisionEpoch,
      0,
      context,
      '/decisionEpoch',
    ),
    context: Object.freeze({
      graph,
      planRef,
      planGuidance:
        raw.planGuidance === null
          ? null
          : requireString(raw.planGuidance, context, '/context/planGuidance'),
      observation,
      constraintsVersion: requireInteger(
        raw.constraintsVersion,
        1,
        context,
        '/context/constraintsVersion',
      ),
      effectiveConstraints: requireObject(
        raw.effectiveConstraints,
        context,
        '/context/effectiveConstraints',
      ),
      lastActionResult:
        raw.lastActionResult === null
          ? null
          : readActionResult(
              raw.lastActionResult,
              context,
              '/context/lastActionResult',
            ),
      recentEvents: Object.freeze(recentEvents),
    }),
  });
}

/** Generation requires an accepted plan and an active root-to-current path. */
export function captureCandidateRequest(
  input: CandidateGenerationInput,
  capabilities: readonly ActionCapability[],
): CandidateRequest {
  const request = captureDecisionRequest(input);
  const current = request.context;
  const activeIds = new Set(current.graph.goalPath.map((ref) => ref.id));
  for (const [index, goal] of current.graph.goals.entries()) {
    if (
      activeIds.has(goal.id) &&
      goal.lifecycle !== 'pending' &&
      goal.lifecycle !== 'inProgress'
    ) {
      throw new ContractError(
        context.code,
        context.stage,
        `/context/graph/goals/${index}/lifecycle`,
        'inactive_goal_path',
      );
    }
  }
  if (current.planRef === null) {
    throw new ContractError(
      context.code,
      context.stage,
      '/context/planRef',
      'missing_plan',
    );
  }
  return Object.freeze({ ...request, capabilities });
}

/** Provider path labels are opaque; the full sequence must match the derived path. */
export function validateCandidateBasis(
  set: CandidateSet,
  request: CandidateRequest,
): void {
  const current = request.context;
  const expected = {
    runId: current.graph.runId,
    rootGoalRef: current.graph.rootGoalRef,
    currentGoalRef: current.graph.currentGoalRef,
    goalPath: current.graph.goalPath,
    planRef: current.planRef,
    observationRef: {
      id: current.observation.id,
      revision: current.observation.revision,
    },
    constraintsVersion: current.constraintsVersion,
  };
  for (const key of [
    'runId',
    'rootGoalRef',
    'currentGoalRef',
    'goalPath',
    'planRef',
    'observationRef',
    'constraintsVersion',
  ] as const) {
    // These records contain validated refs with a fixed field order, not arbitrary JSON.
    if (JSON.stringify(set[key]) !== JSON.stringify(expected[key])) {
      throw new ContractError(
        'INVALID_CANDIDATES',
        'candidate_basis',
        `/${key}`,
        'request_basis_mismatch',
      );
    }
  }
}
