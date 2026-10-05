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

export interface Selector {
  /** Declares one model request per attempt and enables automatic Agent metering. */
  readonly model?: ModelIdentity;
  /** Maximum action candidates per call, as a positive safe integer; omitted means undeclared. */
  readonly capacity?: number;
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
