import type {
  Candidate,
  CandidateCoverage,
  CandidateExclusion,
  CandidateSet,
  ParameterSource,
} from '#internal/contracts/candidate';
import type { JsonValue } from '#internal/contracts/json';
import type { GoalRef } from '#internal/contracts/references';
import { ContractError } from '#internal/errors';
import {
  requireInteger,
  requireKeys,
  requireObject,
  requireString,
} from './fields.js';
import type { FieldContext } from './fields.js';
import { isJsonArray, parseJsonValue } from './json.js';
import { readGoalRef, readObservationRef, readPlanRef } from './references.js';

const context: FieldContext = {
  code: 'INVALID_CANDIDATES',
  stage: 'candidates',
};

function readStringArray(
  value: JsonValue | undefined,
  path: string,
): readonly string[] {
  if (!isJsonArray(value)) {
    throw new ContractError(
      context.code,
      context.stage,
      path,
      'expected_array',
    );
  }
  return Object.freeze(
    value.map((item, index) =>
      requireString(item, context, `${path}/${index}`),
    ),
  );
}

function readCoverage(value: JsonValue | undefined): CandidateCoverage {
  const object = requireObject(value, context, '/coverage');
  requireKeys(
    object,
    [
      'generation',
      'checking',
      'uncheckedScopes',
      'truncated',
      'exclusions',
      'informationGaps',
      'capabilityGaps',
    ],
    context,
    '/coverage',
  );
  const generation = object.generation;
  const checking = object.checking;
  if (
    (generation !== 'complete' && generation !== 'partial') ||
    (checking !== 'complete' && checking !== 'partial') ||
    typeof object.truncated !== 'boolean'
  ) {
    throw new ContractError(
      context.code,
      context.stage,
      '/coverage',
      'invalid_coverage',
    );
  }
  const uncheckedScopes = readStringArray(
    object.uncheckedScopes,
    '/coverage/uncheckedScopes',
  );
  const exclusionsValue = object.exclusions;
  if (!isJsonArray(exclusionsValue)) {
    throw new ContractError(
      context.code,
      context.stage,
      '/coverage/exclusions',
      'expected_array',
    );
  }
  const exclusions: CandidateExclusion[] = exclusionsValue.map(
    (item, index) => {
      const path = `/coverage/exclusions/${index}`;
      const record = requireObject(item, context, path);
      requireKeys(record, ['stage', 'reason', 'count'], context, path);
      const stage = record.stage;
      if (
        stage !== 'generation' &&
        stage !== 'checking' &&
        stage !== 'filtering'
      ) {
        throw new ContractError(
          context.code,
          context.stage,
          `${path}/stage`,
          'invalid_exclusion_stage',
        );
      }
      return Object.freeze({
        stage,
        reason: requireString(record.reason, context, `${path}/reason`),
        count: requireInteger(record.count, 1, context, `${path}/count`),
      });
    },
  );
  if (
    (generation === 'complete' && object.truncated) ||
    ((generation === 'partial' || checking === 'partial') &&
      uncheckedScopes.length === 0 &&
      !object.truncated)
  ) {
    throw new ContractError(
      context.code,
      context.stage,
      '/coverage',
      'inconsistent_coverage',
    );
  }
  if (
    generation === 'complete' &&
    checking === 'complete' &&
    uncheckedScopes.length > 0
  ) {
    throw new ContractError(
      context.code,
      context.stage,
      '/coverage/uncheckedScopes',
      'inconsistent_coverage',
    );
  }
  return Object.freeze({
    generation,
    checking,
    uncheckedScopes,
    truncated: object.truncated,
    exclusions: Object.freeze(exclusions),
    informationGaps: readStringArray(
      object.informationGaps,
      '/coverage/informationGaps',
    ),
    capabilityGaps: readStringArray(
      object.capabilityGaps,
      '/coverage/capabilityGaps',
    ),
  });
}

function sameGoalRef(left: GoalRef, right: GoalRef): boolean {
  return left.id === right.id && left.version === right.version;
}

type CandidateBasis = Pick<
  CandidateSet,
  | 'id'
  | 'currentGoalRef'
  | 'goalPathRef'
  | 'planRef'
  | 'observationRef'
  | 'constraintsVersion'
>;

function readCandidate(
  value: JsonValue,
  index: number,
  set: CandidateBasis,
): Candidate {
  const path = `/candidates/${index}`;
  const object = requireObject(value, context, path);
  requireKeys(
    object,
    [
      'id',
      'candidateSetId',
      'actionId',
      'actionVersion',
      'params',
      'paramSources',
      'description',
      'expectedEffects',
      'cost',
      'risk',
      'source',
      'goalRef',
      'goalPathRef',
      'planRef',
      'observationRef',
      'constraintsVersion',
    ],
    context,
    path,
  );
  const goalRef = readGoalRef(object.goalRef, context, `${path}/goalRef`);
  const planRef = readPlanRef(object.planRef, context, `${path}/planRef`);
  const observationRef = readObservationRef(
    object.observationRef,
    context,
    `${path}/observationRef`,
  );
  const params = requireObject(object.params, context, `${path}/params`);
  const sourceObject = requireObject(
    object.paramSources,
    context,
    `${path}/paramSources`,
  );
  const paramSources: Record<string, ParameterSource> = {};
  if (
    Object.keys(sourceObject).length !== Object.keys(params).length ||
    Object.keys(params).some((key) => !Object.hasOwn(sourceObject, key))
  ) {
    throw new ContractError(
      context.code,
      context.stage,
      `${path}/paramSources`,
      'parameter_source_mismatch',
    );
  }
  for (const [key, value] of Object.entries(sourceObject)) {
    const sourcePath = `${path}/paramSources/${key}`;
    const record = requireObject(value, context, sourcePath);
    requireKeys(record, ['kind', 'reference'], context, sourcePath);
    const kind = record.kind;
    if (
      kind !== 'observation' &&
      kind !== 'application' &&
      kind !== 'model' &&
      kind !== 'default'
    ) {
      throw new ContractError(
        context.code,
        context.stage,
        `${sourcePath}/kind`,
        'invalid_parameter_source',
      );
    }
    paramSources[key] = Object.freeze({
      kind,
      reference: requireString(
        record.reference,
        context,
        `${sourcePath}/reference`,
      ),
    });
  }
  const candidate: Candidate = Object.freeze({
    id: requireString(object.id, context, `${path}/id`),
    candidateSetId: requireString(
      object.candidateSetId,
      context,
      `${path}/candidateSetId`,
    ),
    actionId: requireString(object.actionId, context, `${path}/actionId`),
    actionVersion: requireInteger(
      object.actionVersion,
      1,
      context,
      `${path}/actionVersion`,
    ),
    params,
    paramSources: Object.freeze(paramSources),
    description: requireString(
      object.description,
      context,
      `${path}/description`,
    ),
    expectedEffects: requireObject(
      object.expectedEffects,
      context,
      `${path}/expectedEffects`,
    ),
    cost: object.cost!,
    risk: object.risk!,
    source: requireString(object.source, context, `${path}/source`),
    goalRef,
    goalPathRef: requireString(
      object.goalPathRef,
      context,
      `${path}/goalPathRef`,
    ),
    planRef,
    observationRef,
    constraintsVersion: requireInteger(
      object.constraintsVersion,
      1,
      context,
      `${path}/constraintsVersion`,
    ),
  });
  if (
    candidate.candidateSetId !== set.id ||
    !sameGoalRef(goalRef, set.currentGoalRef) ||
    candidate.goalPathRef !== set.goalPathRef ||
    planRef.id !== set.planRef.id ||
    planRef.version !== set.planRef.version ||
    planRef.rootGoalVersion !== set.planRef.rootGoalVersion ||
    observationRef.id !== set.observationRef.id ||
    observationRef.revision !== set.observationRef.revision ||
    candidate.constraintsVersion !== set.constraintsVersion
  ) {
    throw new ContractError(
      context.code,
      context.stage,
      path,
      'candidate_basis_mismatch',
    );
  }
  return candidate;
}

/** Validate one provider result and its binding to a single decision basis.
 * @param input - Untrusted candidate-set data.
 * @returns A detached, frozen candidate set.
 * @throws ContractError for malformed data, inconsistent context or duplicate IDs.
 */
export function parseCandidateSet(input: unknown): CandidateSet {
  const object = requireObject(
    parseJsonValue(input, context.stage),
    context,
    '',
  );
  requireKeys(
    object,
    [
      'id',
      'runId',
      'rootGoalRef',
      'currentGoalRef',
      'goalPathRef',
      'goalPath',
      'planRef',
      'observationRef',
      'constraintsVersion',
      'coverage',
      'candidates',
    ],
    context,
    '',
  );
  const pathValue = object.goalPath;
  if (!isJsonArray(pathValue) || pathValue.length === 0) {
    throw new ContractError(
      context.code,
      context.stage,
      '/goalPath',
      'expected_nonempty_array',
    );
  }
  const goalPath = Object.freeze(
    pathValue.map((item, index) =>
      readGoalRef(item, context, `/goalPath/${index}`),
    ),
  );
  const rootGoalRef = readGoalRef(object.rootGoalRef, context, '/rootGoalRef');
  const currentGoalRef = readGoalRef(
    object.currentGoalRef,
    context,
    '/currentGoalRef',
  );
  const planRef = readPlanRef(object.planRef, context, '/planRef');
  if (
    !sameGoalRef(goalPath[0]!, rootGoalRef) ||
    !sameGoalRef(goalPath[goalPath.length - 1]!, currentGoalRef) ||
    planRef.rootGoalVersion !== rootGoalRef.version ||
    new Set(goalPath.map((ref) => ref.id)).size !== goalPath.length
  ) {
    throw new ContractError(
      context.code,
      context.stage,
      '/goalPath',
      'invalid_goal_path_basis',
    );
  }
  const candidateValues = object.candidates;
  if (!isJsonArray(candidateValues)) {
    throw new ContractError(
      context.code,
      context.stage,
      '/candidates',
      'expected_array',
    );
  }
  const base = {
    id: requireString(object.id, context, '/id'),
    runId: requireString(object.runId, context, '/runId'),
    rootGoalRef,
    currentGoalRef,
    goalPathRef: requireString(object.goalPathRef, context, '/goalPathRef'),
    goalPath,
    planRef,
    observationRef: readObservationRef(
      object.observationRef,
      context,
      '/observationRef',
    ),
    constraintsVersion: requireInteger(
      object.constraintsVersion,
      1,
      context,
      '/constraintsVersion',
    ),
    coverage: readCoverage(object.coverage),
  };
  const candidates = candidateValues.map((item, index) =>
    readCandidate(item, index, base),
  );
  const seen = new Set<string>();
  for (const [index, candidate] of candidates.entries()) {
    if (seen.has(candidate.id)) {
      throw new ContractError(
        context.code,
        context.stage,
        `/candidates/${index}/id`,
        'duplicate_candidate_id',
      );
    }
    seen.add(candidate.id);
  }
  return Object.freeze({ ...base, candidates: Object.freeze(candidates) });
}
