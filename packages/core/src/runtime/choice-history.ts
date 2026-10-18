import type { Candidate } from '#internal/contracts/candidate';
import type { CandidateSelectionResult } from '#internal/contracts/candidate-processing';
import type {
  ChoiceHistoryEntry,
  HistoricalCandidate,
} from '#internal/contracts/choice-history';

/** Retain the chosen call without copying the candidate's full observation and provenance. */
export function describeHistoricalCandidate(
  candidate: Candidate | null,
): HistoricalCandidate | null {
  return candidate === null
    ? null
    : {
        id: candidate.id,
        actionId: candidate.actionId,
        params: candidate.params,
      };
}

export function describeSelectionResult(
  selected: CandidateSelectionResult,
  selectionId: string,
  operationId: string,
): Extract<ChoiceHistoryEntry, { kind: 'selectionResult' }> {
  return {
    kind: 'selectionResult',
    recordedAt: new Date().toISOString(),
    goalRef:
      selected.filtered.checked.prepared.request.context.graph.currentGoalRef,
    selectionId,
    operationId,
    round: 0,
    batchIndex: 0,
    comparisonComplete: true,
    outcome: selected.outcome,
    candidate: describeHistoricalCandidate(
      selected.outcome === 'selected' ? selected.candidate : null,
    ),
    reasonCode:
      selected.outcome === 'abstain'
        ? selected.selection.reason
        : 'reason' in selected
          ? selected.reason
          : null,
  };
}
