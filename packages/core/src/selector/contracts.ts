import type { CandidateSet } from '#internal/contracts/candidate';
import type { CallControl } from '#internal/contracts/control';
import type { DecisionContext } from '#internal/contracts/context';

export interface SelectorRequest {
  readonly requestId: string;
  readonly decisionEpoch: number;
  readonly context: DecisionContext;
  readonly candidates: CandidateSet;
}

export interface Selector {
  select(
    request: SelectorRequest,
    control: CallControl,
  ): Promise<SelectionResult>;
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
