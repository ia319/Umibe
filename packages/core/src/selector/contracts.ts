import type { CandidateSet } from '#internal/contracts/candidate';
import type { CallControl } from '#internal/contracts/control';
import type { DecisionContext } from '#internal/contracts/context';
import type { ModelIdentity } from '#internal/model/metadata';

export interface SelectorRequest {
  readonly requestId: string;
  readonly decisionEpoch: number;
  readonly context: DecisionContext;
  readonly candidates: CandidateSet;
}

export interface SelectorBatchRequest extends SelectorRequest {
  readonly selectionId: string;
  readonly operationSetId: string;
  readonly operationId: string;
  readonly sourceCandidateSetId: string;
  /** The original selection deadline; later batches and retries cannot extend it. */
  readonly deadlineAt: string;
  readonly round: number;
  readonly batchIndex: number;
}

export interface SingleCallSelector {
  readonly kind: 'single';
  /** Enables automatic Agent metering, once per select call unless modelAccounting is perRequest. */
  readonly model?: ModelIdentity;
  /**
   * Each native request must use control.requestModel instead of charging the
   * whole select callback once. Requires model; preserves the selection role.
   */
  readonly modelAccounting?: 'perRequest';
  /** Maximum action candidates per call, as a positive safe integer; omitted means undeclared. */
  readonly capacity?: number;
  /** One indivisible callback; Agent handles queued reviews only after it returns. */
  select(
    request: SelectorRequest,
    control: CallControl,
  ): Promise<SelectionResult>;
}

/**
 * Yield between batches within one active run. Agent pause or process recovery
 * discards the cursor; later selection binds fresh candidates.
 */
export interface ResumableSelector {
  readonly kind: 'resumable';
  readonly model?: ModelIdentity;
  /** Route the batch's native request through control.requestModel. Requires model. */
  readonly modelAccounting?: 'perRequest';
  /** Action candidates per batch, as a safe integer of at least two. */
  readonly batchCapacity: number;
  /**
   * Compare this fixed batch, including abstention, with at most one model request.
   * Return request.requestId as decisionId and preserve request.candidates.id.
   * The core owns retries and subsequent batches; a retry receives the same request.
   */
  advance(
    request: SelectorBatchRequest,
    control: CallControl,
  ): Promise<SelectionResult>;
}

export type Selector = SingleCallSelector | ResumableSelector;

export interface SelectionBatchMapping {
  readonly requestId: string;
  readonly candidateSetId: string;
  readonly round: number;
  readonly batchIndex: number;
  readonly candidateIds: readonly string[];
  readonly result: SelectionResult;
}

/** Core-owned continuation. Copying or deserializing it does not preserve its authority. */
export interface SelectionCursor {
  readonly selectionId: string;
  readonly operationSetId: string;
  readonly operationId: string;
  /** The complete original filtered set and decision basis. */
  readonly request: SelectorRequest;
  readonly deadlineAt: string;
  readonly round: number;
  readonly roundCandidateIds: readonly string[];
  readonly nextIndex: number;
  readonly winnerIds: readonly string[];
  readonly batches: readonly SelectionBatchMapping[];
}

export type SelectionResult =
  | {
      readonly decisionId: string;
      readonly candidateSetId: string;
      readonly outcome: 'selected';
      readonly candidateId: string;
    }
  | {
      readonly decisionId: string;
      readonly candidateSetId: string;
      readonly outcome: 'abstain';
      readonly reason: string;
    };
