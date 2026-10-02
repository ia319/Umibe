import { getEventListeners } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import type { ActionCheck } from '#internal/contracts/action';
import type {
  CandidateFilter,
  CandidateFilterRequest,
} from '#internal/contracts/adapters';
import { parseCandidateSet } from '#internal/validation/candidate';
import { filterCandidates } from './filter.js';
import {
  actionRegistry,
  callControl,
  checkedBatch,
} from './__tests__/fixtures.js';

afterEach(() => vi.useRealTimers());

test('omitting a filter preserves all allowed calls and creates a separate set for each round', async () => {
  const checked = await checkedBatch(actionRegistry(), ['north', 'south']);
  const [one, two] = await Promise.all([
    filterCandidates(checked, callControl()),
    filterCandidates(checked, callControl()),
  ]);
  if (one.outcome !== 'filtered' || two.outcome !== 'filtered')
    throw new Error('Expected filtered result');
  expect(one.filtered.report).toEqual({
    configured: false,
    before: 2,
    kept: 2,
    excluded: 0,
    entries: [],
  });
  expect(one.filtered.set.id).not.toBe(checked.set.id);
  expect(one.filtered.set.id).not.toBe(two.filtered.set.id);
  for (const [index, candidate] of one.filtered.set.candidates.entries()) {
    const original = checked.set.candidates[index]!;
    expect(candidate).toEqual({
      ...original,
      candidateSetId: one.filtered.set.id,
    });
    expect(candidate.params).toBe(original.params);
    expect(candidate.paramSources).toBe(original.paramSources);
    expect(Object.isFrozen(candidate)).toBe(true);
  }
  expect(parseCandidateSet(one.filtered.set)).toEqual(one.filtered.set);
  expect(checked.set.candidates).toHaveLength(2);
});

test('validates a complete partition, preserves input order and records exclusion reasons', async () => {
  const checked = await checkedBatch(actionRegistry(), [
    'north',
    'south',
    'east',
  ]);
  const filter: CandidateFilter = {
    filter(request, control) {
      expect(request.context).toBe(checked.prepared.request.context);
      expect(request.capabilities).toBe(checked.prepared.request.capabilities);
      expect(request.requestId).toBe(checked.prepared.request.requestId);
      expect(request.decisionEpoch).toBe(
        checked.prepared.request.decisionEpoch,
      );
      expect(control.signal).toBeInstanceOf(AbortSignal);
      expect(
        Reflect.set(request.context.effectiveConstraints, 'maxCount', 99),
      ).toBe(false);
      return Promise.resolve({
        candidateSetId: request.candidates.id,
        entries: [...request.candidates.candidates]
          .reverse()
          .map((candidate) => ({
            candidateId: candidate.id,
            outcome:
              candidate.params.target === 'south'
                ? ('excluded' as const)
                : ('kept' as const),
            reason:
              candidate.params.target === 'south'
                ? 'protected_area'
                : 'preferred_area',
          })),
      });
    },
  };
  const result = await filterCandidates(checked, callControl(), filter);
  if (result.outcome !== 'filtered')
    throw new Error('Expected filtered result');
  expect(
    result.filtered.set.candidates.map((candidate) => candidate.params.target),
  ).toEqual(['north', 'east']);
  expect(
    result.filtered.report.entries.map((entry) => entry.candidateId),
  ).toEqual(checked.set.candidates.map((candidate) => candidate.id));
  expect(result.filtered.report).toMatchObject({
    configured: true,
    before: 3,
    kept: 2,
    excluded: 1,
  });
  expect(result.filtered.set.coverage.exclusions).toEqual([
    { stage: 'filtering', reason: 'protected_area', count: 1 },
  ]);
  expect(Object.isFrozen(result.filtered.report.entries[0])).toBe(true);
  expect(parseCandidateSet(result.filtered.set)).toEqual(result.filtered.set);
});

test.each([
  'wrong_set',
  'duplicate',
  'omitted',
  'foreign',
  'empty_reason',
  'invalid_outcome',
  'extra_parameters',
  'non_json',
] as const)(
  'rejects %s without accepting a partial filter result',
  async (fault) => {
    const checked = await checkedBatch(actionRegistry(), ['north', 'south']);
    const filter = {
      filter(request: CandidateFilterRequest) {
        const entries = request.candidates.candidates.map((candidate) => ({
          candidateId: candidate.id,
          outcome: 'kept',
          reason: 'policy',
        }));
        const result = { candidateSetId: request.candidates.id, entries };
        switch (fault) {
          case 'wrong_set':
            result.candidateSetId = 'other';
            break;
          case 'duplicate':
            entries.push(entries[0]!);
            break;
          case 'omitted':
            entries.pop();
            break;
          case 'foreign':
            entries[0]!.candidateId = 'other';
            break;
          case 'empty_reason':
            entries[0]!.reason = '';
            break;
          case 'invalid_outcome':
            entries[0]!.outcome = 'selected';
            break;
          case 'extra_parameters':
            Object.assign(entries[0]!, { params: {} });
            break;
          case 'non_json':
            Object.assign(entries[0]!, { invalid: Infinity });
            break;
        }
        return Promise.resolve(result);
      },
    };
    // @ts-expect-error Simulate an adapter violating the declared filter-result contract.
    const result = await filterCandidates(checked, callControl(), filter);
    expect(result).toMatchObject({
      outcome: 'failed',
      stage: 'filtering',
      reason: 'invalid_result',
      report: { before: 2, kept: null, excluded: null, entries: [] },
    });
    expect(result).not.toHaveProperty('filtered');
    if (result.outcome === 'filtered')
      throw new Error('Expected invalid output');
    expect(result.issue).not.toBeNull();
    expect(checked.set.candidates).toHaveLength(2);
  },
);

test('rejects copied check tokens and attempts to restore dynamically denied calls', async () => {
  const checked = await checkedBatch(
    actionRegistry(undefined, (_context, params) =>
      Promise.resolve<ActionCheck>(
        params.target === 'south'
          ? { outcome: 'denied', reason: 'no_permission' }
          : { outcome: 'allowed' },
      ),
    ),
    ['north', 'south'],
  );
  const invoke = vi.fn((request: CandidateFilterRequest) =>
    Promise.resolve({
      candidateSetId: request.candidates.id,
      entries: checked.prepared.set.candidates.map((candidate) => ({
        candidateId: candidate.id,
        outcome: 'kept' as const,
        reason: 'include',
      })),
    }),
  );
  await expect(
    filterCandidates({ ...checked }, callControl(), { filter: invoke }),
  ).rejects.toMatchObject({ reason: 'unchecked_candidates' });
  expect(invoke).not.toHaveBeenCalled();
  const result = await filterCandidates(checked, callControl(), {
    filter: invoke,
  });
  expect(result).toMatchObject({
    outcome: 'failed',
    issue: { reason: 'unknown_candidate' },
  });
});

test('retains prior checking diagnostics when policy excludes every allowed call', async () => {
  const checked = await checkedBatch(
    actionRegistry(undefined, (_context, params) =>
      Promise.resolve<ActionCheck>(
        params.target === 'unknown'
          ? { outcome: 'unknown', reason: 'missing_map' }
          : { outcome: 'allowed' },
      ),
    ),
    ['north', 'south', 'unknown'],
  );
  const result = await filterCandidates(checked, callControl(), {
    filter: (request) =>
      Promise.resolve({
        candidateSetId: request.candidates.id,
        entries: request.candidates.candidates.map((candidate) => ({
          candidateId: candidate.id,
          outcome: 'excluded',
          reason: 'policy',
        })),
      }),
  });
  if (result.outcome !== 'filtered')
    throw new Error('Expected filtered result');
  expect(result.filtered.set.candidates).toEqual([]);
  expect(result.filtered.report).toMatchObject({
    before: 2,
    kept: 0,
    excluded: 2,
  });
  expect(result.filtered.set.coverage.informationGaps).toEqual(
    checked.set.coverage.informationGaps,
  );
  expect(result.filtered.set.coverage.exclusions).toEqual([
    ...checked.set.coverage.exclusions,
    { stage: 'filtering', reason: 'policy', count: 2 },
  ]);
  expect(parseCandidateSet(result.filtered.set)).toEqual(result.filtered.set);
});

test('supports an empty batch and rejects invalid filter definitions before invocation', async () => {
  const checked = await checkedBatch(actionRegistry(), []);
  expect(await filterCandidates(checked, callControl())).toMatchObject({
    outcome: 'filtered',
    filtered: { report: { before: 0, kept: 0, excluded: 0 } },
  });
  await expect(
    // @ts-expect-error A filter definition must expose the filter method.
    filterCandidates(checked, callControl(), {}),
  ).rejects.toMatchObject({ reason: 'expected_candidate_filter' });
});

test.each(['cancelled', 'deadlineExceeded'] as const)(
  'stops on %s and consumes late filter rejection',
  async (outcome) => {
    vi.useFakeTimers();
    const checked = await checkedBatch(actionRegistry(), ['north']);
    const parent = new AbortController();
    let reject!: (reason: unknown) => void;
    let signal: AbortSignal | undefined;
    const pending = filterCandidates(
      checked,
      {
        signal: parent.signal,
        deadlineAt: new Date(Date.now() + 20).toISOString(),
      },
      {
        filter(_request, control) {
          signal = control.signal;
          return new Promise<never>((_resolve, fail) => {
            reject = fail;
          });
        },
      },
    );
    if (outcome === 'cancelled') parent.abort();
    else await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toMatchObject({
      outcome,
      stage: 'filtering',
      report: { kept: null },
    });
    expect(signal?.aborted).toBe(true);
    expect(getEventListeners(parent.signal, 'abort')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    reject(new Error('late filter failure'));
    await Promise.resolve();
  },
);

test('distinguishes a thrown callback from invalid output and honors cancellation without a filter', async () => {
  const checked = await checkedBatch(actionRegistry(), ['north']);
  const invoke = vi.fn(() => {
    throw new Error('private adapter detail');
  });
  const result = await filterCandidates(checked, callControl(), {
    filter: invoke,
  });
  expect(result).toMatchObject({
    outcome: 'failed',
    reason: 'callback_failed',
    issue: null,
  });
  expect(JSON.stringify(result)).not.toContain('private adapter detail');
  const parent = new AbortController();
  parent.abort();
  expect(
    await filterCandidates(checked, callControl(parent.signal)),
  ).toMatchObject({ outcome: 'cancelled', report: { kept: null } });
});
