import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { isJsonObject, parseJsonValue } from '@umibe/core/model';
import { runScenario } from './live-scenario.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const startedAt = new Date();
const combinations = /** @type {const} */ ([
  ['openai', 'planning'],
  ['openai', 'selection'],
  ['cloudflare', 'selection'],
  ['codex', 'planning'],
]);
/** @type {Record<string, string>} */
let args = {};
/** @type {string[]} */
let secrets = [];
let errorCode = null;
/** @type {string | null} */
let codexVersion = null;
const enabled = process.env.UMIBE_LIVE_TESTS === '1';
const requireOpenAI = createRequire(
  new URL('../packages/providers/openai/package.json', import.meta.url),
);
const sdk = parseJsonValue(
  JSON.parse(
    readFileSync(
      resolve(dirname(requireOpenAI.resolve('openai')), 'package.json'),
      'utf8',
    ),
  ),
  'sdk_version',
);
/** @type {string | null} */
let commit = null;
/** @type {boolean | null} */
let workingTreeDirty = null;
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  workingTreeDirty =
    execFileSync('git', ['status', '--porcelain'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() !== '';
} catch {
  /* Source exports may not include Git metadata. */
}

/** @param {unknown} value */
function publicIdentifier(value) {
  return typeof value === 'string' &&
    value.length <= 256 &&
    /^[A-Za-z0-9_./:@-]+$/.test(value) &&
    !secrets.some((secret) => secret !== '' && value.includes(secret))
    ? value
    : null;
}

/** @param {string | undefined} value @param {number} fallback @param {number} maximum */
function boundedInteger(value, fallback, maximum) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum)
    throw new Error('invalid_config');
  return parsed;
}

const results = combinations.map(([provider, role]) => ({
  provider,
  role,
  status: /** @type {'passed' | 'failed' | 'not_run'} */ ('not_run'),
  reason: /** @type {string | null} */ ('live_disabled'),
  configuredModel: /** @type {string | null} */ (null),
  actualModel: /** @type {string | null} */ (null),
  requestId: /** @type {string | null} */ (null),
  attempts: /** @type {number | null} */ (0),
  providerCalls: /** @type {number | null} */ (0),
  httpRequests: /** @type {number | null} */ (0),
  elapsedMs: 0,
  limits:
    /** @type {null | { attempts: number, requests: number | null, retries: number, timeoutMs: number, maxOutputTokens: number | null }} */ (
      null
    ),
  usage: /** @type {import('@umibe/core/model').ModelUsage | null} */ (null),
  usageUnknown: true,
  interfaceAssertions:
    /** @type {null | { protocolAndRole: boolean, singleInvocation: boolean, singleRequest: boolean | null }} */ (
      null
    ),
  observation:
    /** @type {null | { decision: string | null, runStatus: string, confidence: number | null }} */ (
      null
    ),
}));
try {
  const parsed = parseArgs({
    options: Object.fromEntries(
      [
        'provider',
        'role',
        'model',
        'report',
        'env-path',
        'base-url',
        'timeout-ms',
        'max-output-tokens',
        'codex-path',
      ].map((key) => [key, { type: 'string' }]),
    ),
    strict: true,
    allowPositionals: false,
  });
  for (const [key, value] of Object.entries(parsed.values))
    if (typeof value === 'string') args[key] = value;
  // Only the process environment can opt in. An env file cannot activate a run.
  if (enabled) {
    for (const result of results) result.reason = 'not_selected';
    const selected = results.find(
      (entry) => entry.provider === args.provider && entry.role === args.role,
    );
    const configuredModel =
      args.model ?? (selected?.provider === 'codex' ? 'default' : undefined);
    if (
      selected === undefined ||
      configuredModel === undefined ||
      publicIdentifier(configuredModel) === null
    )
      throw new Error('invalid_config');
    selected.configuredModel = configuredModel;
    selected.status = 'failed';
    selected.reason = 'invalid_config';
    if (selected.provider === 'codex') {
      const executablePath = args['codex-path'];
      if (
        executablePath === undefined ||
        !isAbsolute(executablePath) ||
        args['base-url'] !== undefined
      )
        throw new Error('invalid_config');
      const version = execFileSync(executablePath, ['--version'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }).trim();
      codexVersion = publicIdentifier(/^codex-cli (\S+)$/.exec(version)?.[1]);
    }
    if (
      selected.provider === 'cloudflare' &&
      args.model !== '@cf/cloudflare/clef'
    )
      throw new Error('invalid_config');
    const timeoutMs = boundedInteger(args['timeout-ms'], 30_000, 60_000);
    const maxOutputTokens = boundedInteger(
      args['max-output-tokens'],
      1500,
      4096,
    );
    selected.limits = {
      attempts: 1,
      requests: selected.provider === 'codex' ? null : 1,
      retries: 0,
      timeoutMs,
      maxOutputTokens: selected.provider === 'openai' ? maxOutputTokens : null,
    };
    /** @type {string | undefined} */
    let baseURL;
    if (args['base-url'] !== undefined) {
      const url = new URL(args['base-url']);
      if (
        url.protocol !== 'http:' ||
        !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error('invalid_config');
      baseURL = url.href;
    }
    /** @type {Record<string, string | undefined>} */
    let fileEnv = {};
    if (selected.provider !== 'codex') {
      try {
        fileEnv = parseEnv(
          readFileSync(
            resolve(repositoryRoot, args['env-path'] ?? '.env'),
            'utf8',
          ),
        );
      } catch (error) {
        if (!(
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        ))
          throw new Error('env_read_failed', { cause: error });
      }
    }
    const env =
      selected.provider === 'codex' ? {} : { ...fileEnv, ...process.env };
    const apiKey = env.OPENAI_API_KEY ?? '';
    const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? '';
    const apiToken = env.CLOUDFLARE_AUTH_TOKEN ?? '';
    secrets = [apiKey, accountId, apiToken];
    selected.configuredModel = publicIdentifier(configuredModel);
    if (selected.configuredModel === null) throw new Error('invalid_config');
    if (
      selected.provider !== 'codex' &&
      (selected.provider === 'openai'
        ? !apiKey.trim()
        : !accountId.trim() || !apiToken.trim())
    )
      throw new Error('missing_credentials');
    const callStartedAt = Date.now();
    selected.attempts = null;
    selected.providerCalls = null;
    selected.httpRequests = null;
    const run = await runScenario({
      provider: selected.provider,
      role: selected.role,
      model: args.model ?? '',
      apiKey,
      accountId,
      apiToken,
      timeoutMs,
      maxOutputTokens,
      ...(baseURL === undefined ? {} : { baseURL }),
      ...(args['codex-path'] === undefined
        ? {}
        : { executablePath: args['codex-path'] }),
    });
    selected.elapsedMs = Math.max(0, Date.now() - callStartedAt);
    selected.httpRequests = run.httpRequests;
    selected.providerCalls = run.providerCalls;
    selected.attempts = typeof run.attempts === 'number' ? run.attempts : null;
    const finish = run.finished.length === 1 ? run.finished[0] : undefined;
    const details = finish?.details;
    const response =
      details !== undefined && isJsonObject(details.response)
        ? details.response
        : null;
    selected.actualModel = publicIdentifier(response?.model);
    selected.requestId = publicIdentifier(response?.requestId);
    const usage =
      response !== null && isJsonObject(response.usage) ? response.usage : null;
    if (usage !== null) {
      selected.usage = {
        inputTokens:
          typeof usage.inputTokens === 'number' ? usage.inputTokens : null,
        outputTokens:
          typeof usage.outputTokens === 'number' ? usage.outputTokens : null,
        totalTokens:
          typeof usage.totalTokens === 'number' ? usage.totalTokens : null,
      };
      selected.usageUnknown = Object.values(selected.usage).some(
        (value) => value === null,
      );
    }
    const passed = finish?.reasonCode === 'returned' && run.decision !== null;
    selected.interfaceAssertions = {
      protocolAndRole: passed,
      singleInvocation: selected.attempts === 1 && run.providerCalls === 1,
      singleRequest:
        selected.provider === 'codex'
          ? null
          : selected.attempts === 1 && run.httpRequests === 1,
    };
    const choice =
      details !== undefined && isJsonObject(details.choice)
        ? details.choice
        : null;
    selected.observation = {
      decision: run.decision,
      runStatus: run.runStatus,
      confidence:
        choice !== null && typeof choice.confidence === 'number'
          ? choice.confidence
          : null,
    };
    selected.status =
      passed &&
      selected.interfaceAssertions.singleInvocation &&
      (selected.provider === 'codex' ||
        selected.interfaceAssertions.singleRequest)
        ? 'passed'
        : 'failed';
    const safeErrors = new Set([
      'rate_limited',
      'unavailable',
      'deadline_exceeded',
      'unauthorized',
      'invalid_request',
      'input_limit',
      'refused',
      'output_truncated',
      'invalid_response',
      'request_failed',
      'live_timeout',
    ]);
    selected.reason =
      selected.status === 'passed'
        ? null
        : safeErrors.has(finish?.reasonCode ?? '')
          ? (finish?.reasonCode ?? 'interface_failed')
          : 'interface_failed';
  }
} catch (error) {
  const safeErrors = new Set([
    'invalid_config',
    'missing_credentials',
    'env_read_failed',
  ]);
  errorCode =
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('ERR_PARSE_ARGS_')
      ? 'invalid_config'
      : error instanceof Error && safeErrors.has(error.message)
        ? error.message
        : 'check_failed';
  const selected = results.find(
    (entry) => entry.provider === args.provider && entry.role === args.role,
  );
  if (selected !== undefined) {
    selected.status = 'failed';
    selected.reason = errorCode;
  }
}
const report = {
  formatVersion: 1,
  startedAt: startedAt.toISOString(),
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  commit,
  workingTreeDirty,
  nodeVersion: process.version,
  sdkVersions: {
    codex: codexVersion,
    openai:
      isJsonObject(sdk) && typeof sdk.version === 'string' ? sdk.version : null,
    cloudflare: {
      transport: 'node_fetch',
      undici: process.versions.undici ?? null,
    },
  },
  testKind: args['base-url'] === undefined ? 'real_service' : 'local_http',
  enabled,
  status:
    errorCode !== null || results.some((entry) => entry.status === 'failed')
      ? 'failed'
      : results.some((entry) => entry.status === 'passed')
        ? 'passed'
        : 'not_run',
  errorCode,
  results,
};
if (args.report !== undefined) {
  try {
    writeFileSync(
      resolve(args.report),
      JSON.stringify(report, null, 2) + '\n',
      { encoding: 'utf8', flag: 'wx' },
    );
  } catch {
    report.status = 'failed';
    report.errorCode = 'report_write_failed';
  }
}
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === 'failed' ? 1 : 0;
