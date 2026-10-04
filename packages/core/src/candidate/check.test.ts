import { getEventListeners } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { ActionRegistry, defineAction } from '#internal/action/registry';
import type { ActionCheck } from '#internal/contracts/action';
import type { CallControl } from '#internal/contracts/control';
import type { DecisionContext } from '#internal/contracts/context';
import type { CandidateCheckingResult } from '#internal/contracts/candidate-processing';
import type { JsonObject } from '#internal/contracts/json';
import { ContractError } from '#internal/errors';
import { parseCandidateSet } from '#internal/validation/candidate';
import { parseObservation } from '#internal/validation/observation';
import { checkCandidates } from './check.js';
import { prepareCandidates } from './prepare.js';
import {
  actionRegistry,
  callControl,
  candidateSet,
  generationInput,
} from './__tests__/fixtures.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function preparedBatch(
  registry: ActionRegistry,
  targets: readonly string[],
) {
  const result = await prepareCandidates(
    generationInput(),
    registry,
    {
      generate: (request) =>
        Promise.resolve(
          candidateSet(
            request,
            targets.map((target, index) => ({
              id: `proposal-${index}`,
              params: { target },
            })),
          ),
        ),
    },
    callControl(),
  );
  if (result.outcome !== 'prepared')
    throw new Error('Expected prepared fixture');
  return result.prepared;
}

test('checks every distinct call despite provider coverage and keeps the exact context and normalized parameters', async () => {
  let defaults = 0;
  const seen: {
    context: DecisionContext;
    params: JsonObject;
    control: CallControl;
  }[] = [];
  const execute = vi.fn(() => Promise.reject(new Error('must not execute')));
  const action = defineAction({
    id: 'collect',
    version: 1,
    description: 'Collect samples',
    tags: [],
    expectedEffects: {},
    parameters: z.object({
      target: z.string(),
      count: z.number().default(() => {
        defaults += 1;
        return 2;
      }),
    }),
    check(context, params, control) {
      seen.push({ context, params, control });
      return Promise.resolve<ActionCheck>({ outcome: 'allowed' });
    },
    execute,
  });
  const registeredDefaults = defaults;
  const prepared = await preparedBatch(new ActionRegistry([action]), [
    'north',
    'north',
    'south',
  ]);
  expect(defaults - registeredDefaults).toBe(3);
  expect(prepared.providerSet.coverage.checking).toBe('complete');
  const parent = new AbortController();
  const control = callControl(parent.signal);
  const result = await checkCandidates(prepared, control);
  if (result.outcome !== 'checked')
    throw new Error('Expected completed checks');
  const { checked } = result;
  expect(seen).toHaveLength(2);
  for (const [index, entry] of seen.entries()) {
    expect(entry.params).toBe(prepared.set.candidates[index]!.params);
    expect(entry.context).toBe(prepared.request.context);
    expect(entry.context.effectiveConstraints.maxCount).toBe(2);
    expect(Object.isFrozen(entry.context.effectiveConstraints.protected)).toBe(
      true,
    );
    expect(Reflect.set(entry.params, 'count', 99)).toBe(false);
    expect(entry.control.signal).not.toBe(parent.signal);
    expect(entry.control.deadlineAt).toBe(control.deadlineAt);
  }
  expect(seen[0]?.control.signal).not.toBe(seen[1]?.control.signal);
  expect(defaults - registeredDefaults).toBe(3);
  expect(checked.set.candidates[0]).toBe(prepared.set.candidates[0]);
  expect(checked.report).toMatchObject({
    total: 2,
    completed: 2,
    allowed: 2,
    denied: 0,
    unknown: 0,
    remaining: 0,
  });
  expect(checked.report.entries[0]?.providerCandidateIds).toEqual([
    'proposal-0',
    'proposal-1',
  ]);
  expect(checked.report.entries[1]?.providerCandidateIds).toEqual([
    'proposal-2',
  ]);
  expect(checked.set.coverage).toMatchObject({
    checking: 'complete',
    uncheckedScopes: [],
  });
  expect(parseCandidateSet(checked.set)).toEqual(checked.set);
  expect(Object.isFrozen(checked.report.entries[0]?.result)).toBe(true);
  expect(getEventListeners(parent.signal, 'abort')).toEqual([]);
  expect(execute).not.toHaveBeenCalled();
});

test('checks in provider order without overlapping callbacks', async () => {
  let release!: (value: ActionCheck) => void;
  const gate = new Promise<ActionCheck>((resolve) => {
    release = resolve;
  });
  const seen: JsonObject[] = [];
  const check = vi.fn((_context: DecisionContext, params: JsonObject) => {
    seen.push(params);
    return gate;
  });
  const prepared = await preparedBatch(actionRegistry(undefined, check), [
    'north',
    'south',
  ]);
  const result = checkCandidates(prepared, callControl());
  expect(check).toHaveBeenCalledTimes(1);
  await Promise.resolve();
  expect(check).toHaveBeenCalledTimes(1);
  release({ outcome: 'allowed' });
  expect((await result).outcome).toBe('checked');
  expect(check).toHaveBeenCalledTimes(2);
  expect(seen.map((params) => params.target)).toEqual(['north', 'south']);
});

test('separates confirmed absence and permission denial from unknown, unobserved and stale facts', async () => {
  const input = generationInput();
  const context = {
    ...input.context,
    observation: parseObservation({
      ...input.context.observation,
      coverage: {
        scope: 'nearby',
        completeness: 'partial',
        uncheckedScopes: ['unseen facts'],
      },
      data: {
        present: { status: 'known', value: true },
        removed: { status: 'absent' },
        forbidden: { status: 'known', value: false },
        uncertain: { status: 'unknown', reason: 'sensor offline' },
        unseen: { status: 'unobserved' },
        old: {
          status: 'stale',
          lastKnown: true,
          lastObservedAt: '2026-10-01T00:00:00.000Z',
        },
      },
    }),
  };
  const registry = new ActionRegistry([
    defineAction({
      id: 'collect',
      version: 1,
      description: 'Collect samples',
      tags: [],
      expectedEffects: {},
      parameters: z.object({ target: z.string() }),
      check(current, params) {
        const fact = current.observation.data[params.target];
        if (fact?.status === 'absent')
          return Promise.resolve<ActionCheck>({
            outcome: 'denied',
            reason: 'target_missing',
          });
        if (fact?.status === 'known')
          return Promise.resolve<ActionCheck>(
            fact.value === true
              ? { outcome: 'allowed' }
              : { outcome: 'denied', reason: 'permission_denied' },
          );
        return Promise.resolve<ActionCheck>({
          outcome: 'unknown',
          reason: `fact_${fact?.status ?? 'missing'}`,
        });
      },
      execute: () => Promise.reject(new Error('must not execute')),
    }),
  ]);
  const preparation = await prepareCandidates(
    { ...input, context },
    registry,
    {
      generate: (request) =>
        Promise.resolve(
          candidateSet(
            request,
            [
              'present',
              'removed',
              'forbidden',
              'uncertain',
              'unseen',
              'old',
              'missing',
            ].map((target) => ({ id: target, params: { target } })),
          ),
        ),
    },
    callControl(),
  );
  if (preparation.outcome !== 'prepared')
    throw new Error('Expected prepared fixture');
  const result = await checkCandidates(preparation.prepared, callControl());
  if (result.outcome !== 'checked')
    throw new Error('Expected completed checks');
  expect(result.checked.report).toMatchObject({
    total: 7,
    completed: 7,
    allowed: 1,
    denied: 2,
    unknown: 4,
    remaining: 0,
  });
  expect(
    result.checked.set.candidates.map((candidate) => candidate.params.target),
  ).toEqual(['present']);
  expect(result.checked.report.entries.map((entry) => entry.result)).toEqual([
    { outcome: 'allowed' },
    { outcome: 'denied', reason: 'target_missing' },
    { outcome: 'denied', reason: 'permission_denied' },
    { outcome: 'unknown', reason: 'fact_unknown' },
    { outcome: 'unknown', reason: 'fact_unobserved' },
    { outcome: 'unknown', reason: 'fact_stale' },
    { outcome: 'unknown', reason: 'fact_missing' },
  ]);
  expect(result.checked.set.coverage.checking).toBe('complete');
  expect(result.checked.set.coverage.informationGaps).toHaveLength(4);
  expect(parseCandidateSet(result.checked.set)).toEqual(result.checked.set);
});

test('preserves provider gaps and counts separately when every call is excluded', async () => {
  const input = generationInput();
  let calls = 0;
  const registry = actionRegistry(undefined, () =>
    Promise.resolve<ActionCheck>(
      ++calls === 1
        ? { outcome: 'denied', reason: 'unavailable' }
        : { outcome: 'unknown', reason: 'unavailable' },
    ),
  );
  const preparation = await prepareCandidates(
    input,
    registry,
    {
      generate(request) {
        const set = candidateSet(request, [
          { id: 'invalid', params: { target: 'invalid', count: 0 } },
          { id: 'first', params: { target: 'north' } },
          { id: 'second', params: { target: 'south' } },
        ]);
        return Promise.resolve({
          ...set,
          coverage: {
            generation: 'partial' as const,
            checking: 'partial' as const,
            truncated: true,
            uncheckedScopes: ['unseen area'],
            informationGaps: ['missing map'],
            capabilityGaps: ['scanner'],
            exclusions: [
              { stage: 'checking' as const, reason: 'unavailable', count: 9 },
            ],
          },
        });
      },
    },
    callControl(),
  );
  if (preparation.outcome !== 'prepared')
    throw new Error('Expected prepared fixture');
  const result = await checkCandidates(preparation.prepared, callControl());
  if (result.outcome !== 'checked')
    throw new Error('Expected completed checks');
  expect(result.checked.set.candidates).toEqual([]);
  expect(result.checked.report).toMatchObject({
    total: 2,
    completed: 2,
    allowed: 0,
    denied: 1,
    unknown: 1,
    remaining: 0,
  });
  expect(result.checked.set.coverage).toMatchObject({
    generation: 'partial',
    checking: 'partial',
    truncated: true,
    uncheckedScopes: ['unseen area'],
    capabilityGaps: ['scanner'],
    exclusions: [
      { stage: 'checking', reason: 'schema_too_small', count: 1 },
      { stage: 'checking', reason: 'denied:unavailable', count: 1 },
      { stage: 'checking', reason: 'unknown:unavailable', count: 1 },
    ],
  });
  expect(result.checked.set.coverage.informationGaps[0]).toBe('missing map');
  expect(
    result.checked.prepared.providerSet.coverage.exclusions[0]?.count,
  ).toBe(9);
  expect(parseCandidateSet(result.checked.set)).toEqual(result.checked.set);
});

test.each([
  null,
  [],
  { outcome: 'maybe' },
  { outcome: 'allowed', reason: 'extra' },
  { outcome: 'denied' },
  { outcome: 'unknown', reason: '' },
  { outcome: 'denied', reason: 'no', extra: 1 },
  { outcome: 'allowed', secret: Infinity },
])(
  'fails the round on malformed check output %j and retains earlier completed diagnostics',
  async (raw) => {
    let count = 0;
    const callback = vi.fn(() =>
      Promise.resolve(++count === 1 ? { outcome: 'allowed' as const } : raw),
    );
    // @ts-expect-error Deliberately simulate an adapter violating its declared ActionCheck result.
    const prepared = await preparedBatch(actionRegistry(undefined, callback), [
      'north',
      'south',
      'east',
    ]);
    const result = await checkCandidates(prepared, callControl());
    expect(result).toMatchObject({
      outcome: 'failed',
      stage: 'checking',
      candidateId: prepared.set.candidates[1]!.id,
      reason: 'invalid_result',
      report: {
        completed: 1,
        allowed: 1,
        remaining: 2,
        coverage: { checking: 'partial' },
      },
    });
    expect(result).not.toHaveProperty('checked');
    if (result.outcome === 'checked') throw new Error('Expected failure');
    expect(result.issue).not.toBeNull();
    expect(result.report.coverage.uncheckedScopes).toEqual(
      prepared.set.candidates
        .slice(1)
        .map((candidate) => `core:candidate:${candidate.id}`),
    );
    expect(callback).toHaveBeenCalledTimes(2);
  },
);

test.each(['throw', 'reject', 'contract'] as const)(
  'reports %s as callback failure rather than denial or malformed output',
  async (mode) => {
    const check = vi.fn(() => {
      const error =
        mode === 'contract'
          ? new ContractError(
              'INVALID_ACTION_CHECK',
              'adapter',
              '',
              'private_reason',
            )
          : new Error('private_details');
      if (mode === 'reject') return Promise.reject(error);
      throw error;
    });
    const prepared = await preparedBatch(actionRegistry(undefined, check), [
      'north',
      'south',
    ]);
    const result = await checkCandidates(prepared, callControl());
    expect(result).toMatchObject({
      outcome: 'failed',
      reason: 'callback_failed',
      issue: null,
      report: { completed: 0, remaining: 2 },
    });
    expect(check).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('private_');
  },
);

test.each(['cancelled', 'deadlineExceeded'] as const)(
  'stops on %s without accepting late output or starting the next check',
  async (outcome) => {
    vi.useFakeTimers();
    let settle!: (value: ActionCheck) => void;
    let reject!: (reason: unknown) => void;
    const signals: AbortSignal[] = [];
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    const registry = actionRegistry(undefined, (_context, _params, control) => {
      signals.push(control.signal);
      if (++calls === 1) return Promise.resolve({ outcome: 'allowed' });
      entered();
      return new Promise<ActionCheck>((resolve, fail) => {
        settle = resolve;
        reject = fail;
      });
    });
    const prepared = await preparedBatch(registry, ['north', 'south', 'east']);
    const parent = new AbortController();
    const control = {
      signal: parent.signal,
      deadlineAt: new Date(Date.now() + 20).toISOString(),
    };
    const pending = checkCandidates(prepared, control);
    await started;
    if (outcome === 'cancelled') parent.abort();
    else await vi.advanceTimersByTimeAsync(20);
    const result = await pending;
    expect(result).toMatchObject({
      outcome,
      stage: 'checking',
      candidateId: prepared.set.candidates[1]?.id,
      report: {
        completed: 1,
        allowed: 1,
        remaining: 2,
        coverage: { checking: 'partial' },
      },
    });
    expect(signals[1]?.aborted).toBe(true);
    expect(getEventListeners(parent.signal, 'abort')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    if (outcome === 'cancelled') settle({ outcome: 'allowed' });
    else reject(new Error('late rejection'));
    await Promise.resolve();
    expect(calls).toBe(2);
  },
);

test('rejects exact-deadline results and never starts checks on cancelled or expired batches', async () => {
  vi.useFakeTimers();
  const check = vi.fn(() =>
    Promise.resolve<ActionCheck>({ outcome: 'allowed' }),
  );
  const prepared = await preparedBatch(actionRegistry(undefined, check), [
    'north',
  ]);
  const parent = new AbortController();
  parent.abort();
  expect(
    (await checkCandidates(prepared, callControl(parent.signal))).outcome,
  ).toBe('cancelled');
  expect(
    (
      await checkCandidates(prepared, {
        ...callControl(),
        deadlineAt: new Date().toISOString(),
      })
    ).outcome,
  ).toBe('deadlineExceeded');
  expect(check).not.toHaveBeenCalled();
  const control = callControl();
  check.mockImplementationOnce(() => {
    vi.setSystemTime(new Date(control.deadlineAt));
    return Promise.resolve({ outcome: 'allowed' });
  });
  expect(await checkCandidates(prepared, control)).toMatchObject({
    outcome: 'deadlineExceeded',
    report: { completed: 0, remaining: 1 },
  });
  expect(vi.getTimerCount()).toBe(0);
});

test('handles empty batches without inventing capability claims and honors cancellation', async () => {
  const check = vi.fn(() =>
    Promise.resolve<ActionCheck>({ outcome: 'allowed' }),
  );
  const prepared = await preparedBatch(actionRegistry(undefined, check), []);
  const result = await checkCandidates(prepared, callControl());
  expect(result).toMatchObject({
    outcome: 'checked',
    checked: {
      set: { candidates: [] },
      report: { total: 0, completed: 0, remaining: 0 },
    },
  });
  const parent = new AbortController();
  parent.abort();
  const cancelled = await checkCandidates(prepared, callControl(parent.signal));
  expect(cancelled).toMatchObject({
    outcome: 'cancelled',
    report: {
      remaining: 0,
      coverage: { checking: 'partial', uncheckedScopes: ['core:checking'] },
    },
  });
  expect(check).not.toHaveBeenCalled();
});

test('does not accept a result when cancellation arrives during its validation', async () => {
  const parent = new AbortController();
  const raw: ActionCheck = new Proxy(
    { outcome: 'allowed' as const },
    {
      ownKeys(target) {
        parent.abort();
        return Reflect.ownKeys(target);
      },
    },
  );
  const prepared = await preparedBatch(
    actionRegistry(undefined, () => Promise.resolve(raw)),
    ['north'],
  );
  expect(
    await checkCandidates(prepared, callControl(parent.signal)),
  ).toMatchObject({
    outcome: 'cancelled',
    report: { completed: 0, remaining: 1 },
  });
});

test('rejects copied preparation tokens and isolates concurrent checking reports', async () => {
  let calls = 0;
  const prepared = await preparedBatch(
    actionRegistry(undefined, () =>
      Promise.resolve<ActionCheck>(
        ++calls === 1
          ? { outcome: 'allowed' }
          : { outcome: 'denied', reason: 'changed_permission' },
      ),
    ),
    ['north'],
  );
  await expect(
    checkCandidates({ ...prepared }, callControl()),
  ).rejects.toMatchObject({ reason: 'unprepared_candidates' });
  expect(calls).toBe(0);
  const results: CandidateCheckingResult[] = await Promise.all([
    checkCandidates(prepared, callControl()),
    checkCandidates(prepared, callControl()),
  ]);
  expect(results[0]).toMatchObject({
    outcome: 'checked',
    checked: { report: { allowed: 1, denied: 0 } },
  });
  expect(results[1]).toMatchObject({
    outcome: 'checked',
    checked: { report: { allowed: 0, denied: 1 } },
  });
  expect(prepared.set.candidates).toHaveLength(1);
  expect(prepared.set.coverage.checking).toBe('partial');
});
