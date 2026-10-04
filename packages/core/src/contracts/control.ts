import type {
  ModelResponseMetadata,
  ModelChoiceMetadata,
} from '#internal/model/metadata';

/** One invocation owns its cancellation signal; a cancelled call cannot authorize a later effect. */
export interface CallControl {
  readonly signal: AbortSignal;
  /** Absolute UTC deadline, including the time spent waiting for an adapter. */
  readonly deadlineAt: string;
  /**
   * Report one response before decoding role output. The core copies and freezes
   * the first valid report; later reports and reports after settlement or abort
   * are ignored. Invalid active reports throw. Absent outside model accounting.
   * Forward this channel unchanged through role and provider boundaries.
   */
  readonly reportModelResponse?: (metadata: ModelResponseMetadata) => void;
  /**
   * Report the locally decoded choice independently of response usage, which may
   * arrive before decoding fails. The first valid report is copied and frozen;
   * duplicate, settled, invalidated and cancelled reports are ignored. Invalid
   * active reports throw. Forward unchanged through nested call boundaries.
   */
  readonly reportModelChoice?: (metadata: ModelChoiceMetadata) => void;
}
