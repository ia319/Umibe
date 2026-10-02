/** One reasoned disposition for a member of the filter's input set. */
export interface CandidateFilterEntry {
  readonly candidateId: string;
  readonly outcome: 'kept' | 'excluded';
  readonly reason: string;
}

/** Must partition the entire input set exactly once, without introducing calls. */
export interface CandidateFilterResult {
  readonly candidateSetId: string;
  readonly entries: readonly CandidateFilterEntry[];
}
