import type { DecisionChoice } from './decision.js';
import type { JsonObject } from './json.js';
import type { GoalRef } from './references.js';

/** A selected call is a recommendation; only execution receipts establish effects. */
export interface HistoricalCandidate {
  readonly id: string;
  readonly actionId: string;
  readonly params: JsonObject;
}

interface ChoiceHistoryBasis {
  readonly recordedAt: string;
  readonly goalRef: GoalRef;
}

/**
 * Recent accepted control and parameter choices, in admission order. The runtime
 * retains the last 20 entries across pause and recovery. These facts describe
 * choices, never authorize execution, and do not replace current observations.
 */
export type ChoiceHistoryEntry = ChoiceHistoryBasis &
  (
    | {
        readonly kind: 'decision';
        readonly choice: DecisionChoice;
        readonly selectionId: string | null;
      }
    | {
        readonly kind: 'selectionStarted';
        readonly selectionId: string;
        readonly operationId: string;
        readonly candidateCount: number;
      }
    | {
        readonly kind: 'selectionResult';
        readonly selectionId: string;
        readonly operationId: string;
        readonly round: number;
        readonly batchIndex: number;
        /** False for an intermediate tournament winner or abstention. */
        readonly comparisonComplete: boolean;
        readonly outcome:
          | 'selected'
          | 'abstain'
          | 'no_candidates'
          | 'candidate_limit'
          | 'cancelled'
          | 'deadlineExceeded'
          | 'failed';
        readonly candidate: HistoricalCandidate | null;
        readonly reasonCode: string | null;
      }
  );
