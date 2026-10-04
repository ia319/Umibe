import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { ActionRegistry, defineAction } from '#internal/action/registry';
import type {
  CandidateProvider,
  CandidateRequest,
} from '#internal/contracts/adapters';
import type { Selector } from '#internal/selector/contracts';
import type { DecisionContext } from '#internal/contracts/context';
import type { CandidateSet } from '#internal/contracts/candidate';
import type {
  CandidateGenerationInput,
  CandidateRecheckResult,
} from '#internal/contracts/candidate-processing';
import type { JsonObject } from '#internal/contracts/json';
import type { ActionIntent } from '#internal/contracts/record';
import { MemoryRunStore } from '#internal/storage/memory';
import { parseCandidateSet } from '#internal/validation/candidate';
import { parseGoalGraph } from '#internal/validation/goal';
import { checkCandidates } from './check.js';
import { filterCandidates } from './filter.js';
import { getSelectedCall } from './handles.js';
import { prepareCandidates } from './prepare.js';
import { recheckCandidate } from './recheck.js';
import { selectCandidates } from '#internal/selector/select';
import { callControl, generationInput } from './__tests__/fixtures.js';

interface Proposal {
  id: string;
  actionId: string;
  params: JsonObject;
  source: string;
}

interface TraceEntry {
  stage: 'check' | 'select' | 'execute';
  params: JsonObject;
  context: DecisionContext;
}

function proposalSet(
  request: CandidateRequest,
  proposals: readonly Proposal[],
): CandidateSet {
  const { context } = request;
  const planRef = context.planRef;
  if (planRef === null) throw new Error('Fixture requires an accepted plan');
  const id = `proposals:${request.requestId}`;
  const observationRef = {
    id: context.observation.id,
    revision: context.observation.revision,
  };
  return {
    id,
    runId: context.graph.runId,
    rootGoalRef: context.graph.rootGoalRef,
    currentGoalRef: context.graph.currentGoalRef,
    goalPath: context.graph.goalPath,
    goalPathRef: 'provider-path',
    planRef,
    observationRef,
    constraintsVersion: context.constraintsVersion,
    coverage: {
      generation: 'complete',
      checking: 'complete',
      uncheckedScopes: [],
      truncated: false,
      exclusions: [],
      informationGaps: [],
      capabilityGaps: [],
    },
    candidates: proposals.map((proposal) => {
      const capability = request.capabilities.find(
        (entry) => entry.id === proposal.actionId,
      );
      if (capability === undefined)
        throw new Error('Fixture proposed an unregistered action');
      return {
        ...proposal,
        candidateSetId: id,
        actionVersion: capability.version,
        description: capability.description,
        expectedEffects: capability.expectedEffects,
        cost: null,
        risk: null,
        paramSources: Object.fromEntries(
          Object.keys(proposal.params).map((key) => [
            key,
            {
              kind: 'application' as const,
              reference: `${proposal.source}:${proposal.id}/${key}`,
            },
          ]),
        ),
        goalRef: context.graph.currentGoalRef,
        goalPathRef: 'provider-path',
        planRef,
        observationRef,
        constraintsVersion: context.constraintsVersion,
      };
    }),
  };
}

async function selectForScenario(
  input: CandidateGenerationInput,
  registry: ActionRegistry,
  provider: CandidateProvider,
  selector: Selector,
) {
  const control = callControl();
  const preparation = await prepareCandidates(
    input,
    registry,
    provider,
    control,
  );
  if (preparation.outcome !== 'prepared')
    throw new Error(`Preparation stopped: ${preparation.outcome}`);
  const checking = await checkCandidates(preparation.prepared, control);
  if (checking.outcome !== 'checked')
    throw new Error(`Checking stopped: ${checking.outcome}`);
  const filtering = await filterCandidates(checking.checked, control);
  if (filtering.outcome !== 'filtered')
    throw new Error(`Filtering stopped: ${filtering.outcome}`);
  const selected = await selectCandidates(
    filtering.filtered,
    selector,
    control,
  );
  if (selected.outcome !== 'selected')
    throw new Error(`Selection stopped: ${selected.outcome}`);
  return selected;
}

/** Test-owned dispatch proves the handoff without adding a scheduler or execution API. */
async function dispatchFixture(
  recheck: Extract<CandidateRecheckResult, { outcome: 'rechecked' }>,
) {
  if (recheck.check.outcome !== 'allowed')
    throw new Error('Fixture cannot dispatch a disallowed call');
  const { selected, request } = recheck;
  const { candidate, selection } = selected;
  const current = request.context;
  if (current.planRef === null)
    throw new Error('Fixture requires an accepted plan');
  const intent: ActionIntent = {
    executionId: 'execution',
    decisionId: selection.decisionId,
    candidateSetId: selection.candidateSetId,
    candidateId: candidate.id,
    actionId: candidate.actionId,
    actionVersion: candidate.actionVersion,
    params: candidate.params,
    rootGoalRef: current.graph.rootGoalRef,
    currentGoalRef: current.graph.currentGoalRef,
    goalPathRef: candidate.goalPathRef,
    planRef: current.planRef,
    observationRef: {
      id: current.observation.id,
      revision: current.observation.revision,
    },
    constraintsVersion: current.constraintsVersion,
  };
  const store = new MemoryRunStore();
  try {
    const lease = await store.acquireRun(current.graph.runId);
    const committed = await store.commit({
      ownerToken: lease.token,
      runId: current.graph.runId,
      expectedRevision: null,
      status: 'running',
      rootGoalRef: current.graph.rootGoalRef,
      currentGoalRef: current.graph.currentGoalRef,
      stateSchemaVersion: 1,
      state: { fixture: 'intent_committed' },
      records: [
        {
          formatVersion: 1,
          eventId: 'intent',
          runId: current.graph.runId,
          kind: 'actionIntent',
          data: intent,
        },
      ],
    });
    if (committed.outcome !== 'committed')
      throw new Error('Fixture intent conflict');
    const record = committed.records[0];
    if (record?.kind !== 'actionIntent')
      throw new Error('Fixture intent was not recorded');
    const result = await getSelectedCall(selected).execute({
      ...callControl(),
      executionId: intent.executionId,
      decision: current,
      reportProgress: () => {},
    });
    return { result, intent: record.data };
  } finally {
    await store.close();
  }
}

test('passes the same file call through selection, fresh checks, intent and test-owned execution', async () => {
  const rows = ['alpha', 'beta', 'gamma'];
  const outputs = new Map<string, readonly string[]>();
  const trace: TraceEntry[] = [];
  let defaults = 0;
  const summarize = defineAction({
    id: 'file.summarize',
    version: 1,
    description: 'Summarize a known file',
    tags: ['files'],
    expectedEffects: { summary: true },
    parameters: z.strictObject({
      path: z.string().min(1),
      output: z.string().min(1),
      maxItems: z
        .number()
        .int()
        .min(1)
        .max(3)
        .default(() => {
          defaults += 1;
          return 2;
        }),
    }),
    check: (context, params) => {
      trace.push({ stage: 'check', params, context });
      const file = context.observation.data[params.path];
      if (file?.status !== 'known')
        return Promise.resolve({
          outcome: 'unknown',
          reason: 'file_not_observed',
        });
      const maxCount = context.effectiveConstraints.maxCount;
      return Promise.resolve(
        typeof maxCount === 'number' &&
          params.maxItems <= maxCount &&
          params.output.startsWith('output/')
          ? { outcome: 'allowed' }
          : { outcome: 'denied', reason: 'output_limit' },
      );
    },
    execute: (params, context) => {
      trace.push({ stage: 'execute', params, context: context.decision });
      outputs.set(params.output, rows.slice(0, params.maxItems));
      return Promise.resolve({
        executionId: context.executionId,
        outcome: 'succeeded',
        reasonCode: 'summary_created',
        underlyingSettled: true,
        confirmedEffects: { output: params.output, items: params.maxItems },
        unresolvedEffects: {},
        progress: {},
        stopCauseEventId: null,
      });
    },
  });
  const inspect = defineAction({
    id: 'file.inspect',
    version: 1,
    description: 'Inspect a file',
    tags: ['files'],
    expectedEffects: { observation: true },
    parameters: z.strictObject({ path: z.string() }),
    check: () => Promise.resolve({ outcome: 'allowed' }),
    execute: () => {
      throw new Error('The unselected action must not execute');
    },
  });
  const registry = new ActionRegistry([summarize, inspect]);
  const registrationDefaults = defaults;
  const base = generationInput();
  const input = {
    ...base,
    context: {
      ...base.context,
      graph: {
        ...base.context.graph,
        goals: base.context.graph.goals.map((goal) => ({
          ...goal,
          description: `File work: ${goal.id}`,
        })),
      },
      observation: {
        ...base.context.observation,
        data: { 'input/report.csv': { status: 'known' as const, value: rows } },
      },
    },
  };
  const provider: CandidateProvider = {
    generate: (request) =>
      Promise.resolve(
        proposalSet(request, [
          {
            id: 'invalid',
            actionId: 'file.summarize',
            params: {
              path: 'input/report.csv',
              output: 'output/summary.txt',
              maxItems: 0,
            },
            source: 'file-rules',
          },
          {
            id: 'summary',
            actionId: 'file.summarize',
            params: { path: 'input/report.csv', output: 'output/summary.txt' },
            source: 'file-rules',
          },
          {
            id: 'inspect',
            actionId: 'file.inspect',
            params: { path: 'input/report.csv' },
            source: 'file-rules',
          },
        ]),
      ),
  };
  const selector: Selector = {
    select: (request) => {
      const candidate = request.candidates.candidates.find(
        (entry) => entry.actionId === 'file.summarize',
      );
      if (candidate === undefined)
        throw new Error('Expected summary candidate');
      trace.push({
        stage: 'select',
        params: candidate.params,
        context: request.context,
      });
      return Promise.resolve({
        outcome: 'selected',
        decisionId: 'summarize',
        candidateSetId: request.candidates.id,
        candidateId: candidate.id,
      });
    },
  };
  const selected = await selectForScenario(input, registry, provider, selector);
  expect(selected.filtered.checked.prepared.report).toMatchObject({
    received: 3,
    excluded: 1,
    normalized: 2,
  });
  expect(selected.filtered.checked.report).toMatchObject({
    total: 2,
    allowed: 2,
  });
  expect(outputs.size).toBe(0);
  expect(defaults - registrationDefaults).toBe(1);
  const afterPreparation = defaults;
  const recheck = await recheckCandidate(
    selected,
    {
      ...input,
      requestId: 'fresh-files',
      context: {
        ...input.context,
        observation: { ...input.context.observation, revision: 5 },
      },
    },
    registry,
    callControl(),
  );
  expect(outputs.size).toBe(0);
  if (recheck.outcome !== 'rechecked')
    throw new Error('Expected a completed file recheck');
  const executed = await dispatchFixture(recheck);
  expect(outputs.get('output/summary.txt')).toEqual(['alpha', 'beta']);
  expect(executed.result.outcome).toBe('succeeded');
  expect(executed.intent.params).toEqual(selected.candidate.params);
  expect(executed.intent.observationRef.revision).toBe(5);
  expect(selected.candidate.observationRef.revision).toBe(4);
  expect(trace.map((entry) => entry.stage)).toEqual([
    'check',
    'select',
    'check',
    'execute',
  ]);
  for (const entry of trace) {
    expect(entry.params).toBe(selected.candidate.params);
    expect(entry.context.effectiveConstraints).toBe(
      selected.filtered.checked.prepared.request.context.effectiveConstraints,
    );
    expect(entry.context.constraintsVersion).toBe(
      executed.intent.constraintsVersion,
    );
  }
  expect(defaults).toBe(afterPreparation);

  const indexExecution = vi.fn();
  registry.register(
    defineAction({
      id: 'file.index',
      version: 1,
      description: 'Index file rows',
      tags: ['files'],
      expectedEffects: { index: true },
      parameters: z.strictObject({
        path: z.string(),
        columns: z.array(z.string()).min(1),
      }),
      check: (_context, params) =>
        Promise.resolve(
          params.columns.includes('name')
            ? { outcome: 'allowed' }
            : { outcome: 'denied', reason: 'missing_name_column' },
        ),
      execute: (params, context) => {
        indexExecution(params);
        return Promise.resolve({
          executionId: context.executionId,
          outcome: 'succeeded',
          reasonCode: 'indexed',
          underlyingSettled: true,
          confirmedEffects: { indexed: true },
          unresolvedEffects: {},
          progress: {},
          stopCauseEventId: null,
        });
      },
    }),
  );
  const indexSelection = await selectForScenario(
    input,
    registry,
    {
      generate: (request) =>
        Promise.resolve(
          proposalSet(request, [
            {
              id: 'index',
              actionId: 'file.index',
              params: { path: 'input/report.csv', columns: ['name'] },
              source: 'index-extension',
            },
          ]),
        ),
    },
    {
      select: (request) =>
        Promise.resolve({
          outcome: 'selected',
          decisionId: 'index',
          candidateSetId: request.candidates.id,
          candidateId: request.candidates.candidates[0]!.id,
        }),
    },
  );
  expect(registry.capabilities).toHaveLength(3);
  expect(indexExecution).not.toHaveBeenCalled();
  const indexCheck = await recheckCandidate(
    indexSelection,
    input,
    registry,
    callControl(),
  );
  if (indexCheck.outcome !== 'rechecked')
    throw new Error('Expected index recheck');
  await dispatchFixture(indexCheck);
  expect(indexExecution).toHaveBeenCalledExactlyOnceWith(
    indexSelection.candidate.params,
  );
});

test.each(['direct', 'recorded'] as const)(
  'uses the %s provider with revised resource goals and an unchanged fixed call',
  async (source) => {
    const trace: TraceEntry[] = [];
    let stock = 10;
    let inventory = 0;
    let defaults = 0;
    const registry = new ActionRegistry([
      defineAction({
        id: 'resource.collect',
        version: 1,
        description: 'Collect a bounded quantity',
        tags: ['resources'],
        expectedEffects: { inventory: true },
        parameters: z.strictObject({
          target: z.string().min(1),
          amount: z.number().int().min(1),
          mode: z.enum(['careful', 'fast']).default((): 'careful' => {
            defaults += 1;
            return 'careful';
          }),
        }),
        check: (context, params) => {
          trace.push({ stage: 'check', params, context });
          const available = context.observation.data[params.target];
          if (
            available?.status !== 'known' ||
            typeof available.value !== 'number'
          )
            return Promise.resolve({
              outcome: 'unknown',
              reason: 'stock_unknown',
            });
          const maxCount = context.effectiveConstraints.maxCount;
          return Promise.resolve(
            typeof maxCount === 'number' &&
              params.amount <= maxCount &&
              params.amount <= available.value
              ? { outcome: 'allowed' }
              : { outcome: 'denied', reason: 'insufficient_stock' },
          );
        },
        execute: (params, context) => {
          trace.push({ stage: 'execute', params, context: context.decision });
          stock -= params.amount;
          inventory += params.amount;
          return Promise.resolve({
            executionId: context.executionId,
            outcome: 'succeeded',
            reasonCode: 'collected',
            underlyingSettled: true,
            confirmedEffects: { amount: params.amount },
            unresolvedEffects: {},
            progress: {},
            stopCauseEventId: null,
          });
        },
      }),
    ]);
    const provider: CandidateProvider = {
      generate: (request) => {
        const current = request.context.graph.goals.find(
          (goal) => goal.id === request.context.graph.currentGoalRef.id,
        )!;
        const { count } = z
          .object({ count: z.number().int().positive() })
          .parse(current.criteria);
        const proposed = proposalSet(request, [
          {
            id: `${source}-proposal`,
            actionId: 'resource.collect',
            params: { target: 'north', amount: count },
            source,
          },
        ]);
        return Promise.resolve(
          source === 'recorded'
            ? parseCandidateSet(JSON.parse(JSON.stringify(proposed)))
            : proposed,
        );
      },
    };
    const selector: Selector = {
      select: (request) => {
        const candidate = request.candidates.candidates[0]!;
        expect(request.context.graph.goalPath).toHaveLength(3);
        expect(request.context.graph.goals.map((goal) => goal.id)).toContain(
          'old-area',
        );
        trace.push({
          stage: 'select',
          params: candidate.params,
          context: request.context,
        });
        return Promise.resolve({
          outcome: 'selected',
          decisionId: `${source}-decision`,
          candidateSetId: request.candidates.id,
          candidateId: candidate.id,
        });
      },
    };
    const initial = generationInput(1, 2);
    const initialInput = {
      ...initial,
      context: {
        ...initial.context,
        observation: {
          ...initial.context.observation,
          data: { north: { status: 'known' as const, value: stock } },
        },
      },
    };
    const oldSelection = await selectForScenario(
      initialInput,
      registry,
      provider,
      selector,
    );
    const revised = generationInput(2, 3);
    const revisedInput = {
      ...revised,
      context: {
        ...revised.context,
        graph: parseGoalGraph({
          runId: revised.context.graph.runId,
          rootGoalRef: revised.context.graph.rootGoalRef,
          currentGoalRef: { id: 'collect', version: 2 },
          goals: revised.context.graph.goals.map((goal) =>
            goal.kind === 'root'
              ? goal
              : {
                  ...goal,
                  version: 2,
                  parentGoalRef: { ...goal.parentGoalRef, version: 2 },
                },
          ),
        }),
        observation: {
          ...revised.context.observation,
          data: { north: { status: 'known' as const, value: stock } },
        },
      },
    };
    expect(
      await recheckCandidate(
        oldSelection,
        revisedInput,
        registry,
        callControl(),
      ),
    ).toMatchObject({ outcome: 'invalidated', reason: 'root_goal_changed' });
    const selected = await selectForScenario(
      revisedInput,
      registry,
      provider,
      selector,
    );
    expect(oldSelection.candidate.params.amount).toBe(2);
    expect(selected.candidate.params.amount).toBe(3);
    expect(selected.candidate.id).not.toBe(oldSelection.candidate.id);
    expect(
      selected.filtered.checked.prepared.providerSet.candidates[0]!.source,
    ).toBe(source);
    expect(selected.candidate.paramSources.mode?.kind).toBe('default');
    expect(inventory).toBe(0);
    const afterPreparation = defaults;
    const recheck = await recheckCandidate(
      selected,
      {
        ...revisedInput,
        context: {
          ...revisedInput.context,
          observation: {
            ...revisedInput.context.observation,
            revision: 5,
            data: {
              north: { status: 'known', value: stock },
              east: { status: 'known', value: 20 },
            },
          },
        },
      },
      registry,
      callControl(),
    );
    if (recheck.outcome !== 'rechecked')
      throw new Error('Expected resource recheck');
    expect(inventory).toBe(0);
    const execution = await dispatchFixture(recheck);
    expect(inventory).toBe(3);
    expect(stock).toBe(7);
    expect(execution.intent.params).toEqual({
      target: 'north',
      amount: 3,
      mode: 'careful',
    });
    expect(execution.intent.rootGoalRef.version).toBe(2);
    const currentTrace = trace.slice(2);
    expect(currentTrace.map((entry) => entry.stage)).toEqual([
      'check',
      'select',
      'check',
      'execute',
    ]);
    for (const entry of currentTrace) {
      expect(entry.params).toBe(selected.candidate.params);
      expect(entry.context.effectiveConstraints).toBe(
        recheck.request.context.effectiveConstraints,
      );
      expect(entry.context.graph.rootGoalRef.version).toBe(2);
    }
    expect(defaults).toBe(afterPreparation);
  },
);

test.each(['absent', 'unobserved'] as const)(
  'does not replace or dispatch a chosen target that becomes %s',
  async (status) => {
    const execute = vi.fn(() => Promise.reject(new Error('must not execute')));
    const registry = new ActionRegistry([
      defineAction({
        id: 'resource.collect',
        version: 1,
        description: 'Collect resources',
        tags: [],
        expectedEffects: {},
        parameters: z.strictObject({
          target: z.string(),
          amount: z.number().int().positive(),
        }),
        check: (context, params) => {
          const fact = context.observation.data[params.target];
          if (fact?.status === 'known')
            return Promise.resolve({ outcome: 'allowed' });
          return Promise.resolve(
            fact?.status === 'absent'
              ? { outcome: 'denied', reason: 'target_missing' }
              : { outcome: 'unknown', reason: 'target_unobserved' },
          );
        },
        execute,
      }),
    ]);
    const initial = generationInput();
    const input = {
      ...initial,
      context: {
        ...initial.context,
        observation: {
          ...initial.context.observation,
          data: {
            north: { status: 'known' as const, value: 10 },
            east: { status: 'known' as const, value: 20 },
          },
        },
      },
    };
    const generate = vi.fn<CandidateProvider['generate']>((request) =>
      Promise.resolve(
        proposalSet(request, [
          {
            id: 'north',
            actionId: 'resource.collect',
            params: { target: 'north', amount: 1 },
            source: 'rules',
          },
          {
            id: 'east',
            actionId: 'resource.collect',
            params: { target: 'east', amount: 1 },
            source: 'rules',
          },
        ]),
      ),
    );
    const select = vi.fn<Selector['select']>((request) =>
      Promise.resolve({
        outcome: 'selected',
        decisionId: 'north',
        candidateSetId: request.candidates.id,
        candidateId: request.candidates.candidates.find(
          (candidate) => candidate.params.target === 'north',
        )!.id,
      }),
    );
    const selected = await selectForScenario(
      input,
      registry,
      { generate },
      { select },
    );
    const recheck = await recheckCandidate(
      selected,
      {
        ...input,
        context: {
          ...input.context,
          observation: {
            ...input.context.observation,
            revision: 5,
            coverage: {
              scope: 'nearby',
              completeness: 'partial',
              uncheckedScopes: ['north'],
            },
            data: { north: { status }, east: { status: 'known', value: 20 } },
          },
        },
      },
      registry,
      callControl(),
    );
    expect(recheck).toMatchObject({
      outcome: 'rechecked',
      check:
        status === 'absent'
          ? { outcome: 'denied', reason: 'target_missing' }
          : { outcome: 'unknown', reason: 'target_unobserved' },
    });
    if (recheck.outcome !== 'rechecked')
      throw new Error('Expected domain recheck result');
    await expect(dispatchFixture(recheck)).rejects.toThrow(
      'cannot dispatch a disallowed call',
    );
    expect(selected.candidate.params.target).toBe('north');
    expect(generate).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  },
);
