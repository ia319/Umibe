import { randomUUID } from 'node:crypto';
import type { Candidate } from '#internal/contracts/candidate';
import type {
  CandidateSelectionResult,
  FilteredCandidates,
} from '#internal/contracts/candidate-processing';
import type { CallControl } from '#internal/contracts/control';
import { captureControl } from '#internal/candidate/control';
import type { CapturedControl } from '#internal/candidate/control';
import {
  candidateContractIssue,
  invocationFailure,
} from '#internal/candidate/diagnostics';
import { assertFilteredCandidates } from '#internal/candidate/handles';
import { ContractError } from '#internal/errors';
import { requireInteger, requireString } from '#internal/validation/fields';
import type {
  SelectionBatchMapping,
  SelectionCursor,
  SelectionResult,
  SelectorBatchRequest,
  SelectorRequest,
} from './contracts.js';
import { acceptSelection } from './select.js';
import { parseSelection } from './validation.js';

export type { SelectionCursor } from './contracts.js';

export type SelectionAdvanceResult =
  | { readonly outcome: 'pending'; readonly cursor: SelectionCursor }
  | CandidateSelectionResult;

interface SelectionSource {
  readonly filtered: FilteredCandidates;
  readonly control: CapturedControl;
  readonly batchCapacity: number;
  readonly candidates: ReadonlyMap<string, Candidate>;
}

interface CursorBinding {
  readonly source: SelectionSource;
  readonly request: SelectorBatchRequest;
  consumed: boolean;
}

const cursors = new WeakMap<SelectionCursor, CursorBinding>();
const validation = {
  code: 'INVALID_CANDIDATE_REQUEST',
  stage: 'candidate_selection',
} as const;

/**
 * Start a tournament over the exact filtered token. Capacity bounds the original
 * complete set; batches preserve its order, fixed calls, and original deadline.
 * No selector is invoked. The caller owns callback admission and retry timing.
 */
export function beginSelection(
  filtered: FilteredCandidates,
  operationSetId: string,
  operationId: string,
  batchCapacity: number,
  controlInput: CallControl,
  capacity?: number,
): SelectionAdvanceResult {
  assertFilteredCandidates(filtered);
  requireString(operationSetId, validation, '/operationSetId');
  requireString(operationId, validation, '/operationId');
  if (
    filtered.set.candidates.some(
      (candidate) => candidate.actionId !== operationId,
    )
  )
    throw new ContractError(
      validation.code,
      validation.stage,
      '/operationId',
      'operation_mismatch',
    );
  requireInteger(batchCapacity, 1, validation, '/batchCapacity');
  if (batchCapacity < 2)
    throw new ContractError(
      validation.code,
      validation.stage,
      '/batchCapacity',
      'expected_at_least_two_candidates',
    );
  if (capacity !== undefined)
    requireInteger(capacity, 1, validation, '/capacity');
  const control = captureControl(controlInput);
  const stopped = control.signal.aborted
    ? 'cancelled'
    : Date.now() >= control.deadlineMs
      ? 'deadlineExceeded'
      : null;
  if (stopped !== null)
    return Object.freeze({
      ...invocationFailure({ outcome: stopped }, 'selection', null),
      filtered,
    });
  const count = filtered.set.candidates.length;
  if (count === 0) return Object.freeze({ outcome: 'no_candidates', filtered });
  if (capacity !== undefined && count > capacity)
    return Object.freeze({
      outcome: 'candidate_limit',
      filtered,
      count,
      capacity,
    });
  const selectionId = randomUUID();
  const basis = filtered.checked.prepared.request;
  const request: SelectorRequest = Object.freeze({
    requestId: selectionId,
    decisionEpoch: basis.decisionEpoch,
    context: basis.context,
    candidates: filtered.set,
  });
  const source: SelectionSource = {
    filtered,
    control,
    batchCapacity,
    candidates: new Map(
      filtered.set.candidates.map((candidate) => [candidate.id, candidate]),
    ),
  };
  return Object.freeze({
    outcome: 'pending',
    cursor: registerCursor(source, {
      selectionId,
      operationSetId,
      operationId,
      request,
      deadlineAt: control.deadlineAt,
      round: 0,
      roundCandidateIds: Object.freeze(
        filtered.set.candidates.map((candidate) => candidate.id),
      ),
      nextIndex: 0,
      winnerIds: Object.freeze([]),
      batches: Object.freeze([]),
    }),
  });
}

/**
 * Return the same immutable batch for every retry of this cursor. Throws for
 * copied, consumed, cancelled, or expired cursors. Every batch includes the
 * abstention option, even when the batch contains a single candidate.
 */
export function nextSelectionBatch(
  cursor: SelectionCursor,
): SelectorBatchRequest {
  const binding = getCursorBinding(cursor);
  const control = binding.source.control;
  if (control.signal.aborted || Date.now() >= control.deadlineMs)
    throw new ContractError(
      validation.code,
      validation.stage,
      '/cursor',
      control.signal.aborted ? 'cancelled' : 'deadline_exceeded',
    );
  return binding.request;
}

/**
 * Accept one batch against its exact request ID and membership. Only an accepted
 * result consumes the cursor. Callback failures leave it untouched for retries;
 * callers must not submit responses after replacing or abandoning the selection.
 */
export function acceptSelectionBatch(
  cursor: SelectionCursor,
  raw: unknown,
): SelectionAdvanceResult {
  const binding = getCursorBinding(cursor);
  const { source, request } = binding;
  const { control, filtered } = source;
  const stopped = control.signal.aborted
    ? 'cancelled'
    : Date.now() >= control.deadlineMs
      ? 'deadlineExceeded'
      : null;
  if (stopped !== null)
    return Object.freeze({
      ...invocationFailure({ outcome: stopped }, 'selection', null),
      filtered,
    });
  let selection: SelectionResult;
  try {
    selection = parseSelection(raw, request.candidates);
    if (selection.decisionId !== request.requestId)
      throw new ContractError(
        'INVALID_SELECTION',
        'selection',
        '/decisionId',
        'decision_mismatch',
      );
  } catch (error) {
    return Object.freeze({
      outcome: 'failed',
      stage: 'selection',
      candidateId: null,
      reason: 'invalid_result',
      issue: candidateContractIssue(error),
      filtered,
    });
  }
  const late = control.signal.aborted
    ? 'cancelled'
    : Date.now() >= control.deadlineMs
      ? 'deadlineExceeded'
      : null;
  if (late !== null)
    return Object.freeze({
      ...invocationFailure({ outcome: late }, 'selection', null),
      filtered,
    });
  const mapping: SelectionBatchMapping = Object.freeze({
    requestId: request.requestId,
    candidateSetId: request.candidates.id,
    round: request.round,
    batchIndex: request.batchIndex,
    candidateIds: Object.freeze(
      request.candidates.candidates.map((candidate) => candidate.id),
    ),
    result: selection,
  });
  const batches = Object.freeze([...cursor.batches, mapping]);
  const winnerIds =
    selection.outcome === 'selected'
      ? Object.freeze([...cursor.winnerIds, selection.candidateId])
      : cursor.winnerIds;
  const nextIndex = cursor.nextIndex + request.candidates.candidates.length;
  binding.consumed = true;
  if (nextIndex < cursor.roundCandidateIds.length)
    return Object.freeze({
      outcome: 'pending',
      cursor: registerCursor(source, {
        ...cursor,
        nextIndex,
        winnerIds,
        batches,
      }),
    });
  if (winnerIds.length > 1)
    return Object.freeze({
      outcome: 'pending',
      cursor: registerCursor(source, {
        ...cursor,
        round: cursor.round + 1,
        roundCandidateIds: winnerIds,
        nextIndex: 0,
        winnerIds: Object.freeze([]),
        batches,
      }),
    });
  return acceptSelection(filtered, {
    decisionId: cursor.selectionId,
    candidateSetId: cursor.request.candidates.id,
    ...(winnerIds.length === 0
      ? { outcome: 'abstain', reason: 'model_abstained' }
      : { outcome: 'selected', candidateId: winnerIds[0]! }),
  });
}

function getCursorBinding(cursor: SelectionCursor): CursorBinding {
  const binding = cursors.get(cursor);
  if (binding === undefined || binding.consumed)
    throw new ContractError(
      validation.code,
      validation.stage,
      '/cursor',
      binding === undefined
        ? 'invalid_selection_cursor'
        : 'selection_cursor_consumed',
    );
  return binding;
}

function registerCursor(
  source: SelectionSource,
  input: SelectionCursor,
): SelectionCursor {
  const cursor = Object.freeze(input);
  const batchIndex = Math.floor(cursor.nextIndex / source.batchCapacity);
  const suffix = `/round-${cursor.round}/batch-${batchIndex}`;
  const candidateSetId = `${cursor.request.candidates.id}/selection-${cursor.selectionId}${suffix}`;
  const request: SelectorBatchRequest = Object.freeze({
    ...cursor.request,
    requestId: `${cursor.selectionId}${suffix}`,
    selectionId: cursor.selectionId,
    operationSetId: cursor.operationSetId,
    operationId: cursor.operationId,
    sourceCandidateSetId: cursor.request.candidates.id,
    deadlineAt: cursor.deadlineAt,
    round: cursor.round,
    batchIndex,
    candidates: Object.freeze({
      ...cursor.request.candidates,
      id: candidateSetId,
      candidates: Object.freeze(
        cursor.roundCandidateIds
          .slice(cursor.nextIndex, cursor.nextIndex + source.batchCapacity)
          .map((id) =>
            Object.freeze({
              ...source.candidates.get(id)!,
              candidateSetId,
            }),
          ),
      ),
    }),
  });
  cursors.set(cursor, { source, request, consumed: false });
  return cursor;
}
