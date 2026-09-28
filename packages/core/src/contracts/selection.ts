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
