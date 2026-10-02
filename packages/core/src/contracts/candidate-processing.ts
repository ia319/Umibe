import type { ActionCheck, ParameterChange } from './action.js';
import type { CandidateRequest } from './adapters.js';
import type {
  Candidate,
  CandidateCoverage,
  CandidateSet,
} from './candidate.js';
import type { CandidateFilterEntry } from './candidate-filter.js';
import type { SelectionResult } from './selection.js';
import type { ContractErrorCode } from '../errors.js';

export type CandidateGenerationInput = Omit<CandidateRequest, 'capabilities'>;

/** Structured contract diagnostics omit rejected values and adapter exception text. */
export interface CandidateContractIssue {
  readonly code: ContractErrorCode;
  readonly stage: string;
  readonly path: string;
  readonly reason: string;
}

export interface CandidatePreparationEntry {
  /** ID in the original provider set, including for merged or excluded proposals. */
  readonly candidateId: string;
  /** Stable normalized-call identity; null when parameters could not be prepared. */
  readonly callId: string | null;
  readonly outcome: 'prepared' | 'merged' | 'excluded';
  readonly reason: string | null;
  readonly issue: CandidateContractIssue | null;
  readonly parameterChanges: readonly ParameterChange[];
}

export interface CandidatePreparationReport {
  /** Null until the entire provider set passes structural and basis validation. */
  readonly received: number | null;
  /** Successfully normalized proposals, including duplicates and metadata conflicts. */
  readonly normalized: number;
  readonly merged: number;
  readonly excluded: number;
  /** Proposals without a preparation outcome when work was interrupted. */
  readonly remaining: number | null;
  readonly entries: readonly CandidatePreparationEntry[];
}

/**
 * In-process preparation token. All data is detached and frozen. Copying or
 * deserializing the token does not preserve its privately bound action calls.
 * The set contains normalized calls awaiting the core's dynamic checks.
 */
export interface PreparedCandidates {
  readonly request: CandidateRequest;
  /** Preserves provider IDs, coverage and every original proposal's provenance. */
  readonly providerSet: CandidateSet;
  readonly set: CandidateSet;
  readonly report: CandidatePreparationReport;
}

export interface CandidateStageFailure {
  readonly outcome: 'failed' | 'cancelled' | 'deadlineExceeded';
  readonly stage:
    'generation' | 'preparation' | 'checking' | 'filtering' | 'selection';
  /** Provider candidate ID during preparation, normalized ID during checking. */
  readonly candidateId: string | null;
  readonly reason:
    'callback_failed' | 'invalid_result' | 'cancelled' | 'deadline_exceeded';
  readonly issue: CandidateContractIssue | null;
}

export type CandidatePreparationResult =
  | { readonly outcome: 'prepared'; readonly prepared: PreparedCandidates }
  | (CandidateStageFailure & {
      readonly request: CandidateRequest;
      readonly providerSet: CandidateSet | null;
      readonly report: CandidatePreparationReport;
    });

export interface CandidateCheckEntry {
  /** Normalized call ID in the prepared set. */
  readonly candidateId: string;
  /** All original proposals represented by this distinct call. */
  readonly providerCandidateIds: readonly string[];
  readonly result: ActionCheck;
}

export interface CandidateCheckingReport {
  /** Counts distinct prepared calls; preparation counts remain in prepared.report. */
  readonly total: number;
  readonly completed: number;
  readonly allowed: number;
  readonly denied: number;
  readonly unknown: number;
  /** Includes the interrupted or invalid check and calls not yet started. */
  readonly remaining: number;
  readonly entries: readonly CandidateCheckEntry[];
  /** Retains provider gaps and identifies any incomplete core checking work. */
  readonly coverage: CandidateCoverage;
}

/**
 * Completed checks against the preparation context, without execution authority.
 * Filtering requires this exact in-process token; copies lose its check binding.
 */
export interface CheckedCandidates {
  readonly prepared: PreparedCandidates;
  /** Only allowed calls, with the original normalized parameters and basis. */
  readonly set: CandidateSet;
  readonly report: CandidateCheckingReport;
}

export type CandidateCheckingResult =
  | { readonly outcome: 'checked'; readonly checked: CheckedCandidates }
  | (CandidateStageFailure & {
      readonly prepared: PreparedCandidates;
      readonly report: CandidateCheckingReport;
    });

export interface CandidateFilteringReport {
  readonly configured: boolean;
  readonly before: number;
  /** Null until the whole filter result is accepted. */
  readonly kept: number | null;
  readonly excluded: number | null;
  /** Input order; empty when no filter is configured or no result is accepted. */
  readonly entries: readonly CandidateFilterEntry[];
}

/** Selection requires this exact in-process token; copies lose its filter binding. */
export interface FilteredCandidates {
  readonly checked: CheckedCandidates;
  /** A fresh set identity, with retained call IDs, parameters and decision basis. */
  readonly set: CandidateSet;
  readonly report: CandidateFilteringReport;
}

export type CandidateFilteringResult =
  | { readonly outcome: 'filtered'; readonly filtered: FilteredCandidates }
  | (CandidateStageFailure & {
      readonly checked: CheckedCandidates;
      readonly report: CandidateFilteringReport;
    });

/** Selection reports a decision or a stopping condition; it never dispatches an action. */
export type CandidateSelectionResult =
  | {
      readonly outcome: 'selected';
      readonly filtered: FilteredCandidates;
      readonly selection: Extract<SelectionResult, { outcome: 'selected' }>;
      readonly candidate: Candidate;
    }
  | {
      readonly outcome: 'abstain';
      readonly filtered: FilteredCandidates;
      readonly selection: Extract<SelectionResult, { outcome: 'abstain' }>;
    }
  | { readonly outcome: 'no_candidates'; readonly filtered: FilteredCandidates }
  | {
      readonly outcome: 'candidate_limit';
      readonly filtered: FilteredCandidates;
      readonly count: number;
      readonly capacity: number;
    }
  | (CandidateStageFailure & { readonly filtered: FilteredCandidates });
