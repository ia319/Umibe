import type { JsonValue } from './json.js';

/** One owned run's subscription; abort closes publishing before ownership is released. */
export interface ObservationScope {
  readonly runId: string;
  readonly signal: AbortSignal;
}

/** A source-captured fact, including native events or JSON differences in data. */
export interface ChangeFact {
  readonly sourceEvent: string;
  /** Canonical millisecond UTC time, or null when the source cannot establish it. */
  readonly occurredAt: string | null;
  readonly data: JsonValue;
  readonly sourceEventId?: string;
  /** Source-local order; it does not establish order across sources. */
  readonly sourceSequence?: number;
  /** Capture with the original event; never infer from the execution active at delivery. */
  readonly executionId?: string;
}

/** Preserve every fact in source order; reuse an ID only for an identical batch. */
export interface ChangeBatch {
  readonly id: string;
  readonly source: string;
  readonly changes: readonly ChangeFact[];
}

export interface RecordedChange extends ChangeFact {
  /** Positive, increasing commit order within one run; independent of sourceSequence. */
  readonly sequence: number;
  readonly batchId: string;
  readonly source: string;
  readonly receivedAt: string;
}

export interface RecordedChangeBatch {
  readonly id: string;
  readonly runId: string;
  readonly source: string;
  readonly receivedAt: string;
  readonly changes: readonly RecordedChange[];
}
