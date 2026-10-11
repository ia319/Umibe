import type {
  ControlDecision,
  DecisionOption,
  DecisionRequest,
  ExecutionDisposition,
} from '#internal/contracts/decision';
import type { OperationSet } from '#internal/contracts/operation';
import type { JsonValue } from '#internal/contracts/json';
import { ContractError } from '#internal/errors';
import {
  requireKeys,
  requireObject,
  requireString,
} from '#internal/validation/fields';
import { isJsonArray, parseJsonValue } from '#internal/validation/json';
import { canonicalJson } from '#internal/candidate/identity';

const validation = {
  code: 'INVALID_DECISION_REQUEST',
  stage: 'decision_request',
} as const;

interface OptionBindings {
  readonly executionId: string | null;
  readonly selectionId: string | null;
  readonly proposalId: string | null;
  readonly operations: OperationSet;
}

function readExecutionDisposition(
  value: JsonValue | undefined,
  executionId: string | null,
  path: string,
): ExecutionDisposition {
  const object = requireObject(value, validation, path);
  if (object.kind === 'none') {
    requireKeys(object, ['kind'], validation, path);
    if (executionId !== null)
      throw new ContractError(
        validation.code,
        validation.stage,
        path,
        'active_execution',
      );
    return Object.freeze({ kind: 'none' });
  }
  if (object.kind === 'keep' || object.kind === 'stop') {
    requireKeys(object, ['kind', 'executionId'], validation, path);
    const boundId = requireString(
      object.executionId,
      validation,
      `${path}/executionId`,
    );
    if (boundId !== executionId)
      throw new ContractError(
        validation.code,
        validation.stage,
        `${path}/executionId`,
        'execution_mismatch',
      );
    return Object.freeze({ kind: object.kind, executionId: boundId });
  }
  throw new ContractError(
    validation.code,
    validation.stage,
    `${path}/kind`,
    'invalid_execution_disposition',
  );
}

/** Capture fixed meanings and reject options whose identities do not exist in this review. */
export function createDecisionOptions(
  input: readonly ControlDecision[],
  requestId: string,
  bindings: OptionBindings,
): readonly DecisionOption[] {
  const raw = parseJsonValue(input, validation.stage);
  if (!isJsonArray(raw) || raw.length === 0)
    throw new ContractError(
      validation.code,
      validation.stage,
      '/options',
      'expected_options',
    );
  const meanings = new Set<string>();
  return Object.freeze(
    raw.map((value, index) => {
      const path = `/options/${index}`;
      const object = requireObject(value, validation, path);
      let decision: ControlDecision;
      if (object.kind === 'adoptPlan') {
        requireKeys(
          object,
          ['kind', 'proposalId', 'execution'],
          validation,
          path,
        );
        const proposalId = requireString(
          object.proposalId,
          validation,
          `${path}/proposalId`,
        );
        if (proposalId !== bindings.proposalId)
          throw new ContractError(
            validation.code,
            validation.stage,
            `${path}/proposalId`,
            'proposal_mismatch',
          );
        decision = Object.freeze({
          kind: 'adoptPlan',
          proposalId,
          execution: readExecutionDisposition(
            object.execution,
            bindings.executionId,
            `${path}/execution`,
          ),
        });
      } else {
        let proposal: Exclude<
          ControlDecision,
          { kind: 'adoptPlan' }
        >['proposal'];
        if (object.proposal === null) {
          if (bindings.proposalId !== null)
            throw new ContractError(
              validation.code,
              validation.stage,
              `${path}/proposal`,
              'missing_proposal_disposition',
            );
          proposal = null;
        } else {
          const rawProposal = requireObject(
            object.proposal,
            validation,
            `${path}/proposal`,
          );
          requireKeys(
            rawProposal,
            ['kind', 'proposalId'],
            validation,
            `${path}/proposal`,
          );
          const proposalId = requireString(
            rawProposal.proposalId,
            validation,
            `${path}/proposal/proposalId`,
          );
          if (proposalId !== bindings.proposalId)
            throw new ContractError(
              validation.code,
              validation.stage,
              `${path}/proposal/proposalId`,
              'proposal_mismatch',
            );
          if (rawProposal.kind !== 'defer' && rawProposal.kind !== 'discard')
            throw new ContractError(
              validation.code,
              validation.stage,
              `${path}/proposal/kind`,
              'invalid_proposal_disposition',
            );
          proposal = Object.freeze({ kind: rawProposal.kind, proposalId });
        }
        switch (object.kind) {
          case 'continueAction':
          case 'stopAction': {
            requireKeys(
              object,
              ['kind', 'executionId', 'proposal'],
              validation,
              path,
            );
            const executionId = requireString(
              object.executionId,
              validation,
              `${path}/executionId`,
            );
            if (executionId !== bindings.executionId)
              throw new ContractError(
                validation.code,
                validation.stage,
                `${path}/executionId`,
                'execution_mismatch',
              );
            decision = Object.freeze({
              kind: object.kind,
              executionId,
              proposal,
            });
            break;
          }
          case 'continueSelection': {
            requireKeys(
              object,
              ['kind', 'selectionId', 'proposal'],
              validation,
              path,
            );
            const selectionId = requireString(
              object.selectionId,
              validation,
              `${path}/selectionId`,
            );
            if (selectionId !== bindings.selectionId)
              throw new ContractError(
                validation.code,
                validation.stage,
                `${path}/selectionId`,
                'selection_mismatch',
              );
            decision = Object.freeze({
              kind: 'continueSelection',
              selectionId,
              proposal,
            });
            break;
          }
          case 'selectOperation': {
            requireKeys(
              object,
              ['kind', 'operationId', 'proposal'],
              validation,
              path,
            );
            const operationId = requireString(
              object.operationId,
              validation,
              `${path}/operationId`,
            );
            const operation = bindings.operations.operations.find(
              (offer) => offer.operationId === operationId,
            );
            if (
              operation === undefined ||
              operation.availability.status !== 'available'
            )
              throw new ContractError(
                validation.code,
                validation.stage,
                `${path}/operationId`,
                'operation_unavailable',
              );
            decision = Object.freeze({
              kind: 'selectOperation',
              operationId,
              proposal,
            });
            break;
          }
          case 'replan':
            requireKeys(
              object,
              ['kind', 'execution', 'proposal'],
              validation,
              path,
            );
            decision = Object.freeze({
              kind: 'replan',
              execution: readExecutionDisposition(
                object.execution,
                bindings.executionId,
                `${path}/execution`,
              ),
              proposal,
            });
            break;
          case 'wait':
          case 'abstain':
            requireKeys(object, ['kind', 'proposal'], validation, path);
            if (
              object.kind === 'wait' &&
              (bindings.executionId !== null || bindings.selectionId !== null)
            )
              throw new ContractError(
                validation.code,
                validation.stage,
                path,
                'work_in_progress',
              );
            decision = Object.freeze({ kind: object.kind, proposal });
            break;
          default:
            throw new ContractError(
              validation.code,
              validation.stage,
              `${path}/kind`,
              'invalid_decision',
            );
        }
      }
      const meaning = canonicalJson(parseJsonValue(decision, validation.stage));
      if (meanings.has(meaning))
        throw new ContractError(
          validation.code,
          validation.stage,
          path,
          'duplicate_decision',
        );
      meanings.add(meaning);
      return Object.freeze({
        id: `${requestId}:option:${index + 1}`,
        decision,
      });
    }),
  );
}

/** Resolve only an exact offered ID; extra model-generated control fields are rejected. */
export function selectDecision(
  request: DecisionRequest,
  input: unknown,
): DecisionOption {
  const context = {
    code: 'INVALID_DECISION_RESULT',
    stage: 'decision_result',
  } as const;
  const value = requireObject(
    parseJsonValue(input, context.stage),
    context,
    '',
  );
  requireKeys(value, ['optionId'], context, '');
  const optionId = requireString(value.optionId, context, '/optionId');
  const option = request.options.find((candidate) => candidate.id === optionId);
  if (option === undefined)
    throw new ContractError(
      context.code,
      context.stage,
      '/optionId',
      'option_not_offered',
    );
  return option;
}
