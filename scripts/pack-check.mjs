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

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const packageRoot = join(repositoryRoot, 'packages/core');
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

/** @param {unknown} value */
function checkPackManifest(value) {
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
  for (const path of ['package.json', 'dist/index.js', 'dist/index.d.ts']) {
    assert.ok(paths.includes(path), `missing archive entry: ${path}`);
  }
  return value.filename;
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
  const tarball = resolve(temporaryRoot, checkPackManifest(packed));
  assert.equal(dirname(tarball), temporaryRoot);
  assert.ok(existsSync(tarball), 'pnpm pack did not create the archive');

  // The consumer lives outside the workspace, so package exports and dependencies
  // must resolve from the installed archive rather than source aliases.
  mkdirSync(consumerRoot);
  writeFileSync(
    join(consumerRoot, 'package.json'),
    JSON.stringify({
      name: 'umibe-pack-consumer',
      private: true,
      type: 'module',
    }),
    { encoding: 'utf8' },
  );
  runPnpm([
    '--dir',
    consumerRoot,
    '--store-dir',
    runPnpm(['store', 'path']).trim(),
    '--ignore-workspace',
    'add',
    '--offline',
    '--ignore-scripts',
    tarball,
    `zod@${coreManifest.dependencies.zod}`,
  ]);

  writeFileSync(
    join(consumerRoot, 'consumer.mjs'),
    `import assert from 'node:assert/strict';
import { ActionRegistry, defineAction, MemoryRunStore, parseJsonValue, parseGoalGraph, parseObservation, prepareCandidates, checkCandidates, filterCandidates } from '@umibe/core';
import { z } from 'zod';

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
await assert.rejects(checkCandidates({ ...generation.prepared }, { signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 30_000).toISOString() }), { reason: 'unprepared_candidates' });

const snapshot = parseJsonValue({ ready: true }, 'consumer');
assert.equal(Object.getPrototypeOf(snapshot), null);
assert.equal(snapshot.constructor, undefined);
assert.deepEqual(Object.entries(snapshot), [['ready', true]]);
const store = new MemoryRunStore();
try {
  const result = await store.commit({
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
`,
    { encoding: 'utf8' },
  );

  writeFileSync(
    join(consumerRoot, 'consumer.mts'),
    `import { ActionRegistry, defineAction, MemoryRunStore, prepareCandidates, checkCandidates, filterCandidates, type CandidateProvider, type CandidateGenerationInput, type CandidatePreparationResult, type CandidateCheckingResult, type CandidateFilteringResult, type PreparedAction, type RecordPage, type RunCommit } from '@umibe/core';
import { z } from 'zod';

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

const input: RunCommit = {
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
  console.log(
    'Archive contents, ESM import, runtime behavior, and types passed.',
  );
} finally {
  assert.equal(dirname(realpathSync(temporaryRoot)), temporaryParent);
  rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 3 });
}
