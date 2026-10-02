import { randomUUID } from 'node:crypto';
import type {
  CallControl,
  CandidateFilter,
} from '#internal/contracts/adapters';
import type { CandidateSet } from '#internal/contracts/candidate';
import type { CandidateFilterEntry } from '#internal/contracts/candidate-filter';
import type {
  CandidateFilteringReport,
  CandidateFilteringResult,
  CheckedCandidates,
} from '#internal/contracts/candidate-processing';
import { ContractError } from '#internal/errors';
import {
  requireKeys,
  requireObject,
  requireString,
} from '#internal/validation/fields';
import { isJsonArray, parseJsonValue } from '#internal/validation/json';
import { captureControl, invokeControlled } from './control.js';
import { candidateContractIssue, invocationFailure } from './diagnostics.js';
import {
  assertCheckedCandidates,
  registerFilteredCandidates,
} from './handles.js';

function parseFilterEntries(
  input: unknown,
  set: CandidateSet,
): readonly CandidateFilterEntry[] {
  const context = {
    code: 'INVALID_CANDIDATE_FILTER',
    stage: 'candidate_filter',
  } as const;
  const object = requireObject(
    parseJsonValue(input, context.stage),
    context,
    '',
  );
  requireKeys(object, ['candidateSetId', 'entries'], context, '');
  if (
    requireString(object.candidateSetId, context, '/candidateSetId') !== set.id
  ) {
    throw new ContractError(
      context.code,
      context.stage,
      '/candidateSetId',
      'candidate_set_mismatch',
    );
  }
  if (!isJsonArray(object.entries)) {
    throw new ContractError(
      context.code,
      context.stage,
      '/entries',
      'expected_array',
    );
  }
  const members = new Set(set.candidates.map((candidate) => candidate.id));
  const entries = new Map<string, CandidateFilterEntry>();
  for (const [index, value] of object.entries.entries()) {
    const path = `/entries/${index}`;
    const entry = requireObject(value, context, path);
    requireKeys(entry, ['candidateId', 'outcome', 'reason'], context, path);
    const candidateId = requireString(
      entry.candidateId,
      context,
      `${path}/candidateId`,
    );
    if (!members.has(candidateId)) {
      throw new ContractError(
        context.code,
        context.stage,
        `${path}/candidateId`,
        'unknown_candidate',
      );
    }
    if (entries.has(candidateId)) {
      throw new ContractError(
        context.code,
        context.stage,
        `${path}/candidateId`,
        'duplicate_candidate',
      );
    }
    const outcome = entry.outcome;
    if (outcome !== 'kept' && outcome !== 'excluded') {
      throw new ContractError(
        context.code,
        context.stage,
        `${path}/outcome`,
        'invalid_filter_outcome',
      );
    }
    entries.set(
      candidateId,
      Object.freeze({
        candidateId,
        outcome,
        reason: requireString(entry.reason, context, `${path}/reason`),
      }),
    );
  }
  if (entries.size !== members.size) {
    throw new ContractError(
      context.code,
      context.stage,
      '/entries',
      'missing_candidate',
    );
  }
  return Object.freeze(
    set.candidates.map((candidate) => entries.get(candidate.id)!),
  );
}

/**
 * Optionally filter a completed check batch. Omitting the filter retains every
 * allowed call. A filter must partition the entire batch with a reason per ID;
 * its order cannot reorder calls or replace their frozen data. Invalid caller
 * arguments reject with ContractError; callback failures return diagnostics.
 */
export async function filterCandidates(
  checked: CheckedCandidates,
  controlInput: CallControl,
  filter?: CandidateFilter,
): Promise<CandidateFilteringResult> {
  assertCheckedCandidates(checked);
  if (
    filter !== undefined &&
    (typeof filter !== 'object' ||
      filter === null ||
      typeof filter.filter !== 'function')
  ) {
    throw new ContractError(
      'INVALID_CANDIDATE_REQUEST',
      'candidate_filtering',
      '/filter',
      'expected_candidate_filter',
    );
  }
  const invoke = filter?.filter.bind(filter);
  const control = captureControl(controlInput);
  const pendingReport: CandidateFilteringReport = Object.freeze({
    configured: invoke !== undefined,
    before: checked.set.candidates.length,
    kept: null,
    excluded: null,
    entries: Object.freeze([]),
  });
  let entries: readonly CandidateFilterEntry[] = Object.freeze([]);
  if (invoke !== undefined) {
    const request = Object.freeze({
      ...checked.prepared.request,
      candidates: checked.set,
    });
    const result = await invokeControlled<unknown>(control, (control) =>
      invoke(request, control),
    );
    if (result.outcome !== 'returned') {
      return Object.freeze({
        ...invocationFailure(result, 'filtering', null),
        checked,
        report: pendingReport,
      });
    }
    try {
      entries = parseFilterEntries(result.value, checked.set);
    } catch (error) {
      return Object.freeze({
        outcome: 'failed',
        stage: 'filtering',
        candidateId: null,
        reason: 'invalid_result',
        issue: candidateContractIssue(error),
        checked,
        report: pendingReport,
      });
    }
  }

  const removed = new Set(
    entries
      .filter((entry) => entry.outcome === 'excluded')
      .map((entry) => entry.candidateId),
  );
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.outcome === 'excluded')
      counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  }
  const id = `candidates:${randomUUID()}`;
  const candidates = Object.freeze(
    checked.set.candidates
      .filter((candidate) => !removed.has(candidate.id))
      .map((candidate) => Object.freeze({ ...candidate, candidateSetId: id })),
  );
  const set: CandidateSet = Object.freeze({
    ...checked.set,
    id,
    candidates,
    coverage: Object.freeze({
      ...checked.set.coverage,
      exclusions: Object.freeze([
        ...checked.set.coverage.exclusions,
        ...[...counts].map(([reason, count]) =>
          Object.freeze({ stage: 'filtering' as const, reason, count }),
        ),
      ]),
    }),
  });
  const stopped = control.signal.aborted
    ? 'cancelled'
    : Date.now() >= control.deadlineMs
      ? 'deadlineExceeded'
      : null;
  if (stopped !== null) {
    return Object.freeze({
      ...invocationFailure({ outcome: stopped }, 'filtering', null),
      checked,
      report: pendingReport,
    });
  }
  return Object.freeze({
    outcome: 'filtered',
    filtered: registerFilteredCandidates({
      checked,
      set,
      report: Object.freeze({
        configured: invoke !== undefined,
        before: checked.set.candidates.length,
        kept: candidates.length,
        excluded: removed.size,
        entries,
      }),
    }),
  });
}
