import type {
  ModelIdentity,
  ModelResponseMetadata,
  ModelChoiceMetadata,
} from '#internal/model/metadata';

/** One invocation owns its cancellation signal; a cancelled call cannot authorize a later effect. */
export interface CallControl {
  readonly signal: AbortSignal;
  /** Absolute UTC deadline, including the time spent waiting for an adapter. */
  readonly deadlineAt: string;
  /**
   * Meter one provider request, including decoding and metadata reports, within
   * the current role deadline. Calls must be awaited serially and cannot outlive
   * the role. Agent supplies this only for roles that own per-request accounting;
   * direct callers own their budgets. Rejects on cancellation or model failure.
   */
  readonly requestModel?: <T>(
    model: ModelIdentity,
    invoke: (control: CallControl) => Promise<T>,
  ) => Promise<T>;
  /**
   * Report one response before decoding role output. The core copies and freezes
   * the first valid report; later reports and reports after settlement or abort
   * are ignored. Invalid active reports throw; the first rejection is retained in
   * model_finished.details.reportIssues.response even if caught. A caught error
   * permits a later valid report and does not determine the attempt outcome.
   * Absent outside model accounting.
   * Forward this channel unchanged through role and provider boundaries.
   */
  readonly reportModelResponse?: (metadata: ModelResponseMetadata) => void;
  /**
   * Report the locally decoded choice independently of response usage, which may
   * arrive before decoding fails. The first valid report is copied and frozen;
   * duplicate, settled, invalidated and cancelled reports are ignored. Invalid
   * active reports throw; the first rejection is retained in
   * model_finished.details.reportIssues.choice even if caught. A caught error
   * permits a later valid report and does not determine the attempt outcome.
   * Forward unchanged through nested call boundaries.
   */
  readonly reportModelChoice?: (metadata: ModelChoiceMetadata) => void;
}
