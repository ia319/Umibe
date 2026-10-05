import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execPath } from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  modelConsumerRuntime,
  modelConsumerTypes,
} from './pack-model-fixtures.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const packageRoot = join(repositoryRoot, 'packages/core');
const sqlitePackageRoot = join(repositoryRoot, 'packages/storage-sqlite');
const sdkPackageRoot = join(repositoryRoot, 'packages/umibe');
const compilerPath = fileURLToPath(import.meta.resolve('typescript/bin/tsc'));
const coreManifest = /** @type {unknown} */ (
  JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
);
if (
  typeof coreManifest !== 'object' ||
  coreManifest === null ||
  !('dependencies' in coreManifest) ||
  typeof coreManifest.dependencies !== 'object' ||
  coreManifest.dependencies === null ||
  !('zod' in coreManifest.dependencies) ||
  typeof coreManifest.dependencies.zod !== 'string'
) {
  throw new Error('The core package must declare its Zod dependency.');
}
const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) {
  throw new Error(
    'Run pack:check through pnpm so its pinned CLI is available.',
  );
}
const pnpmIsScript = /\.(?:cjs|mjs|js)$/.test(pnpmCli);
const pnpmCommand = pnpmIsScript ? execPath : pnpmCli;
const pnpmArguments = pnpmIsScript ? [pnpmCli] : [];

/** @param {string[]} args */
function runPnpm(args) {
  return execFileSync(pnpmCommand, [...pnpmArguments, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 120_000,
  });
}

/** @param {unknown} value @param {string[]} requiredFiles */
function checkPackManifest(value, requiredFiles) {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('filename' in value) ||
    typeof value.filename !== 'string' ||
    !('files' in value) ||
    !Array.isArray(value.files)
  ) {
    throw new Error('pnpm pack returned an invalid manifest.');
  }
  const paths = value.files.map((/** @type {unknown} */ file) => {
    if (
      typeof file !== 'object' ||
      file === null ||
      !('path' in file) ||
      typeof file.path !== 'string'
    ) {
      throw new Error('pnpm pack returned an invalid file entry.');
    }
    return file.path;
  });
  assert.equal(new Set(paths).size, paths.length, 'duplicate archive path');
  for (const path of paths) {
    assert.match(path, /^(?:package\.json|dist\/.+\.(?:js|d\.ts))$/);
    assert.doesNotMatch(
      path,
      /(^|\/)(?:tests?|__tests__|fixtures)(\/|$)|\.(?:test(?:-d)?|spec)\./,
    );
  }
  for (const path of [
    'package.json',
    'dist/index.js',
    'dist/index.d.ts',
    ...requiredFiles,
  ]) {
    assert.ok(paths.includes(path), `missing archive entry: ${path}`);
  }
  return value.filename;
}

/** Install only the declared archives with independent package and metadata caches.
 * @param {string} root
 * @param {string[]} archives
 * @param {Record<string, string>} overrides
 */
function installConsumer(root, archives, overrides) {
  mkdirSync(root);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'umibe-pack-consumer',
      private: true,
      type: 'module',
    }),
    { encoding: 'utf8' },
  );
  writeFileSync(
    join(root, 'pnpm-workspace.yaml'),
    readFileSync(join(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8'),
    { encoding: 'utf8' },
  );
  runPnpm([
    '--dir',
    root,
    'config',
    'set',
    '--location=project',
    '--json',
    'packages',
    '[]',
  ]);
  runPnpm([
    '--dir',
    root,
    'config',
    'set',
    '--location=project',
    '--json',
    'overrides',
    JSON.stringify(overrides),
  ]);
  runPnpm([
    '--dir',
    root,
    'config',
    'set',
    '--location=project',
    'cacheDir',
    join(root, 'cache'),
  ]);
  runPnpm([
    '--dir',
    root,
    '--store-dir',
    join(root, 'store'),
    'add',
    ...archives,
  ]);
}

const temporaryParent = realpathSync(tmpdir());
const temporaryRoot = mkdtempSync(join(temporaryParent, 'umibe-pack-check-'));
try {
  const consumerRoot = join(temporaryRoot, 'consumer');
  console.log(`Package validation workspace: ${temporaryRoot}`);

  const packed = /** @type {unknown} */ (
    JSON.parse(
      runPnpm([
        '--dir',
        packageRoot,
        'pack',
        '--json',
        '--pack-destination',
        temporaryRoot,
      ]),
    )
  );
  const tarball = resolve(
    temporaryRoot,
    checkPackManifest(packed, ['dist/model/index.js', 'dist/model/index.d.ts']),
  );
  assert.equal(dirname(tarball), temporaryRoot);
  assert.ok(existsSync(tarball), 'pnpm pack did not create the archive');

  const sqlitePacked = /** @type {unknown} */ (
    JSON.parse(
      runPnpm([
        '--dir',
        sqlitePackageRoot,
        'pack',
        '--json',
        '--pack-destination',
        temporaryRoot,
      ]),
    )
  );
  const sqliteTarball = resolve(
    temporaryRoot,
    checkPackManifest(sqlitePacked, [
      'dist/worker.js',
      'dist/database.js',
      'dist/channel.js',
    ]),
  );
  assert.equal(dirname(sqliteTarball), temporaryRoot);
  assert.ok(
    existsSync(sqliteTarball),
    'pnpm pack did not create the SQLite archive',
  );
  const sdkPacked = /** @type {unknown} */ (
    JSON.parse(
      runPnpm([
        '--dir',
        sdkPackageRoot,
        'pack',
        '--json',
        '--pack-destination',
        temporaryRoot,
      ]),
    )
  );
  const sdkTarball = resolve(temporaryRoot, checkPackManifest(sdkPacked, []));
  assert.equal(dirname(sdkTarball), temporaryRoot);
  assert.ok(existsSync(sdkTarball), 'pnpm pack did not create the SDK archive');

  // The consumer lives outside the workspace, so package exports and dependencies
  // must resolve from the installed archive rather than source aliases.
  installConsumer(
    consumerRoot,
    [
      tarball,
      sqliteTarball,
      sdkTarball,
      `zod@${coreManifest.dependencies.zod}`,
    ],
    {
      '@umibe/core': `file:${tarball.replaceAll('\\', '/')}`,
      '@umibe/storage-sqlite': `file:${sqliteTarball.replaceAll('\\', '/')}`,
    },
  );

  writeFileSync(
    join(consumerRoot, 'consumer.mjs'),
    `import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { SqliteRunStore } from '@umibe/storage-sqlite';
import { createAgent as createSdkAgent, createPlanner as createSdkPlanner, createSelector as createSdkSelector } from 'umibe';
import { createAgent, createPlanner, createSelector, ActionRegistry, defineAction, MemoryRunStore, parseJsonValue, parseGoalGraph, parseObservation, prepareCandidates, checkCandidates, filterCandidates, selectCandidates, recheckCandidate } from '@umibe/core';
import { ModelRequestError } from '@umibe/core/model';
import { z } from 'zod';

assert.equal(createSdkPlanner, createPlanner);
assert.equal(createSdkSelector, createSelector);
assert.equal(new ModelRequestError('invalid_request').code, 'invalid_request');
for (const provider of ['@umibe/provider-openai', '@umibe/provider-cloudflare', 'openai'])
  await assert.rejects(import(provider), { code: 'ERR_MODULE_NOT_FOUND' });
assert.equal(createSelector({ model: { kind: 'choice', identity: { provider: 'custom', model: 'choice' }, maxOptions: 255, choose() { throw new Error('Construction must not call a model'); } } }).capacity, 254);

let defaultCalls = 0;
let checks = 0;
const action = defineAction({
  id: 'collect', version: 1, description: 'Collect samples', tags: ['samples'],
  expectedEffects: {},
  parameters: z.strictObject({ count: z.number().int().min(1).default(() => { defaultCalls += 1; return 2; }) }),
  check: (_context, params) => {
    checks += 1;
    assert.equal(params.count, 2);
    return Promise.resolve({ outcome: 'allowed' });
  },
  execute: () => { throw new Error('Package validation must not dispatch actions'); },
});
const registrationDefaults = defaultCalls;
const registry = new ActionRegistry([action]);
const prepared = await registry.prepare({ actionId: 'collect', actionVersion: 1, params: {}, paramSources: {} });
assert.equal(defaultCalls - registrationDefaults, 1);
assert.equal(prepared.call.params.count, 2);
assert.equal(prepared.call.paramSources.count.kind, 'default');
assert.ok(Object.isFrozen(prepared.call.params));
assert.equal(registry.capabilities[0].id, 'collect');
await assert.rejects(registry.prepare({ actionId: 'collect', actionVersion: 2, params: {}, paramSources: {} }), {
  code: 'INVALID_ACTION_PARAMETERS', reason: 'action_version_mismatch',
});

const rootGoalRef = { id: 'root', version: 1 };
const context = {
  graph: parseGoalGraph({
    runId: 'consumer-run', rootGoalRef, currentGoalRef: rootGoalRef,
    goals: [{ ...rootGoalRef, runId: 'consumer-run', kind: 'root', description: 'Collect samples', criteria: { count: 2 }, lifecycle: 'inProgress', lastAssessment: null, parentGoalRef: null, acceptedPlanRef: null, hardConstraints: [], limits: {}, preferences: [] }],
  }),
  planRef: { id: 'plan', version: 1, rootGoalVersion: 1 }, planGuidance: 'Collect nearby samples',
  observation: parseObservation({ runId: 'consumer-run', id: 'observation', revision: 1, observedAt: '2026-10-02T00:00:00.000Z', source: 'consumer', coverage: { scope: 'nearby', completeness: 'complete', uncheckedScopes: [] }, data: {} }),
  constraintsVersion: 1, effectiveConstraints: { maxCount: 2 }, lastActionResult: null, recentEvents: [],
};
const generation = await prepareCandidates({ requestId: 'request', decisionEpoch: 1, context }, registry, {
  generate(request) {
    const current = request.context;
    const observationRef = { id: current.observation.id, revision: current.observation.revision };
    return Promise.resolve({
      id: 'provider-set', runId: current.graph.runId, rootGoalRef: current.graph.rootGoalRef, currentGoalRef: current.graph.currentGoalRef,
      goalPathRef: 'provider-path', goalPath: current.graph.goalPath, planRef: current.planRef, observationRef, constraintsVersion: current.constraintsVersion,
      coverage: { generation: 'complete', checking: 'complete', uncheckedScopes: [], truncated: false, exclusions: [], informationGaps: [], capabilityGaps: [] },
      candidates: [{ id: 'defaulted', params: {}, paramSources: {} }, { id: 'explicit', params: { count: 2 }, paramSources: { count: { kind: 'application', reference: 'consumer' } } }].map((proposal) => ({
        ...proposal, candidateSetId: 'provider-set', actionId: 'collect', actionVersion: 1, description: 'Collect samples', expectedEffects: {}, cost: null, risk: null, source: 'consumer',
        goalRef: current.graph.currentGoalRef, goalPathRef: 'provider-path', planRef: current.planRef, observationRef, constraintsVersion: current.constraintsVersion,
      })),
    });
  },
}, { signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 30_000).toISOString() });
assert.equal(generation.outcome, 'prepared');
assert.equal(generation.prepared.set.candidates.length, 1);
assert.equal(generation.prepared.report.merged, 1);
assert.notEqual(generation.prepared.set.id, generation.prepared.providerSet.id);
assert.equal(generation.prepared.set.candidates[0].params.count, 2);
assert.ok(Object.isFrozen(generation.prepared.request.context.effectiveConstraints));
assert.equal(checks, 0);
const defaultsAfterPreparation = defaultCalls;
const checking = await checkCandidates(generation.prepared, { signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 30_000).toISOString() });
assert.equal(checking.outcome, 'checked');
assert.equal(checking.checked.report.allowed, 1);
assert.equal(checking.checked.set.candidates[0].params, generation.prepared.set.candidates[0].params);
assert.equal(checking.checked.set.coverage.checking, 'complete');
assert.equal(checks, 1);
assert.equal(defaultCalls, defaultsAfterPreparation);
const filtering = await filterCandidates(checking.checked, { signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 30_000).toISOString() });
assert.equal(filtering.outcome, 'filtered');
assert.equal(filtering.filtered.report.kept, 1);
assert.notEqual(filtering.filtered.set.id, checking.checked.set.id);
assert.equal(filtering.filtered.set.candidates[0].params, checking.checked.set.candidates[0].params);
const selection = await selectCandidates(filtering.filtered, {
  select: (request) => Promise.resolve({ outcome: 'selected', decisionId: 'consumer-decision', candidateSetId: request.candidates.id, candidateId: request.candidates.candidates[0].id }),
}, { signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 30_000).toISOString() }, 1);
assert.equal(selection.outcome, 'selected');
assert.equal(selection.candidate.params, generation.prepared.set.candidates[0].params);
assert.equal(checks, 1);
assert.equal(defaultCalls, defaultsAfterPreparation);
const recheck = await recheckCandidate(selection, {
  requestId: 'recheck', decisionEpoch: 1, context: { ...context, observation: { ...context.observation, revision: 2 } },
}, registry, { signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 30_000).toISOString() });
assert.equal(recheck.outcome, 'rechecked');
assert.equal(recheck.check.outcome, 'allowed');
assert.equal(recheck.selected, selection);
assert.equal(recheck.request.context.observation.revision, 2);
assert.equal(selection.candidate.observationRef.revision, 1);
assert.equal(recheck.request.context.effectiveConstraints, generation.prepared.request.context.effectiveConstraints);
assert.equal(checks, 2);
assert.equal(defaultCalls, defaultsAfterPreparation);
await assert.rejects(recheckCandidate({ ...selection }, { requestId: 'copied', decisionEpoch: 1, context }, registry, { signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 30_000).toISOString() }), { reason: 'unselected_candidate' });
await assert.rejects(checkCandidates({ ...generation.prepared }, { signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 30_000).toISOString() }), { reason: 'unprepared_candidates' });

const agentStore = new MemoryRunStore();
const agent = createAgent({
  actions: [action], store: agentStore,
  environment: { observe: () => Promise.resolve({ ...context.observation, runId: 'agent-consumer', data: { ready: { status: 'known', value: true } } }) },
  planner: { plan: () => { throw new Error('Already satisfied goal must not plan'); } },
  selector: { select: () => { throw new Error('Already satisfied goal must not select'); } },
  candidateProvider: { generate: () => { throw new Error('Already satisfied goal must not generate'); } },
  verifier: {
    support: (criteria) => Promise.resolve({ outcome: 'supported', criteria, requiredEvidence: [] }),
    verify: ({ goal, context }) => Promise.resolve({
      goalRef: { id: goal.id, version: goal.version },
      observationRef: { id: context.observation.id, revision: context.observation.revision },
      outcome: 'passed', reason: null,
      evidence: { source: 'application', observationPaths: ['/ready'], executionIds: [], details: {} },
    }),
  },
});
const handle = await agent.start({
  runId: 'agent-consumer',
  goal: { id: 'root', version: 1, description: 'Already satisfied', criteria: { ready: true }, hardConstraints: [], limits: {}, preferences: [] },
  effectiveConstraints: {},
});
assert.equal((await handle.result).status, 'succeeded');
assert.equal((await agent.inspect(handle.runId)).summary.status, 'succeeded');
await agent.close();
assert.ok(await agentStore.readRun(handle.runId));
await agentStore.close();

let collected = 0;
let revision = 0;
let plans = 0;
const executionDepths = [];
const taskOptions = {
  applicationId: 'packed-sdk', limits: { maxActionAttempts: 1 }, modelStages: ['planning', 'selection'],
  actions: [defineAction({
    id: 'sample', version: 1, description: 'Take one sample', tags: [], expectedEffects: { count: 1 }, parameters: z.strictObject({}),
    check: () => Promise.resolve({ outcome: 'allowed' }),
    execute: (_params, execution) => {
      executionDepths.push(execution.decision.graph.goalPath.length);
      collected += 1;
      return Promise.resolve({ executionId: execution.executionId, outcome: 'succeeded', reasonCode: 'sampled', underlyingSettled: true, confirmedEffects: { count: collected }, unresolvedEffects: {}, progress: {}, stopCauseEventId: null });
    },
  })],
  environment: { observe: () => Promise.resolve({ ...context.observation, runId: 'nested-consumer', revision: ++revision, observedAt: new Date().toISOString(), data: { count: { status: 'known', value: collected } } }) },
  planner: { plan(request) {
    plans += 1;
    const current = request.context;
    return Promise.resolve({ requestId: request.requestId, decisionEpoch: request.decisionEpoch, rootGoalRef: current.graph.rootGoalRef, currentGoalRef: current.graph.currentGoalRef, planRef: current.planRef, observationRef: { id: current.observation.id, revision: current.observation.revision }, outcome: 'decompose', guidance: 'Complete the nested branch, then the sibling', nextTempId: 'first', goalOrder: ['first', 'second', 'third'], goals: [
      { tempId: 'group', parent: { kind: 'accepted', goalRef: current.graph.rootGoalRef }, description: 'Two samples', criteria: { count: 2 } },
      { tempId: 'first', parent: { kind: 'proposed', tempId: 'group' }, description: 'First sample', criteria: { count: 1 } },
      { tempId: 'second', parent: { kind: 'proposed', tempId: 'group' }, description: 'Second sample', criteria: { count: 2 } },
      { tempId: 'third', parent: { kind: 'accepted', goalRef: current.graph.rootGoalRef }, description: 'Third sample', criteria: { count: 3 } },
    ] });
  } },
  candidateProvider: { generate(request) {
    const current = request.context;
    const observationRef = { id: current.observation.id, revision: current.observation.revision };
    return Promise.resolve({ id: request.requestId, runId: current.graph.runId, rootGoalRef: current.graph.rootGoalRef, currentGoalRef: current.graph.currentGoalRef, goalPathRef: 'samples', goalPath: current.graph.goalPath, planRef: current.planRef, observationRef, constraintsVersion: current.constraintsVersion,
      coverage: { generation: 'complete', checking: 'complete', uncheckedScopes: [], truncated: false, exclusions: [], informationGaps: [], capabilityGaps: [] },
      candidates: [{ id: 'next', candidateSetId: request.requestId, actionId: 'sample', actionVersion: 1, params: {}, paramSources: {}, description: 'Take a sample', expectedEffects: { count: 1 }, cost: null, risk: null, source: 'consumer', goalRef: current.graph.currentGoalRef, goalPathRef: 'samples', planRef: current.planRef, observationRef, constraintsVersion: current.constraintsVersion }],
    });
  } },
  selector: { select: (request) => Promise.resolve({ outcome: 'selected', decisionId: request.requestId, candidateSetId: request.candidates.id, candidateId: request.candidates.candidates[0].id }) },
  verifier: {
    support: (criteria) => Promise.resolve({ outcome: 'supported', criteria: z.strictObject({ count: z.number() }).parse(criteria), requiredEvidence: ['/count'] }),
    verify: ({ goal, criteria, context }) => Promise.resolve({ goalRef: { id: goal.id, version: goal.version }, observationRef: { id: context.observation.id, revision: context.observation.revision }, outcome: collected >= criteria.count ? 'passed' : 'notYet', reason: collected >= criteria.count ? null : 'more_samples', progress: collected, evidence: { source: 'application', observationPaths: ['/count'], executionIds: [], details: {} } }),
  },
};
let taskAgent = createSdkAgent(taskOptions);
assert.equal((await taskAgent.inspect()).exists, false);
assert.equal(existsSync('umibe.sqlite'), false);
const firstInterval = await taskAgent.start({ runId: 'nested-consumer', goal: { id: 'root', version: 1, description: 'Three samples', criteria: { count: 3 }, hardConstraints: [], limits: {}, preferences: [] }, effectiveConstraints: {} });
assert.equal((await firstInterval.result).status, 'paused');
assert.equal(collected, 1);
const pausedTask = await taskAgent.inspect('nested-consumer');
const notification = { kind: 'application', eventId: 'operator-ready', runId: 'nested-consumer', type: 'operator_ready', source: { kind: 'application', id: 'consumer' }, observedAt: new Date().toISOString(), reasonCode: 'budget_approved', impact: 'observation', timing: 'immediate', control: 'none', currentGoalRef: null, planRef: null, goalPathRef: null, executionId: null, observationRef: null, affectedGoalRefs: [], details: {} };
await taskAgent.emit(notification);
await taskAgent.emit(notification);
await taskAgent.close();
taskAgent = createSdkAgent(taskOptions);
assert.equal((await taskAgent.inspect()).owner, null);
const resumedTask = await taskAgent.resume('nested-consumer', { limits: { maxActionAttempts: 3 } });
await taskAgent.emit(notification);
assert.notEqual(firstInterval.result, resumedTask.result);
assert.equal((await resumedTask.result).status, 'succeeded');
const completedTask = await taskAgent.inspect('nested-consumer');
assert.equal(completedTask.checkpoint.state.actionAttempts, 3);
assert.equal(completedTask.checkpoint.state.goals.created, 4);
assert.ok(completedTask.checkpoint.state.modelAttempts > pausedTask.checkpoint.state.modelAttempts);
assert.deepEqual(executionDepths, [3, 3, 2]);
assert.equal(plans, 1);
assert.equal((await taskAgent.records('nested-consumer', null, 1000)).records.filter((record) => record.kind === 'applicationEvent').length, 1);
await taskAgent.close();

const snapshot = parseJsonValue({ ready: true }, 'consumer');
assert.equal(Object.getPrototypeOf(snapshot), null);
assert.equal(snapshot.constructor, undefined);
assert.deepEqual(Object.entries(snapshot), [['ready', true]]);
const store = new MemoryRunStore();
try {
  const lease = await store.acquireRun('consumer-run');
  const result = await store.commit({
    ownerToken: lease.token,
    runId: 'consumer-run',
    expectedRevision: null,
    status: 'running',
    rootGoalRef: { id: 'root', version: 1 },
    currentGoalRef: { id: 'root', version: 1 },
    stateSchemaVersion: 1,
    state: { phase: 'started' },
    records: [],
  });
  assert.equal(result.outcome, 'committed');
  assert.equal((await store.readRun('consumer-run'))?.checkpoint.revision, 1);
  assert.deepEqual(await store.readRecords('consumer-run', null, 1), {
    records: [],
    nextCursor: null,
  });
  await assert.rejects(import('@umibe/core/dist/index.js'), {
    code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  });
} finally {
  await store.close();
}

assert.equal(existsSync('consumer.sqlite'), false);
const durable = new SqliteRunStore('consumer.sqlite');
assert.equal((await durable.inspect()).exists, false);
assert.equal(existsSync('consumer.sqlite'), false);
const durableLease = await durable.acquireRun('durable-run');
await durable.commit({ ownerToken: durableLease.token, runId: durableLease.runId, expectedRevision: null, status: 'paused', rootGoalRef, currentGoalRef: rootGoalRef, stateSchemaVersion: 1, state: { retained: true }, records: [] });
assert.equal((await durable.readRun('durable-run')).checkpoint.state.retained, true);
await durable.close();
const reopened = new SqliteRunStore('consumer.sqlite');
assert.equal((await reopened.readRun('durable-run')).checkpoint.revision, 1);
assert.ok(Object.isFrozen((await reopened.readRun('durable-run')).checkpoint.state));
await reopened.close();
`,
    { encoding: 'utf8' },
  );

  writeFileSync(
    join(consumerRoot, 'consumer.mts'),
    `import { createAgent, ActionRegistry, defineAction, MemoryRunStore, prepareCandidates, checkCandidates, filterCandidates, selectCandidates, recheckCandidate, type CandidateProvider, type CandidateGenerationInput, type CandidatePreparationResult, type CandidateCheckingResult, type CandidateFilteringResult, type CandidateSelectionResult, type CandidateRecheckInput, type CandidateRecheckResult, type SelectedCandidate, type Selector, type PreparedAction, type RecordPage, type RunCommit, type AgentOptions, type RunHandle, type ResumeRun, type Reconciliation, type PlanProposal, type GoalRevision, type RuntimeContext } from '@umibe/core';
import { z } from 'zod';

import { SqliteRunStore, type SqliteInspection } from '@umibe/storage-sqlite';
import { createAgent as createSdkAgent, type AgentOptions as SdkAgentOptions, type StorageInspection, type RunInspection as SdkRunInspection } from 'umibe';
import type { RunStore } from '@umibe/core';
import { createPlanner, createSelector } from '@umibe/core';
import { createPlanner as createSdkPlanner, createSelector as createSdkSelector } from 'umibe';
import type { ChoiceModel, StructuredOutputModel } from '@umibe/core/model';
declare const nativeModel: ChoiceModel;
declare const structuredModel: StructuredOutputModel;
createPlanner({ model: structuredModel });
createSdkPlanner({ model: structuredModel });
createSelector({ model: nativeModel });
createSdkSelector({ model: structuredModel });
// @ts-expect-error Native choice cannot generate plans.
createPlanner({ model: nativeModel });
const sqlite = new SqliteRunStore('typed.sqlite');
const storageContract: RunStore = sqlite;
const inspection: Promise<SqliteInspection> = sqlite.inspect();
const closed: Promise<void> = storageContract.close();
void inspection; void closed;
declare const sdkOptions: SdkAgentOptions<{ count: number }>;
const sdk = createSdkAgent(sdkOptions);
const sdkStorage: Promise<StorageInspection> = sdk.inspect();
const sdkRun: Promise<SdkRunInspection | null> = sdk.inspect('run');
void sdkStorage; void sdkRun;

const action = defineAction({
  id: 'collect', version: 1, description: 'Collect samples', tags: [], expectedEffects: {},
  parameters: z.object({ count: z.number().default(1), mode: z.enum(['scan', 'collect']).default('collect') }),
  check(_context, params) {
    const mode: 'scan' | 'collect' = params.mode;
    const count: number = params.count;
    // @ts-expect-error Parsed defaults retain their numeric output type.
    const invalid: string = params.count;
    void mode; void count; void invalid;
    return Promise.resolve({ outcome: 'allowed' });
  },
  execute: () => { throw new Error('Type-only consumer'); },
});
const registry = new ActionRegistry([action]);
const prepared: Promise<PreparedAction> = registry.prepare({ actionId: 'collect', actionVersion: 1, params: {}, paramSources: {} });
void prepared;

declare const candidateInput: CandidateGenerationInput;
declare const candidateProvider: CandidateProvider;
const preparation: Promise<CandidatePreparationResult> = prepareCandidates(candidateInput, registry, candidateProvider, { signal: new AbortController().signal, deadlineAt: new Date().toISOString() });
void preparation;
declare const candidateResult: CandidatePreparationResult;
if (candidateResult.outcome === 'prepared') {
  const checking: Promise<CandidateCheckingResult> = checkCandidates(candidateResult.prepared, { signal: new AbortController().signal, deadlineAt: new Date().toISOString() });
  void checking;
  // @ts-expect-error A preparation token does not expose action execution.
  void candidateResult.prepared.execute;
} else {
  // @ts-expect-error An unsuccessful preparation has no eligible candidate set.
  void candidateResult.prepared;
}
declare const checkingResult: CandidateCheckingResult;
if (checkingResult.outcome !== 'checked') {
  // @ts-expect-error Interrupted checks expose diagnostics without an allowed set.
  void checkingResult.checked;
} else {
  const filtering: Promise<CandidateFilteringResult> = filterCandidates(checkingResult.checked, { signal: new AbortController().signal, deadlineAt: new Date().toISOString() });
  void filtering;
}
declare const filteringResult: CandidateFilteringResult;
declare const selector: Selector;
if (filteringResult.outcome === 'filtered') {
  const selection: Promise<CandidateSelectionResult> = selectCandidates(filteringResult.filtered, selector, { signal: new AbortController().signal, deadlineAt: new Date().toISOString() }, 5);
  void selection;
}
declare const selected: SelectedCandidate;
declare const recheckInput: CandidateRecheckInput;
const recheck: Promise<CandidateRecheckResult> = recheckCandidate(selected, recheckInput, registry, { signal: new AbortController().signal, deadlineAt: new Date().toISOString() });
void recheck;

const input: RunCommit = {
  ownerToken: 'type-fixture',
  runId: 'consumer-run',
  expectedRevision: null,
  status: 'running',
  rootGoalRef: { id: 'root', version: 1 },
  currentGoalRef: { id: 'root', version: 1 },
  stateSchemaVersion: 1,
  state: { phase: 'started' },
  records: [],
};
const store = new MemoryRunStore();
const page: Promise<RecordPage> = store.readRecords(input.runId, null, 1);
void page;

declare const options: AgentOptions<{ count: number }>;
const agent = createAgent(options);
const start: Promise<RunHandle> = agent.start({ runId: 'typed-run', goal: { id: 'root', version: 1, description: 'Samples', criteria: { count: 3 }, hardConstraints: [], limits: {}, preferences: [] }, effectiveConstraints: {} });
const update: ResumeRun = { context: { approved: true }, limits: { maxActionAttempts: 200 } };
const resume: Promise<RunHandle> = agent.resume('typed-run', update);
const cleanup: Promise<Reconciliation> = agent.reconcile('typed-run');
void start; void resume; void cleanup;
// @ts-expect-error Resume cannot rewrite callback timeout configuration.
agent.resume('typed-run', { limits: { callbackTimeoutMs: 1000 } });
declare const runtime: RuntimeContext;
// @ts-expect-error Execution history is a readonly snapshot.
runtime.recentResults.push(runtime.recentResults[0]!);
declare const revision: Extract<PlanProposal, { outcome: 'revise' | 'reconfirm' }>;
declare const goalRevision: GoalRevision;
// @ts-expect-error Revision entries cannot be appended.
revision.revisions.push(goalRevision);
`,
    { encoding: 'utf8' },
  );
  writeFileSync(
    join(consumerRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2023',
        types: [],
      },
      files: ['consumer.mts'],
    }),
    { encoding: 'utf8' },
  );

  execFileSync(execPath, [join(consumerRoot, 'consumer.mjs')], {
    cwd: consumerRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    timeout: 15_000,
  });
  execFileSync(execPath, [compilerPath, '-p', 'tsconfig.json'], {
    cwd: consumerRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    timeout: 30_000,
  });
  for (const provider of /** @type {const} */ (['openai', 'cloudflare'])) {
    const providerPacked = /** @type {unknown} */ (
      JSON.parse(
        runPnpm([
          '--dir',
          join(repositoryRoot, 'packages/providers', provider),
          'pack',
          '--json',
          '--pack-destination',
          temporaryRoot,
        ]),
      )
    );
    const providerTarball = resolve(
      temporaryRoot,
      checkPackManifest(providerPacked, []),
    );
    assert.equal(dirname(providerTarball), temporaryRoot);
    assert.ok(
      existsSync(providerTarball),
      'pnpm pack did not create the provider archive',
    );
    const providerRoot = join(temporaryRoot, provider);
    installConsumer(providerRoot, [tarball, providerTarball], {
      '@umibe/core': `file:${tarball.replaceAll('\\', '/')}`,
    });
    writeFileSync(join(providerRoot, 'consumer.mjs'), modelConsumerRuntime, {
      encoding: 'utf8',
    });
    writeFileSync(
      join(providerRoot, 'consumer.mts'),
      modelConsumerTypes[provider],
      { encoding: 'utf8' },
    );
    writeFileSync(
      join(providerRoot, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          noEmit: true,
          strict: true,
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          target: 'ES2023',
          types: [],
        },
        files: ['consumer.mts'],
      }),
      { encoding: 'utf8' },
    );
    execFileSync(execPath, ['consumer.mjs', provider], {
      cwd: providerRoot,
      encoding: 'utf8',
      stdio: 'inherit',
      timeout: 15_000,
    });
    execFileSync(execPath, [compilerPath, '-p', 'tsconfig.json'], {
      cwd: providerRoot,
      encoding: 'utf8',
      stdio: 'inherit',
      timeout: 30_000,
    });
  }
  console.log(
    'Archive contents, independent provider HTTP, ESM imports, runtime behavior, and types passed.',
  );
} finally {
  assert.equal(dirname(realpathSync(temporaryRoot)), temporaryParent);
  if (process.argv.includes('--keep-temp'))
    console.log(`Retained package validation workspace: ${temporaryRoot}`);
  else rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 3 });
}
