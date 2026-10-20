import type { ActionCapability } from '#internal/contracts/action';
import type { RecordedChange } from '#internal/contracts/changes';
import type { DecisionContext } from '#internal/contracts/context';
import type {
  ControlDecision,
  DecisionChoice,
  DecisionGoal,
  DecisionInput,
  DecisionRequest,
} from '#internal/contracts/decision';
import type { GoalRecord } from '#internal/contracts/goal';
import type { JsonObject } from '#internal/contracts/json';
import type { OperationSet } from '#internal/contracts/operation';
import type { ActionIntent } from '#internal/contracts/record';
import type {
  PendingPlanProposal,
  PlanProposal,
  PlanProposalContent,
  PlanningTrigger,
} from '#internal/planner/contracts';
import { captureDecisionRequest } from '#internal/candidate/context';
import { parseOperationSet } from '#internal/candidate/operations';
import { ContractError } from '#internal/errors';
import { parsePlanProposalShape } from '#internal/planner/validation';
import {
  requireInteger,
  requireObject,
  requireString,
  requireTimestamp,
} from '#internal/validation/fields';
import { parseJsonValue } from '#internal/validation/json';
import { readActionIntent } from '#internal/validation/record';
import { createDecisionOptions, describeDecisionOption } from './validation.js';

export interface DecisionRequestInput {
  readonly requestId: string;
  readonly decisionEpoch: number;
  readonly context: DecisionContext;
  readonly reviewVersion: number;
  readonly throughSequence: number;
  readonly changes: readonly RecordedChange[];
  readonly capabilities: readonly ActionCapability[];
  readonly operations: OperationSet;
  readonly execution: {
    readonly intent: ActionIntent;
    readonly phase: 'prepared' | 'running';
    readonly progress: JsonObject;
  } | null;
  readonly selection: {
    readonly selectionId: string;
    readonly operationId: string;
    readonly round: number;
    readonly candidateCount: number;
    readonly completedBatches: number;
    readonly deadlineAt: string;
  } | null;
  readonly planning: {
    readonly need: PlanningTrigger | null;
    readonly inFlight: boolean;
    readonly pending: PendingPlanProposal | null;
  };
  readonly decisions: readonly ControlDecision[];
}

const validation = {
  code: 'INVALID_DECISION_REQUEST',
  stage: 'decision_request',
} as const;

function describeGoal(goal: GoalRecord): DecisionGoal {
  const assessment = goal.lastAssessment;
  return Object.freeze({
    id: goal.id,
    parentGoalId: goal.parentGoalRef?.id ?? null,
    description: goal.description,
    criteria: goal.criteria,
    lifecycle: goal.lifecycle,
    assessment:
      assessment === null
        ? null
        : Object.freeze({
            outcome: assessment.outcome,
            evidence: assessment.evidence,
            reason: assessment.reason,
            ...(assessment.progress === undefined
              ? {}
              : { progress: assessment.progress }),
          }),
  });
}

function describeProposal(proposal: PlanProposal): PlanProposalContent {
  switch (proposal.outcome) {
    case 'blocked':
      return Object.freeze({
        outcome: proposal.outcome,
        reason: proposal.reason,
      });
    case 'claimComplete':
      return Object.freeze({
        outcome: proposal.outcome,
        goalRef: proposal.goalRef,
      });
    case 'decompose':
      return Object.freeze({
        outcome: proposal.outcome,
        goals: proposal.goals,
        nextTempId: proposal.nextTempId,
        guidance: proposal.guidance,
        ...(proposal.goalOrder === undefined
          ? {}
          : { goalOrder: proposal.goalOrder }),
      });
    case 'revise':
    case 'reconfirm':
      return Object.freeze({
        outcome: proposal.outcome,
        revisions: proposal.revisions,
        nextGoalRef: proposal.nextGoalRef,
        guidance: proposal.guidance,
        ...(proposal.goalOrder === undefined
          ? {}
          : { goalOrder: proposal.goalOrder }),
      });
    case 'continue':
    case 'switch':
      return Object.freeze({
        outcome: proposal.outcome,
        nextGoalRef: proposal.nextGoalRef,
        guidance: proposal.guidance,
        ...(proposal.goalOrder === undefined
          ? {}
          : { goalOrder: proposal.goalOrder }),
      });
  }
}

/** Build a role projection without passing the runtime checkpoint or correlation fields to models. */
export function createDecisionRequest(
  input: DecisionRequestInput,
): DecisionRequest {
  const captured = captureDecisionRequest({
    requestId: input.requestId,
    decisionEpoch: input.decisionEpoch,
    context: input.context,
  });
  const context = captured.context;
  const operations = parseOperationSet(input.operations, {
    ...captured,
    requestId: input.operations.requestId,
    capabilities: input.capabilities,
  });
  const throughSequence = requireInteger(
    input.throughSequence,
    0,
    validation,
    '/throughSequence',
  );
  const reviewVersion = requireInteger(
    input.reviewVersion,
    0,
    validation,
    '/reviewVersion',
  );
  const capabilities = new Map(
    input.capabilities.map((capability) => [capability.id, capability]),
  );
  const intent =
    input.execution === null
      ? null
      : readActionIntent(
          parseJsonValue(input.execution.intent, validation.stage),
        );
  const executionId = intent?.executionId ?? null;
  const selectionId =
    input.selection === null
      ? null
      : requireString(
          input.selection.selectionId,
          validation,
          '/selection/selectionId',
        );
  const proposalId =
    input.planning.pending === null
      ? null
      : requireString(
          input.planning.pending.proposalId,
          validation,
          '/planning/proposalId',
        );
  const options = createDecisionOptions(input.decisions, captured.requestId, {
    executionId,
    selectionId,
    proposalId,
    operations,
  });
  const root = context.graph.goals.find(
    (goal) => goal.id === context.graph.rootGoalRef.id,
  );
  if (root?.kind !== 'root')
    throw new ContractError(
      validation.code,
      validation.stage,
      '/context/graph',
      'missing_root_goal',
    );
  let execution: DecisionInput['execution'] = null;
  if (input.execution !== null && intent !== null) {
    const capability = capabilities.get(intent.actionId);
    if (capability?.version !== intent.actionVersion)
      throw new ContractError(
        validation.code,
        validation.stage,
        '/execution/intent/actionVersion',
        'action_version_mismatch',
      );
    if (
      input.execution.phase !== 'prepared' &&
      input.execution.phase !== 'running'
    )
      throw new ContractError(
        validation.code,
        validation.stage,
        '/execution/phase',
        'inactive_execution',
      );
    execution = Object.freeze({
      actionId: intent.actionId,
      description: capability.description,
      goalId: intent.currentGoalRef.id,
      params: intent.params,
      expectedEffects: capability.expectedEffects,
      phase: input.execution.phase,
      progress: requireObject(
        parseJsonValue(input.execution.progress, validation.stage),
        validation,
        '/execution/progress',
      ),
      stopReason: context.runtime?.execution?.stopCause?.reasonCode ?? null,
    });
  }
  let previousSequence = 0;
  const changes = Object.freeze(
    input.changes.map((change, index) => {
      const sequence = requireInteger(
        change.sequence,
        1,
        validation,
        `/changes/${index}/sequence`,
      );
      if (sequence <= previousSequence || sequence > throughSequence)
        throw new ContractError(
          validation.code,
          validation.stage,
          `/changes/${index}/sequence`,
          'invalid_change_order',
        );
      previousSequence = sequence;
      return Object.freeze({
        source: change.source,
        sourceEvent: change.sourceEvent,
        occurredAt: change.occurredAt,
        receivedAt: change.receivedAt,
        data: parseJsonValue(change.data, validation.stage),
        ...(change.sourceSequence === undefined
          ? {}
          : { sourceSequence: change.sourceSequence }),
        ...(change.executionId === undefined
          ? {}
          : { executionId: change.executionId }),
      });
    }),
  );
  const selection =
    input.selection === null
      ? null
      : Object.freeze({
          operationId: requireString(
            input.selection.operationId,
            validation,
            '/selection/operationId',
          ),
          round: requireInteger(
            input.selection.round,
            0,
            validation,
            '/selection/round',
          ),
          candidateCount: requireInteger(
            input.selection.candidateCount,
            0,
            validation,
            '/selection/candidateCount',
          ),
          completedBatches: requireInteger(
            input.selection.completedBatches,
            0,
            validation,
            '/selection/completedBatches',
          ),
          deadlineAt: requireTimestamp(
            input.selection.deadlineAt,
            validation,
            '/selection/deadlineAt',
          ),
        });
  const need = input.planning.need;
  const planningNeed =
    need === null
      ? null
      : requireObject(
          parseJsonValue(
            need.kind === 'decision'
              ? { kind: need.kind, goalRef: need.goalRef }
              : need.kind === 'planInvalidated'
                ? { kind: need.kind }
                : need,
            validation.stage,
          ),
          validation,
          '/planning/need',
        );
  const pending = input.planning.pending;
  const choices: readonly DecisionChoice[] = Object.freeze(
    options.map(describeDecisionOption),
  );
  const projected: DecisionInput = Object.freeze({
    recentChoices: context.runtime?.recentChoices ?? [],
    rootGoal: describeGoal(root),
    goalPath: Object.freeze(context.graph.goalPath.map((goal) => goal.id)),
    acceptedPlan:
      context.planRef === null
        ? null
        : Object.freeze({
            guidance: context.planGuidance,
            goals: Object.freeze(
              context.graph.goals
                .filter((goal) => goal.id !== root.id)
                .map(describeGoal),
            ),
          }),
    constraints: context.effectiveConstraints,
    hardConstraints: root.hardConstraints,
    preferences: root.preferences,
    goalLimits: root.limits,
    applicationContext: context.applicationContext ?? null,
    snapshot: Object.freeze({
      source: context.observation.source,
      observedAt: context.observation.observedAt,
      coverage: context.observation.coverage,
      data: context.observation.data,
    }),
    changes,
    execution,
    progress: Object.freeze(
      (context.runtime?.progress ?? []).map((progress) =>
        Object.freeze({
          goalId: progress.goalRef.id,
          noProgress: progress.noProgress,
          recoveryAttempts: progress.recoveryAttempts,
          highWater: progress.highWater,
        }),
      ),
    ),
    recentEffects: Object.freeze(
      (
        context.runtime?.recentResults ??
        (context.lastActionResult === null ? [] : [context.lastActionResult])
      ).map((result) =>
        Object.freeze({
          executionId: result.executionId,
          outcome: result.outcome,
          reasonCode: result.reasonCode,
          underlyingSettled: result.underlyingSettled,
          confirmedEffects: result.confirmedEffects,
          unresolvedEffects: result.unresolvedEffects,
          progress: result.progress,
        }),
      ),
    ),
    operations: Object.freeze(
      operations.operations.map((operation) => {
        const capability = capabilities.get(operation.operationId)!;
        return Object.freeze({
          operationId: operation.operationId,
          availability: operation.availability,
          parameterSources: operation.parameterSources,
          informationGaps: operation.informationGaps,
          description: capability.description,
          parameters: capability.parameters,
          expectedEffects: capability.expectedEffects,
          tags: capability.tags,
        });
      }),
    ),
    informationGaps: operations.informationGaps,
    capabilityGaps: operations.capabilityGaps,
    selection,
    planning: Object.freeze({
      need: planningNeed,
      inFlight: input.planning.inFlight,
      proposal:
        pending === null
          ? null
          : Object.freeze({
              receivedAt: requireTimestamp(
                pending.receivedAt,
                validation,
                '/planning/proposal/receivedAt',
              ),
              content: describeProposal(
                parsePlanProposalShape(pending.proposal),
              ),
            }),
    }),
    options: choices,
  });
  return Object.freeze({
    requestId: captured.requestId,
    basis: Object.freeze({
      runId: context.graph.runId,
      decisionEpoch: captured.decisionEpoch,
      rootGoalRef: context.graph.rootGoalRef,
      currentGoalRef: context.graph.currentGoalRef,
      goalPath: context.graph.goalPath,
      planRef: context.planRef,
      constraintsVersion: context.constraintsVersion,
      observationRef: Object.freeze({
        id: context.observation.id,
        revision: context.observation.revision,
      }),
      reviewVersion,
      throughSequence,
      operationSetId: operations.id,
      executionId,
      selectionId,
      proposalId,
    }),
    input: projected,
    options,
  });
}
