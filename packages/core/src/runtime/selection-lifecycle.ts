import type { SelectedCandidate } from '#internal/contracts/candidate-processing';
import type { DecisionRequestInput } from '#internal/decision/request';
import type { SelectorBatchRequest } from '#internal/selector/contracts';
import {
  nextSelectionBatch,
  type SelectionAdvanceResult,
  type SelectionCursor,
} from '#internal/selector/cursor';
import { ModelRequestError } from './model.js';

interface ReadySelection {
  readonly selectionId: string;
  readonly operationSetId: string;
  readonly operationId: string;
  readonly deadlineAt: string;
  readonly round: number;
  readonly completedBatches: number;
  readonly result: SelectedCandidate;
}

type SelectionStart =
  | { readonly kind: 'comparing'; readonly cursor: SelectionCursor }
  | { readonly kind: 'ready'; readonly selection: ReadySelection };

type SelectionState =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'comparing';
      readonly cursor: SelectionCursor;
      readonly authorized: boolean;
      readonly attempt: number;
      readonly retryAt: number;
    }
  | {
      readonly kind: 'ready';
      readonly selection: ReadySelection;
      readonly authorized: boolean;
    };

export interface SelectionBatch {
  readonly kind: 'batch';
  readonly cursor: SelectionCursor;
  readonly request: SelectorBatchRequest;
  readonly attempt: number;
}

/**
 * Owns one in-process selection through review, retries, and dispatch admission.
 * The scheduler checks the original deadline before consuming a ready result.
 */
export class SelectionLifecycle {
  #state: SelectionState = { kind: 'idle' };

  start(input: SelectionStart): void {
    this.#state =
      input.kind === 'comparing'
        ? {
            ...input,
            authorized: true,
            attempt: 1,
            retryAt: 0,
          }
        : {
            ...input,
            selection: Object.freeze({ ...input.selection }),
            authorized: true,
          };
  }

  suspend(): void {
    if (this.#state.kind !== 'idle')
      this.#state = { ...this.#state, authorized: false };
  }

  authorize(selectionId: string): boolean {
    const state = this.#state;
    if (
      state.kind === 'idle' ||
      (state.kind === 'comparing'
        ? state.cursor.selectionId
        : state.selection.selectionId) !== selectionId
    )
      return false;
    this.#state = { ...state, authorized: true };
    return true;
  }

  /** Preserve the original cursor and deadline while a retry waits or review suspends it. */
  nextBatch():
    SelectionBatch | { readonly kind: 'wait'; readonly until: number } | null {
    const state = this.#state;
    if (state.kind !== 'comparing' || !state.authorized) return null;
    if (Date.now() < state.retryAt)
      return {
        kind: 'wait',
        until: Math.min(state.retryAt, Date.parse(state.cursor.deadlineAt)),
      };
    return {
      kind: 'batch',
      cursor: state.cursor,
      request: nextSelectionBatch(state.cursor),
      attempt: state.attempt,
    };
  }

  /** Call after persisting the batch receipt; stale cursors cannot replace current state. */
  advance(cursor: SelectionCursor, result: SelectionAdvanceResult): boolean {
    const state = this.#state;
    if (state.kind !== 'comparing' || state.cursor !== cursor) return false;
    if (result.outcome === 'pending')
      this.#state = { ...state, cursor: result.cursor, attempt: 1, retryAt: 0 };
    else if (result.outcome === 'selected')
      this.#state = {
        kind: 'ready',
        authorized: state.authorized,
        selection: Object.freeze({
          selectionId: cursor.selectionId,
          operationSetId: cursor.operationSetId,
          operationId: cursor.operationId,
          deadlineAt: cursor.deadlineAt,
          round: cursor.round,
          completedBatches: cursor.batches.length + 1,
          result,
        }),
      };
    else this.#state = { kind: 'idle' };
    return true;
  }

  retry(cursor: SelectionCursor, error: unknown, maxRetries: number): boolean {
    const state = this.#state;
    if (
      state.kind !== 'comparing' ||
      state.cursor !== cursor ||
      !(error instanceof ModelRequestError) ||
      !['rate_limited', 'unavailable', 'deadline_exceeded'].includes(
        error.code,
      ) ||
      state.attempt > maxRetries
    )
      return false;
    this.#state = {
      ...state,
      retryAt:
        Date.now() +
        Math.max(250 * 2 ** (state.attempt - 1), error.retryAfterMs),
      attempt: state.attempt + 1,
    };
    return true;
  }

  /** Consume an authorized result once; review must authorize it again after suspension. */
  takeReady(): SelectedCandidate | null {
    const state = this.#state;
    if (state.kind !== 'ready' || !state.authorized) return null;
    this.#state = { kind: 'idle' };
    return state.selection.result;
  }

  discard(): void {
    this.#state = { kind: 'idle' };
  }

  /** Completed choices retain their identity and receipt source until dispatch is permitted. */
  snapshot() {
    const state = this.#state;
    if (state.kind === 'idle') return null;
    const selection = state.kind === 'ready' ? state.selection : state.cursor;
    const summary: NonNullable<DecisionRequestInput['selection']> =
      Object.freeze({
        selectionId: selection.selectionId,
        operationId: selection.operationId,
        round: selection.round,
        deadlineAt: selection.deadlineAt,
        candidateCount:
          'result' in selection
            ? selection.result.filtered.set.candidates.length
            : selection.request.candidates.candidates.length,
        completedBatches:
          'result' in selection
            ? selection.completedBatches
            : selection.batches.length,
      });
    return Object.freeze({
      summary,
      source: Object.freeze({
        selectionCursor: state.kind === 'comparing' ? state.cursor : null,
        completedSelection:
          state.kind === 'ready'
            ? Object.freeze({
                ...summary,
                selection: state.selection.result.selection,
              })
            : null,
      }),
    });
  }
}
