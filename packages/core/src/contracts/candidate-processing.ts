import type { ActionCheck, ParameterChange } from './action.js';
import type { CandidateRequest } from './adapters.js';
import type { CandidateCoverage, CandidateSet } from './candidate.js';
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
  readonly stage: 'generation' | 'preparation' | 'checking';
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

/** Completed checks against the preparation context, without execution authority. */
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
