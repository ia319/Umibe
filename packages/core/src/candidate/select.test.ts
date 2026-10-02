import { getEventListeners } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import type { ActionRegistry } from '#internal/action/registry';
import type { Selector, SelectorRequest } from '#internal/contracts/adapters';
import type { SelectionResult } from '#internal/contracts/selection';
import { filterCandidates } from './filter.js';
import { selectCandidates } from './select.js';
import {
  actionRegistry,
  callControl,
  checkedBatch,
} from './__tests__/fixtures.js';

afterEach(() => vi.useRealTimers());

async function filteredBatch(
  registry: ActionRegistry,
  targets: readonly string[],
) {
  const result = await filterCandidates(
    await checkedBatch(registry, targets),
    callControl(),
  );
  if (result.outcome !== 'filtered')
    throw new Error('Expected filtered fixture');
  return result.filtered;
}

test.each(['selected', 'abstain'] as const)(
  'always invokes the selector for one candidate and preserves %s',
  async (outcome) => {
    const filtered = await filteredBatch(actionRegistry(), ['north']);
    const parent = new AbortController();
    const control = callControl(parent.signal);
    const select = vi.fn<Selector['select']>((request, invocation) => {
      expect(request.candidates).toBe(filtered.set);
      expect(request.context).toBe(filtered.checked.prepared.request.context);
      expect(request.requestId).toBe(
        filtered.checked.prepared.request.requestId,
      );
      expect(request.decisionEpoch).toBe(
        filtered.checked.prepared.request.decisionEpoch,
      );
      expect(Object.isFrozen(request)).toBe(true);
      expect(invocation.signal).not.toBe(parent.signal);
      expect(invocation.deadlineAt).toBe(control.deadlineAt);
      expect(
        Reflect.set(
          request.candidates.candidates[0]!.params,
          'target',
          'mutated',
        ),
      ).toBe(false);
      return Promise.resolve(
        outcome === 'selected'
          ? {
              outcome,
              decisionId: 'decision',
              candidateSetId: request.candidates.id,
              candidateId: request.candidates.candidates[0]!.id,
            }
          : {
              outcome,
              decisionId: 'decision',
              candidateSetId: request.candidates.id,
              reason: 'not_useful',
            },
      );
    });
    const result = await selectCandidates(filtered, { select }, control, 1);
    expect(result.outcome).toBe(outcome);
    if (result.outcome === 'selected') {
      expect(result.candidate).toBe(filtered.set.candidates[0]);
      expect(result.candidate.params).toBe(
        filtered.checked.prepared.set.candidates[0]!.params,
      );
      expect(result.selection.candidateSetId).toBe(filtered.set.id);
    } else if (result.outcome === 'abstain') {
      expect(result.selection.reason).toBe('not_useful');
      expect(result).not.toHaveProperty('candidate');
    }
    expect(select).toHaveBeenCalledOnce();
    expect(getEventListeners(parent.signal, 'abort')).toEqual([]);
  },
);

test('does not impose an implicit capacity or truncate a multi-candidate request', async () => {
  const filtered = await filteredBatch(
    actionRegistry(),
    Array.from({ length: 65 }, (_, index) => `target-${index}`),
  );
  const select = vi.fn<Selector['select']>((request) => {
    expect(request.candidates.candidates).toHaveLength(65);
    return Promise.resolve({
      outcome: 'selected',
      decisionId: 'last',
      candidateSetId: request.candidates.id,
      candidateId: request.candidates.candidates.at(-1)!.id,
    });
  });
  const result = await selectCandidates(filtered, { select }, callControl());
  expect(result).toMatchObject({
    outcome: 'selected',
    candidate: { params: { target: 'target-64' } },
  });
  expect(select).toHaveBeenCalledOnce();
});

test('checks capacity after filtering and preserves exact boundary behavior', async () => {
  const checked = await checkedBatch(actionRegistry(), [
    'north',
    'south',
    'east',
  ]);
  const unrestricted = await filterCandidates(checked, callControl());
  const reduced = await filterCandidates(checked, callControl(), {
    filter: (request) =>
      Promise.resolve({
        candidateSetId: request.candidates.id,
        entries: request.candidates.candidates.map((candidate) => ({
          candidateId: candidate.id,
          outcome: candidate.params.target === 'east' ? 'excluded' : 'kept',
          reason: 'app_policy',
        })),
      }),
  });
  if (unrestricted.outcome !== 'filtered' || reduced.outcome !== 'filtered')
    throw new Error('Expected filtered fixture');
  const select = vi.fn<Selector['select']>((request) =>
    Promise.resolve({
      outcome: 'abstain',
      reason: 'not_useful',
      decisionId: 'decision',
      candidateSetId: request.candidates.id,
    }),
  );
  expect(
    await selectCandidates(unrestricted.filtered, { select }, callControl(), 2),
  ).toMatchObject({
    outcome: 'candidate_limit',
    count: 3,
    capacity: 2,
  });
  expect(select).not.toHaveBeenCalled();
  expect(
    await selectCandidates(reduced.filtered, { select }, callControl(), 2),
  ).toMatchObject({ outcome: 'abstain' });
  expect(
    select.mock.calls[0]![0].candidates.candidates.map(
      (candidate) => candidate.params.target,
    ),
  ).toEqual(['north', 'south']);
  expect(unrestricted.filtered.set.candidates).toHaveLength(3);
});

test.each(['initially_empty', 'fully_filtered'] as const)(
  'returns no_candidates for %s without fabricating abstention',
  async (kind) => {
    const checked = await checkedBatch(
      actionRegistry(),
      kind === 'initially_empty' ? [] : ['north'],
    );
    const filtering = await filterCandidates(checked, callControl(), {
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
    if (filtering.outcome !== 'filtered')
      throw new Error('Expected filtered fixture');
    const select = vi.fn<Selector['select']>(() =>
      Promise.reject(new Error('must not select')),
    );
    const result = await selectCandidates(
      filtering.filtered,
      { select },
      callControl(),
      1,
    );
    expect(result.outcome).toBe('no_candidates');
    expect(result.filtered).toBe(filtering.filtered);
    expect(result).not.toHaveProperty('selection');
    expect(select).not.toHaveBeenCalled();
    expect(result.filtered.report.excluded).toBe(
      kind === 'fully_filtered' ? 1 : 0,
    );
  },
);

test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid capacity %s before selector invocation',
  async (capacity) => {
    const filtered = await filteredBatch(actionRegistry(), ['north']);
    const select = vi.fn<Selector['select']>(() =>
      Promise.reject(new Error('must not select')),
    );
    await expect(
      selectCandidates(filtered, { select }, callControl(), capacity),
    ).rejects.toMatchObject({
      code: 'INVALID_CANDIDATE_REQUEST',
      stage: 'candidate_selection',
      path: '/capacity',
    });
    expect(select).not.toHaveBeenCalled();
  },
);

test.each([
  'wrong_set',
  'excluded_id',
  'foreign_id',
  'extra_parameters',
  'contradictory',
  'empty_reason',
  'non_json',
] as const)(
  'rejects %s in the selector response without replacing the decision',
  async (fault) => {
    const checked = await checkedBatch(actionRegistry(), ['north', 'south']);
    const filtering = await filterCandidates(checked, callControl(), {
      filter: (request) =>
        Promise.resolve({
          candidateSetId: request.candidates.id,
          entries: request.candidates.candidates.map((candidate) => ({
            candidateId: candidate.id,
            outcome: candidate.params.target === 'north' ? 'kept' : 'excluded',
            reason: 'policy',
          })),
        }),
    });
    if (filtering.outcome !== 'filtered')
      throw new Error('Expected filtered fixture');
    const select = vi.fn((request: SelectorRequest) => {
      const selected = {
        outcome: 'selected',
        decisionId: 'decision',
        candidateSetId: request.candidates.id,
        candidateId: request.candidates.candidates[0]!.id,
      };
      switch (fault) {
        case 'wrong_set':
          selected.candidateSetId = checked.set.id;
          break;
        case 'excluded_id':
          selected.candidateId = checked.set.candidates[1]!.id;
          break;
        case 'foreign_id':
          selected.candidateId = 'external';
          break;
        case 'extra_parameters':
          Object.assign(selected, { params: { target: 'different' } });
          break;
        case 'contradictory':
          Object.assign(selected, { outcome: 'abstain', reason: 'no' });
          break;
        case 'empty_reason':
          return Promise.resolve({
            outcome: 'abstain',
            decisionId: 'decision',
            candidateSetId: request.candidates.id,
            reason: '',
          });
        case 'non_json':
          Object.assign(selected, { privateValue: Infinity });
          break;
      }
      return Promise.resolve(selected);
    });
    const result = await selectCandidates(
      filtering.filtered,
      // @ts-expect-error Deliberately simulate selector output that violates the declared contract.
      { select },
      callControl(),
    );
    expect(result).toMatchObject({
      outcome: 'failed',
      stage: 'selection',
      reason: 'invalid_result',
    });
    expect(result).not.toHaveProperty('selection');
    expect(result).not.toHaveProperty('candidate');
    if (result.outcome !== 'failed')
      throw new Error('Expected contract failure');
    expect(result.issue).not.toBeNull();
    expect(select).toHaveBeenCalledOnce();
  },
);

test.each(['throw', 'reject'] as const)(
  'reports a selector %s as callback failure without retry',
  async (kind) => {
    const filtered = await filteredBatch(actionRegistry(), ['north']);
    const select = vi.fn<Selector['select']>(() => {
      if (kind === 'throw') throw new Error('private failure');
      return Promise.reject(new Error('private failure'));
    });
    const result = await selectCandidates(filtered, { select }, callControl());
    expect(result).toMatchObject({
      outcome: 'failed',
      reason: 'callback_failed',
      issue: null,
    });
    expect(JSON.stringify(result)).not.toContain('private failure');
    expect(select).toHaveBeenCalledOnce();
  },
);

test.each(['cancelled', 'deadlineExceeded'] as const)(
  'discards a late selector answer after %s',
  async (outcome) => {
    vi.useFakeTimers();
    const filtered = await filteredBatch(actionRegistry(), ['north']);
    const parent = new AbortController();
    let resolve!: (value: SelectionResult) => void;
    let reject!: (reason: unknown) => void;
    let signal: AbortSignal | undefined;
    const select = vi.fn<Selector['select']>((_request, control) => {
      signal = control.signal;
      return new Promise((done, fail) => {
        resolve = done;
        reject = fail;
      });
    });
    const pending = selectCandidates(
      filtered,
      { select },
      {
        signal: parent.signal,
        deadlineAt: new Date(Date.now() + 20).toISOString(),
      },
    );
    if (outcome === 'cancelled') parent.abort();
    else await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toMatchObject({ outcome, stage: 'selection' });
    expect(signal?.aborted).toBe(true);
    expect(getEventListeners(parent.signal, 'abort')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    if (outcome === 'cancelled')
      resolve({
        outcome: 'selected',
        decisionId: 'late',
        candidateSetId: filtered.set.id,
        candidateId: filtered.set.candidates[0]!.id,
      });
    else reject(new Error('late failure'));
    await Promise.resolve();
    expect(select).toHaveBeenCalledOnce();
  },
);

test('enforces control before the empty branch and after result validation', async () => {
  const empty = await filteredBatch(actionRegistry(), []);
  const parent = new AbortController();
  parent.abort();
  const select = vi.fn<Selector['select']>(() =>
    Promise.reject(new Error('must not select')),
  );
  expect(
    await selectCandidates(empty, { select }, callControl(parent.signal)),
  ).toMatchObject({ outcome: 'cancelled' });
  expect(select).not.toHaveBeenCalled();

  const filtered = await filteredBatch(actionRegistry(), ['north']);
  const lateParent = new AbortController();
  const answer: SelectionResult = new Proxy(
    {
      outcome: 'selected' as const,
      decisionId: 'decision',
      candidateSetId: filtered.set.id,
      candidateId: filtered.set.candidates[0]!.id,
    },
    {
      ownKeys(target) {
        lateParent.abort();
        return Reflect.ownKeys(target);
      },
    },
  );
  expect(
    await selectCandidates(
      filtered,
      { select: () => Promise.resolve(answer) },
      callControl(lateParent.signal),
    ),
  ).toMatchObject({ outcome: 'cancelled', stage: 'selection' });
});

test('rejects copied filter results and invalid selector definitions', async () => {
  const filtered = await filteredBatch(actionRegistry(), ['north']);
  const select = vi.fn<Selector['select']>(() =>
    Promise.reject(new Error('must not select')),
  );
  await expect(
    selectCandidates({ ...filtered }, { select }, callControl()),
  ).rejects.toMatchObject({ reason: 'unfiltered_candidates' });
  await expect(
    // @ts-expect-error A selector definition must provide its select method.
    selectCandidates(filtered, {}, callControl()),
  ).rejects.toMatchObject({ reason: 'expected_selector' });
  expect(select).not.toHaveBeenCalled();
});
