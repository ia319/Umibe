import { afterEach, expect, test, vi } from 'vitest';
import type { CallControl } from '#internal/contracts/control';
import type {
  ModelResponseMetadata,
  ModelChoiceMetadata,
} from '#internal/model/metadata';
import {
  callControl,
  generationInput,
} from '#internal/candidate/__tests__/fixtures';
import { captureControl, invokeControlled } from '#internal/candidate/control';
import { MemoryRunStore } from '#internal/storage/memory';
import { RunSession } from './session.js';
import { invokeModel, ModelRequestError } from './model.js';

const basis = {
  requestId: 'model',
  decisionEpoch: 3,
  purpose: 'planning',
  model: { provider: 'fixture', model: 'configured' },
} as const;
const metadata = {
  model: 'actual',
  requestId: 'response',
  usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
};
const choice: ModelChoiceMetadata = {
  candidateSetId: 'candidates',
  optionId: 'a',
  options: [
    { id: 'a', candidateId: 'candidate-a', probability: 0.8 },
    { id: 'none', candidateId: null, probability: 0.2 },
  ],
  confidence: 0.04,
};
afterEach(() => vi.useRealTimers());

async function closeSession(session: RunSession): Promise<void> {
  await session.transition({
    kind: 'cancel',
    cause: { eventId: 'cleanup', reasonCode: 'test_finished' },
  });
  await session.transition({ kind: 'stopSettled', blocker: null });
  await session.close();
}

test.each([false, true])(
  'records the first caught error per report channel without failing the attempt (corrected: %s)',
  async (corrected) => {
    const store = new MemoryRunStore();
    const session = await RunSession.create(store, generationInput(), vi.fn());
    await session.transition({ kind: 'start' });
    const result = await invokeModel(
      session,
      basis,
      callControl(),
      (control) => {
        expect(() =>
          control.reportModelResponse!({
            model: 'rejected-response',
            requestId: 'must-not-persist',
            usage: { ...metadata.usage, inputTokens: -1 },
          }),
        ).toThrow(ModelRequestError);
        expect(() =>
          control.reportModelChoice!({
            ...choice,
            candidateSetId: 'rejected-choice',
            confidence: 2,
          }),
        ).toThrow(ModelRequestError);
        expect(() =>
          control.reportModelResponse!({ ...metadata, model: '' }),
        ).toThrow(ModelRequestError);
        expect(() =>
          control.reportModelChoice!({ ...choice, optionId: 'foreign' }),
        ).toThrow(ModelRequestError);
        if (corrected) {
          control.reportModelResponse!(metadata);
          control.reportModelChoice!(choice);
        }
        return Promise.resolve({ value: 'usable-result', usage: null });
      },
    );
    expect(result).toEqual({
      outcome: 'returned',
      value: 'usable-result',
      usage: corrected ? metadata.usage : null,
    });
    const records = (await store.readRecords('run', null, 100)).records;
    expect(records.at(-1)).toMatchObject({
      data: {
        type: 'model_finished',
        reasonCode: 'returned',
        details: {
          response: corrected ? metadata : null,
          usage: corrected ? metadata.usage : null,
          reportIssues: {
            response: {
              phase: 'protocol',
              path: '/usage/inputTokens',
              reason: 'expected_integer',
            },
            choice: {
              phase: 'protocol',
              path: '/confidence',
              reason: 'invalid_probability',
            },
          },
        },
      },
    });
    if (corrected)
      expect(records.at(-1)).toHaveProperty('data.details.choice', choice);
    else expect(records.at(-1)).not.toHaveProperty('data.details.choice');
    expect(records.at(-1)).not.toHaveProperty('data.details.issue');
    for (const rejected of [
      'rejected-response',
      'rejected-choice',
      'must-not-persist',
    ])
      expect(JSON.stringify(records)).not.toContain(rejected);
    expect(session.state.modelAttempts).toBe(1);
    await closeSession(session);
  },
);

test.each(['unsafe/key', 'x'.repeat(257)])(
  'bounds report diagnostics and excludes rejected values for field %s',
  async (field) => {
    const store = new MemoryRunStore();
    const session = await RunSession.create(store, generationInput(), vi.fn());
    await session.transition({ kind: 'start' });
    await invokeModel(session, basis, callControl(), (control) => {
      const report = { ...metadata, [field]: 'must-not-persist' };
      expect(() => control.reportModelResponse!(report)).toThrow(
        ModelRequestError,
      );
      return Promise.resolve({ value: 'ok', usage: null });
    });
    const records = (await store.readRecords('run', null, 100)).records;
    expect(records.at(-1)).toHaveProperty('data.details.reportIssues', {
      response: { phase: 'protocol', path: '', reason: 'unknown_field' },
    });
    expect(JSON.stringify(records)).not.toContain('must-not-persist');
    expect(JSON.stringify(records)).not.toContain(field);
    await closeSession(session);
  },
);

test.each(['cancelled', 'invalidated', 'deadlineExceeded'] as const)(
  'ignores the first invalid report received after %s',
  async (outcome) => {
    vi.useFakeTimers();
    const store = new MemoryRunStore();
    const session = await RunSession.create(store, generationInput(), vi.fn(), {
      modelTimeoutMs: 10,
      modelRetries: 0,
    });
    await session.transition({ kind: 'start' });
    let report!: NonNullable<CallControl['reportModelResponse']>;
    let reportChoice!: NonNullable<CallControl['reportModelChoice']>;
    const pending = invokeModel(session, basis, callControl(), (control) => {
      report = control.reportModelResponse!;
      reportChoice = control.reportModelChoice!;
      return new Promise<never>(() => {});
    });
    await vi.advanceTimersByTimeAsync(0);
    if (outcome === 'cancelled')
      await session.transition({
        kind: 'cancel',
        cause: { eventId: 'stop', reasonCode: 'user_stop' },
      });
    else if (outcome === 'invalidated')
      await session.replaceDecision({ ...generationInput(), decisionEpoch: 4 });
    else await vi.advanceTimersByTimeAsync(10);
    expect(() => report({ ...metadata, model: '' })).not.toThrow();
    expect(() => reportChoice({ ...choice, confidence: 2 })).not.toThrow();
    await vi.advanceTimersByTimeAsync(10);
    await pending;
    const record = (await store.readRecords('run', null, 100)).records.at(-1);
    expect(record).toHaveProperty('data.details.response', null);
    expect(record).not.toHaveProperty('data.details.choice');
    expect(record).not.toHaveProperty('data.details.reportIssues');
    await closeSession(session);
  },
);

test.each([
  'returned',
  'refused',
  'output_truncated',
  'invalid_response',
] as const)(
  'retains a copied response and usage when role processing ends with %s',
  async (outcome) => {
    const store = new MemoryRunStore();
    const session = await RunSession.create(store, generationInput(), vi.fn(), {
      modelRetries: 0,
    });
    await session.transition({ kind: 'start' });
    const report = { ...metadata, usage: { ...metadata.usage } };
    let late!: NonNullable<CallControl['reportModelResponse']>;
    let lateChoice!: NonNullable<CallControl['reportModelChoice']>;
    const choiceReport = {
      ...choice,
      options: choice.options.map((option) => ({ ...option })),
    };
    const result = await invokeModel(
      session,
      basis,
      callControl(),
      async (control) => {
        const nested = await invokeControlled(
          captureControl(control),
          (nestedControl) => {
            late = nestedControl.reportModelResponse!;
            lateChoice = nestedControl.reportModelChoice!;
            late(report);
            lateChoice(choiceReport);
            choiceReport.options[0]!.probability = 0;
            lateChoice({ ...choice, optionId: 'none' });
            lateChoice({ ...choice, confidence: 2 });
            report.model = 'mutated';
            report.usage.inputTokens = 999;
            late({ model: 'duplicate', requestId: null, usage: null });
            late({ ...metadata, model: '' });
            if (outcome !== 'returned') throw new ModelRequestError(outcome);
            return Promise.resolve({ value: 'decoded', usage: null });
          },
        );
        if (nested.outcome === 'failed') throw nested.error;
        if (nested.outcome !== 'returned')
          throw new Error('unexpected interruption');
        return nested.value;
      },
    );
    expect(result).toMatchObject(
      outcome === 'returned'
        ? { outcome, value: 'decoded', usage: metadata.usage }
        : { outcome: 'failed', reasonCode: outcome },
    );
    const before = (await store.readRecords('run', null, 100)).records;
    expect(before.at(-1)).toMatchObject({
      data: {
        type: 'model_finished',
        reasonCode: outcome,
        details: {
          model: basis.model,
          response: metadata,
          usage: metadata.usage,
          choice,
        },
      },
    });
    expect(before.at(-1)).not.toHaveProperty('data.details.reportIssues');
    late({ model: 'late', requestId: null, usage: null });
    lateChoice({ ...choice, candidateSetId: 'late' });
    late({ ...metadata, model: '' });
    lateChoice({ ...choice, confidence: 2 });
    expect((await store.readRecords('run', null, 100)).records).toEqual(before);
    await closeSession(session);
  },
);

test('gives every retry a separate channel and leaves an unreported response unknown', async () => {
  vi.useFakeTimers();
  const store = new MemoryRunStore();
  const session = await RunSession.create(store, generationInput(), vi.fn());
  await session.transition({ kind: 'start' });
  let first!: NonNullable<CallControl['reportModelResponse']>;
  let firstChoice!: NonNullable<CallControl['reportModelChoice']>;
  const pending = invokeModel(
    session,
    basis,
    callControl(),
    (control, attempt) => {
      if (attempt === 1) {
        first = control.reportModelResponse!;
        firstChoice = control.reportModelChoice!;
        expect(() => first({ ...metadata, model: '' })).toThrow(
          ModelRequestError,
        );
        expect(() => firstChoice({ ...choice, confidence: 2 })).toThrow(
          ModelRequestError,
        );
        first(metadata);
        firstChoice(choice);
        return Promise.reject(new ModelRequestError('unavailable'));
      }
      first({
        model: 'old-retry',
        requestId: null,
        usage: { inputTokens: 99, outputTokens: 0, totalTokens: 99 },
      });
      firstChoice({ ...choice, candidateSetId: 'old-retry' });
      first({ ...metadata, model: '' });
      firstChoice({ ...choice, confidence: 2 });
      control.reportModelChoice!({ ...choice, candidateSetId: 'retry-two' });
      return Promise.resolve({ value: 'ok', usage: null });
    },
  );
  await vi.advanceTimersByTimeAsync(250);
  await expect(pending).resolves.toEqual({
    outcome: 'returned',
    value: 'ok',
    usage: null,
  });
  const finished = (await store.readRecords('run', null, 100)).records.filter(
    (record) =>
      record.kind === 'coreEvent' && record.data.type === 'model_finished',
  );
  expect(finished).toMatchObject([
    {
      data: {
        details: {
          attempt: 1,
          response: metadata,
          usage: metadata.usage,
          choice,
          reportIssues: {
            response: {
              phase: 'protocol',
              path: '/model',
              reason: 'expected_nonempty_string',
            },
            choice: {
              phase: 'protocol',
              path: '/confidence',
              reason: 'invalid_probability',
            },
          },
        },
      },
    },
    {
      data: {
        details: {
          attempt: 2,
          response: null,
          usage: null,
          choice: { ...choice, candidateSetId: 'retry-two' },
        },
      },
    },
  ]);
  expect(finished[1]).not.toHaveProperty('data.details.reportIssues');
  await closeSession(session);
});

test.each(['cancelled', 'invalidated', 'deadlineExceeded'] as const)(
  'ignores reports after an attempt becomes %s',
  async (outcome) => {
    vi.useFakeTimers();
    const store = new MemoryRunStore();
    const session = await RunSession.create(store, generationInput(), vi.fn(), {
      modelTimeoutMs: 10,
      modelRetries: 0,
    });
    await session.transition({ kind: 'start' });
    let report!: NonNullable<CallControl['reportModelResponse']>;
    let reportChoice!: NonNullable<CallControl['reportModelChoice']>;
    const pending = invokeModel(session, basis, callControl(), (control) => {
      report = control.reportModelResponse!;
      reportChoice = control.reportModelChoice!;
      return new Promise<never>(() => {});
    });
    await vi.advanceTimersByTimeAsync(0);
    if (outcome === 'cancelled')
      await session.transition({
        kind: 'cancel',
        cause: { eventId: 'stop', reasonCode: 'user_stop' },
      });
    if (outcome === 'invalidated')
      await session.replaceDecision({ ...generationInput(), decisionEpoch: 4 });
    report(metadata);
    reportChoice(choice);
    await vi.advanceTimersByTimeAsync(10);
    await pending;
    // A report before the timeout is valid; cancellation and epoch change close it immediately.
    const expected = outcome === 'deadlineExceeded' ? metadata : null;
    const before = (await store.readRecords('run', null, 100)).records;
    expect(before.at(-1)).toMatchObject({
      data: { details: { response: expected } },
    });
    if (outcome === 'deadlineExceeded')
      expect(before.at(-1)).toMatchObject({ data: { details: { choice } } });
    else expect(JSON.stringify(before.at(-1))).not.toContain('candidate-a');
    report({ model: 'late', requestId: null, usage: null });
    reportChoice({ ...choice, candidateSetId: 'late' });
    expect((await store.readRecords('run', null, 100)).records).toEqual(before);
    await closeSession(session);
  },
);

test('isolates metadata from concurrent runs using the same model identity', async () => {
  const stores = [new MemoryRunStore(), new MemoryRunStore()];
  const sessions = await Promise.all(
    stores.map((store) => RunSession.create(store, generationInput(), vi.fn())),
  );
  await Promise.all(
    sessions.map((session) => session.transition({ kind: 'start' })),
  );
  const results = await Promise.all(
    sessions.map((session, index) =>
      invokeModel(session, basis, callControl(), (control) => {
        expect(() => {
          if (index === 0)
            control.reportModelResponse!({ ...metadata, model: '' });
          else control.reportModelChoice!({ ...choice, confidence: 2 });
        }).toThrow(ModelRequestError);
        control.reportModelResponse!({
          ...metadata,
          requestId: `response-${index}`,
        });
        control.reportModelChoice!({
          ...choice,
          candidateSetId: `set-${index}`,
        });
        return Promise.resolve({ value: index, usage: null });
      }),
    ),
  );
  expect(results.map((result) => result.outcome)).toEqual([
    'returned',
    'returned',
  ]);
  for (const [index, store] of stores.entries()) {
    expect(
      (await store.readRecords('run', null, 100)).records.at(-1),
    ).toMatchObject({
      data: {
        details: {
          response: { requestId: `response-${index}` },
          choice: { candidateSetId: `set-${index}` },
          reportIssues:
            index === 0
              ? {
                  response: {
                    phase: 'protocol',
                    path: '/model',
                    reason: 'expected_nonempty_string',
                  },
                }
              : {
                  choice: {
                    phase: 'protocol',
                    path: '/confidence',
                    reason: 'invalid_probability',
                  },
                },
        },
      },
    });
    expect(
      (await store.readRecords('run', null, 100)).records.at(-1),
    ).not.toHaveProperty(
      `data.details.reportIssues.${index === 0 ? 'choice' : 'response'}`,
    );
  }
  await Promise.all(sessions.map(closeSession));
});

test.each([
  { ...choice, authorization: 'must-not-persist' },
  {
    ...choice,
    options: [
      { ...choice.options[0]!, authorization: 'must-not-persist' },
      choice.options[1]!,
    ],
  },
  { ...choice, optionId: 'foreign' },
  { ...choice, confidence: 2 },
  { ...choice, options: [choice.options[0]!, choice.options[0]!] },
])(
  'rejects malformed choice evidence %# while retaining response usage',
  async (report) => {
    const store = new MemoryRunStore();
    const session = await RunSession.create(store, generationInput(), vi.fn());
    await session.transition({ kind: 'start' });
    const result = await invokeModel(
      session,
      basis,
      callControl(),
      (control) => {
        control.reportModelResponse!(metadata);
        control.reportModelChoice!(report);
        return Promise.resolve({ value: 'unreachable', usage: null });
      },
    );
    expect(result).toEqual({
      outcome: 'failed',
      reasonCode: 'invalid_response',
    });
    const records = (await store.readRecords('run', null, 100)).records;
    expect(records.at(-1)).toMatchObject({
      data: {
        details: {
          response: metadata,
          usage: metadata.usage,
          reportIssues: { choice: { phase: 'protocol' } },
        },
      },
    });
    expect(JSON.stringify(records)).not.toContain('must-not-persist');
    await closeSession(session);
  },
);

test.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid token count %s without persisting raw metadata',
  async (tokens) => {
    const store = new MemoryRunStore();
    const session = await RunSession.create(store, generationInput(), vi.fn());
    await session.transition({ kind: 'start' });
    const result = await invokeModel(
      session,
      basis,
      callControl(),
      (control) => {
        control.reportModelResponse!({
          ...metadata,
          usage: { ...metadata.usage, inputTokens: tokens },
        });
        return Promise.resolve({ value: 'unreachable', usage: null });
      },
    );
    expect(result).toEqual({
      outcome: 'failed',
      reasonCode: 'invalid_response',
    });
    expect(
      (await store.readRecords('run', null, 100)).records.at(-1),
    ).toMatchObject({
      data: {
        details: {
          response: null,
          usage: null,
          reportIssues: {
            response: {
              phase: 'protocol',
              path: '/usage/inputTokens',
              reason: Number.isFinite(tokens)
                ? 'expected_integer'
                : 'number_not_finite',
            },
          },
        },
      },
    });
    await closeSession(session);
  },
);

test('rejects unapproved response fields and preserves explicitly unknown token counts', async () => {
  const store = new MemoryRunStore();
  const session = await RunSession.create(store, generationInput(), vi.fn());
  await session.transition({ kind: 'start' });
  const report = {
    ...metadata,
    headers: { authorization: 'must-not-persist' },
  };
  await expect(
    invokeModel(session, basis, callControl(), (control) => {
      control.reportModelResponse!(report);
      return Promise.resolve({ value: 1, usage: null });
    }),
  ).resolves.toEqual({ outcome: 'failed', reasonCode: 'invalid_response' });
  const unknown: ModelResponseMetadata = {
    model: null,
    requestId: null,
    usage: { inputTokens: null, outputTokens: null, totalTokens: null },
  };
  await invokeModel(
    session,
    { ...basis, requestId: 'unknown' },
    callControl(),
    (control) => {
      control.reportModelResponse!(unknown);
      return Promise.resolve({ value: 1, usage: null });
    },
  );
  const records = (await store.readRecords('run', null, 100)).records;
  expect(records.at(-1)).toMatchObject({
    data: { details: { response: unknown, usage: unknown.usage } },
  });
  expect(JSON.stringify(records)).not.toContain('must-not-persist');
  await closeSession(session);
});
