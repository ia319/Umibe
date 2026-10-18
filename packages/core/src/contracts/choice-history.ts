import type { DecisionChoice } from './decision.js';
import type { GoalRef } from './references.js';

/**
 * Recent accepted control decisions, in admission order. The runtime
 * retains the last 20 entries across pause and recovery. These facts describe
 * choices, never authorize execution, and do not replace current observations.
 */
export interface ChoiceHistoryEntry {
  readonly kind: 'decision';
  readonly recordedAt: string;
  readonly goalRef: GoalRef;
  readonly choice: DecisionChoice;
  readonly selectionId: string | null;
}
