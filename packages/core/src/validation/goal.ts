import type {
  ChildGoalRecord,
  GoalGraph,
  GoalGraphSnapshot,
  GoalLifecycle,
  GoalRecord,
  RootGoalRecord,
} from '#internal/contracts/goal';
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
import { readGoalAssessment } from './assessment.js';
import { readGoalRef, readPlanRef } from './references.js';

const context: FieldContext = {
  code: 'INVALID_GOAL_GRAPH',
  stage: 'goal_graph',
};

export function readGoalRecord(value: JsonValue, path: string): GoalRecord {
  const object = requireObject(value, context, path);
  const common = [
    'kind',
    'runId',
    'id',
    'version',
    'description',
    'criteria',
    'parentGoalRef',
    'acceptedPlanRef',
    'lifecycle',
    'lastAssessment',
  ];
  const kind = object.kind;
  if (kind !== 'root' && kind !== 'child') {
    throw new ContractError(
      context.code,
      context.stage,
      `${path}/kind`,
      'invalid_goal_kind',
    );
  }
  requireKeys(
    object,
    kind === 'root'
      ? [...common, 'hardConstraints', 'limits', 'preferences']
      : common,
    context,
    path,
  );
  const criteria = object.criteria;
  if (criteria === null || criteria === undefined) {
    throw new ContractError(
      context.code,
      context.stage,
      `${path}/criteria`,
      'missing_criteria',
    );
  }
  const lifecycle = object.lifecycle;
  if (
    lifecycle !== 'pending' &&
    lifecycle !== 'inProgress' &&
    lifecycle !== 'succeeded' &&
    lifecycle !== 'cancelled' &&
    lifecycle !== 'superseded'
  ) {
    throw new ContractError(
      context.code,
      context.stage,
      `${path}/lifecycle`,
      'invalid_lifecycle',
    );
  }
  const acceptedLifecycle: GoalLifecycle = lifecycle;
  const base = {
    runId: requireString(object.runId, context, `${path}/runId`),
    id: requireString(object.id, context, `${path}/id`),
    version: requireInteger(object.version, 1, context, `${path}/version`),
    description: requireString(
      object.description,
      context,
      `${path}/description`,
    ),
    criteria,
    lifecycle: acceptedLifecycle,
    lastAssessment:
      object.lastAssessment === null
        ? null
        : readGoalAssessment(
            object.lastAssessment,
            context,
            `${path}/lastAssessment`,
          ),
  };

  if (kind === 'root') {
    if (object.parentGoalRef !== null || object.acceptedPlanRef !== null) {
      throw new ContractError(
        context.code,
        context.stage,
        path,
        'root_has_parent_or_plan',
      );
    }
    if (
      !isJsonArray(object.hardConstraints) ||
      !isJsonArray(object.preferences)
    ) {
      throw new ContractError(
        context.code,
        context.stage,
        path,
        'expected_constraint_arrays',
      );
    }
    const record: RootGoalRecord = Object.freeze({
      ...base,
      kind,
      parentGoalRef: null,
      acceptedPlanRef: null,
      hardConstraints: object.hardConstraints,
      limits: requireObject(object.limits, context, `${path}/limits`),
      preferences: object.preferences,
    });
    return record;
  }

  const record: ChildGoalRecord = Object.freeze({
    ...base,
    kind,
    parentGoalRef: readGoalRef(
      object.parentGoalRef,
      context,
      `${path}/parentGoalRef`,
    ),
    acceptedPlanRef: readPlanRef(
      object.acceptedPlanRef,
      context,
      `${path}/acceptedPlanRef`,
    ),
  });
  return record;
}

function deriveGoalPath(graph: GoalGraph): readonly GoalRef[] {
  const nodes = new Map<string, { record: GoalRecord; index: number }>();
  let root: RootGoalRecord | undefined;

  for (const [index, record] of graph.goals.entries()) {
    const path = `/goals/${index}`;
    if (record.runId !== graph.runId) {
      throw new ContractError(
        context.code,
        context.stage,
        `${path}/runId`,
        'cross_run_goal',
      );
    }
    if (nodes.has(record.id)) {
      throw new ContractError(
        context.code,
        context.stage,
        `${path}/id`,
        'duplicate_goal_id',
      );
    }
    nodes.set(record.id, { record, index });
    if (record.kind === 'root') {
      if (root !== undefined) {
        throw new ContractError(
          context.code,
          context.stage,
          path,
          'multiple_roots',
        );
      }
      root = record;
    }
    if (
      record.lastAssessment !== null &&
      (record.lastAssessment.goalRef.id !== record.id ||
        record.lastAssessment.goalRef.version !== record.version)
    ) {
      throw new ContractError(
        context.code,
        context.stage,
        `${path}/lastAssessment/goalRef`,
        'assessment_goal_mismatch',
      );
    }
    if (
      record.lifecycle === 'succeeded' &&
      record.lastAssessment?.outcome !== 'passed'
    ) {
      throw new ContractError(
        context.code,
        context.stage,
        `${path}/lifecycle`,
        'success_without_verification',
      );
    }
  }

  if (
    root === undefined ||
    graph.rootGoalRef.id !== root.id ||
    graph.rootGoalRef.version !== root.version
  ) {
    throw new ContractError(
      context.code,
      context.stage,
      '/rootGoalRef',
      'root_ref_mismatch',
    );
  }
  for (const [index, record] of graph.goals.entries()) {
    if (record.kind === 'root') continue;
    const path = `/goals/${index}`;
    if (record.parentGoalRef.id === record.id) {
      throw new ContractError(
        context.code,
        context.stage,
        `${path}/parentGoalRef`,
        'self_parent',
      );
    }
    const parent = nodes.get(record.parentGoalRef.id);
    if (parent === undefined) {
      throw new ContractError(
        context.code,
        context.stage,
        `${path}/parentGoalRef`,
        'missing_parent',
      );
    }
    if (parent.record.version !== record.parentGoalRef.version) {
      throw new ContractError(
        context.code,
        context.stage,
        `${path}/parentGoalRef/version`,
        'stale_parent_version',
      );
    }
    if (record.acceptedPlanRef.rootGoalVersion !== root.version) {
      throw new ContractError(
        context.code,
        context.stage,
        `${path}/acceptedPlanRef/rootGoalVersion`,
        'stale_root_version',
      );
    }
  }

  for (const [index, record] of graph.goals.entries()) {
    const visited = new Set<string>();
    let cursor: GoalRecord = record;
    while (cursor.kind === 'child') {
      if (visited.has(cursor.id)) {
        throw new ContractError(
          context.code,
          context.stage,
          `/goals/${index}/parentGoalRef`,
          'cycle',
        );
      }
      visited.add(cursor.id);
      const parent = nodes.get(cursor.parentGoalRef.id);
      if (parent === undefined) {
        throw new ContractError(
          context.code,
          context.stage,
          `/goals/${index}/parentGoalRef`,
          'missing_parent',
        );
      }
      cursor = parent.record;
    }
  }

  const current = nodes.get(graph.currentGoalRef.id);
  if (
    current === undefined ||
    current.record.version !== graph.currentGoalRef.version
  ) {
    throw new ContractError(
      context.code,
      context.stage,
      '/currentGoalRef',
      'missing_current_goal',
    );
  }
  const path: GoalRef[] = [];
  let cursor: GoalRecord = current.record;
  while (true) {
    path.unshift(Object.freeze({ id: cursor.id, version: cursor.version }));
    if (cursor.kind === 'root') break;
    const parent = nodes.get(cursor.parentGoalRef.id);
    if (parent === undefined) {
      throw new ContractError(
        context.code,
        context.stage,
        '/currentGoalRef',
        'missing_parent',
      );
    }
    cursor = parent.record;
  }
  return Object.freeze(path);
}

/** Accept an authoritative goal graph and derive its current ancestor path.
 * @param input - Untrusted accepted-graph data, including every current goal record.
 * @returns A detached, frozen graph with its path derived from parent references.
 * @throws ContractError when any record, relation, version or assessment is invalid.
 */
export function parseGoalGraph(input: unknown): GoalGraphSnapshot {
  const value = parseJsonValue(input, context.stage);
  const object = requireObject(value, context, '');
  requireKeys(
    object,
    ['runId', 'rootGoalRef', 'currentGoalRef', 'goals'],
    context,
    '',
  );
  if (!isJsonArray(object.goals)) {
    throw new ContractError(
      context.code,
      context.stage,
      '/goals',
      'expected_array',
    );
  }
  const graph: GoalGraph = {
    runId: requireString(object.runId, context, '/runId'),
    rootGoalRef: readGoalRef(object.rootGoalRef, context, '/rootGoalRef'),
    currentGoalRef: readGoalRef(
      object.currentGoalRef,
      context,
      '/currentGoalRef',
    ),
    goals: Object.freeze(
      object.goals.map((record, index) =>
        readGoalRecord(record, `/goals/${index}`),
      ),
    ),
  };
  return Object.freeze({ ...graph, goalPath: deriveGoalPath(graph) });
}
