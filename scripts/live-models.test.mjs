import { execFile } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { isJsonArray, isJsonObject, parseJsonValue } from '@umibe/core/model';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), 'umibe-live-entry-'));
const missingEnv = join(temporaryRoot, 'missing.env');
/** @type {import('node:http').Server[]} */
const servers = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** @param {string[]} args @param {Record<string, string | undefined>} [env] */
async function check(args, env = {}) {
  /** @type {{ code: string | number, stdout: string, stderr: string }} */
  const result = await new Promise((resolve) => {
    execFile(
      process.execPath,
      ['scripts/live-models.mjs', '--env-path', missingEnv, ...args],
      {
        cwd: root,
        timeout: 15_000,
        encoding: 'utf8',
        env: {
          ...process.env,
          UMIBE_LIVE_TESTS: '1',
          OPENAI_API_KEY: 'test-secret-key',
          CLOUDFLARE_AUTH_TOKEN: 'test-secret-token',
          CLOUDFLARE_ACCOUNT_ID: 'test-secret-account',
          ...env,
        },
      },
      (error, stdout, stderr) =>
        resolve({ code: error?.code ?? 0, stdout, stderr }),
    );
  });
  if (result.stdout.trim() === '')
    throw new Error(`CLI failed: ${result.stderr}`);
  const report = parseJsonValue(JSON.parse(result.stdout), 'live_report');
  if (!isJsonObject(report) || !isJsonArray(report.results))
    throw new Error('Expected a machine-readable report');
  return { ...result, report, results: report.results };
}

/** @param {'openai' | 'cloudflare'} provider @param {string} [mode] */
async function fixture(provider, mode = 'selected') {
  let calls = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = parseJsonValue(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
        'live_fixture',
      );
      if (!isJsonObject(body)) throw new Error('Expected an object request');
      calls++;
      if (mode === 'hang') return;
      if (mode === 'rate_limited') {
        response.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': '0',
        });
        response.end('{}');
        return;
      }
      response.writeHead(200, {
        'content-type': 'application/json',
        'x-request-id': 'synthetic-request',
        'cf-ai-req-id': 'synthetic-request',
      });
      if (provider === 'openai') {
        if (!isJsonObject(body.text) || !isJsonObject(body.text.format))
          throw new Error('Missing format');
        let output;
        if (body.text.format.name === 'umibe_plan') {
          output = {
            proposal:
              mode === 'claimComplete'
                ? {
                    outcome: 'claimComplete',
                    goalRef: { id: 'root', version: 1 },
                  }
                : {
                    outcome: 'continue',
                    nextGoalRef: {
                      id: mode === 'foreign_goal' ? 'foreign' : 'root',
                      version: 1,
                    },
                    guidance: 'Collect the sample',
                    goalOrder: null,
                  },
          };
        } else {
          if (
            !isJsonArray(body.input) ||
            !isJsonObject(body.input[0]) ||
            typeof body.input[0].content !== 'string'
          )
            throw new Error('Missing input');
          const input = parseJsonValue(
            JSON.parse(body.input[0].content),
            'live_input',
          );
          if (
            !isJsonObject(input) ||
            !isJsonObject(input.request) ||
            !isJsonObject(input.request.candidates) ||
            !isJsonArray(input.request.candidates.candidates) ||
            !isJsonObject(input.request.candidates.candidates[0])
          )
            throw new Error('Missing candidate');
          output =
            mode === 'abstain'
              ? {
                  outcome: 'abstain',
                  candidateId: null,
                  reason: 'Synthetic abstention',
                }
              : {
                  outcome: 'selected',
                  candidateId:
                    mode === 'foreign'
                      ? 'foreign'
                      : input.request.candidates.candidates[0].id,
                  reason: null,
                };
        }
        response.end(
          JSON.stringify({
            object: 'response',
            model: mode === 'leak' ? 'test-secret-key' : 'actual-openai',
            status: 'completed',
            error: null,
            incomplete_details: null,
            usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 },
            output: [
              {
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [
                  { type: 'output_text', text: JSON.stringify(output) },
                ],
              },
            ],
          }),
        );
      } else {
        if (
          !isJsonObject(body.questions) ||
          !isJsonObject(body.questions.selection) ||
          !isJsonObject(body.questions.selection.criteria)
        )
          throw new Error('Missing native options');
        const ids = Object.keys(body.questions.selection.criteria);
        const chosen = mode === 'abstain' ? ids.at(-1) : ids[0];
        response.end(
          JSON.stringify({
            success: true,
            errors: [],
            result: {
              model: 'actual-clef',
              usage: { input_tokens: 13, output_tokens: 0 },
              answers: {
                selection: {
                  type: 'choice',
                  choice: mode === 'foreign' ? 'foreign' : chosen,
                  probabilities: Object.fromEntries(
                    ids.map((id) => [id, id === chosen ? 1 : 0]),
                  ),
                  confidence: 0.04,
                },
              },
            },
          }),
        );
      }
    })().catch((error) => {
      response.destroy(error instanceof Error ? error : undefined);
    });
  });
  servers.push(server);
  await new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(undefined)),
  );
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Missing server address');
  return { baseURL: `http://127.0.0.1:${address.port}/v1`, calls: () => calls };
}

test('disabled runs read no env file and make zero HTTP requests', async () => {
  const http = await fixture('cloudflare');
  const result = await check(
    [
      '--provider',
      'cloudflare',
      '--role',
      'selection',
      '--model',
      '@cf/cloudflare/clef',
      '--base-url',
      http.baseURL,
      '--env-path',
      temporaryRoot,
    ],
    { UMIBE_LIVE_TESTS: '0' },
  );
  expect(result.code).toBe(0);
  expect(result.report).toMatchObject({ enabled: false, status: 'not_run' });
  expect(
    result.results.every(
      (entry) =>
        isJsonObject(entry) &&
        entry.status === 'not_run' &&
        entry.httpRequests === 0,
    ),
  ).toBe(true);
  expect(http.calls()).toBe(0);
});

test.each([
  ['openai', 'planning', 'configured'],
  ['openai', 'selection', 'configured'],
  ['cloudflare', 'selection', '@cf/cloudflare/clef'],
])(
  'requires credentials after enabling %s %s',
  async (provider, role, model) => {
    const result = await check(
      ['--provider', provider, '--role', role, '--model', model],
      {
        OPENAI_API_KEY: '',
        CLOUDFLARE_AUTH_TOKEN: '',
        CLOUDFLARE_ACCOUNT_ID: '',
      },
    );
    expect(result.code).toBe(1);
    expect(result.report).toMatchObject({
      status: 'failed',
      errorCode: 'missing_credentials',
    });
    expect(result.results).toContainEqual(
      expect.objectContaining({
        provider,
        role,
        status: 'failed',
        httpRequests: 0,
      }),
    );
  },
);

test.each([
  [],
  ['--unexpected', 'value'],
  [
    '--provider',
    'cloudflare',
    '--role',
    'planning',
    '--model',
    '@cf/cloudflare/clef',
  ],
  ['--provider', 'cloudflare', '--role', 'selection', '--model', 'wrong'],
  [
    '--provider',
    'openai',
    '--role',
    'selection',
    '--model',
    'configured',
    '--base-url',
    'https://example.com',
  ],
  [
    '--provider',
    'openai',
    '--role',
    'selection',
    '--model',
    'configured',
    '--timeout-ms',
    '0',
  ],
])('rejects incomplete or incompatible configuration %#', async (...args) => {
  const result = await check(args);
  expect(result.code).toBe(1);
  expect(result.report).toMatchObject({
    status: 'failed',
    errorCode: 'invalid_config',
  });
});

test.each(['openai', 'cloudflare'])(
  'accepts either legal %s selection without a preferred answer',
  async (provider) => {
    if (provider !== 'openai' && provider !== 'cloudflare')
      throw new Error('Invalid fixture provider');
    for (const outcome of ['selected', 'abstain']) {
      const http = await fixture(provider, outcome);
      const path = join(temporaryRoot, `${provider}-${outcome}.json`);
      const result = await check([
        '--provider',
        provider,
        '--role',
        'selection',
        '--model',
        provider === 'openai' ? 'configured' : '@cf/cloudflare/clef',
        '--base-url',
        http.baseURL,
        '--report',
        path,
      ]);
      expect(result.code, result.stdout + result.stderr).toBe(0);
      expect(result.report).toMatchObject({
        status: 'passed',
        testKind: 'local_http',
        sdkVersions: { openai: '7.23.0' },
      });
      expect(result.results).toContainEqual(
        expect.objectContaining({
          provider,
          role: 'selection',
          status: 'passed',
          attempts: 1,
          httpRequests: 1,
          usageUnknown: false,
        }),
      );
      const selected = result.results.find(
        (entry) =>
          isJsonObject(entry) &&
          entry.provider === provider &&
          entry.role === 'selection',
      );
      expect(selected).toMatchObject({ observation: { decision: outcome } });
      expect(readFileSync(path, 'utf8')).toBe(result.stdout);
      expect(result.stdout).not.toMatch(/test-secret|Bearer|authorization/);
      expect(http.calls()).toBe(1);
    }
  },
);

test.each(['selected', 'claimComplete'])(
  'records legal planning %s independently from task success',
  async (mode) => {
    const http = await fixture('openai', mode);
    const result = await check([
      '--provider',
      'openai',
      '--role',
      'planning',
      '--model',
      'configured',
      '--base-url',
      http.baseURL,
    ]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.results).toContainEqual(
      expect.objectContaining({
        provider: 'openai',
        role: 'planning',
        status: 'passed',
        attempts: 1,
        httpRequests: 1,
      }),
    );
    const selected = result.results.find(
      (entry) =>
        isJsonObject(entry) &&
        entry.provider === 'openai' &&
        entry.role === 'planning',
    );
    expect(selected).toMatchObject({ observation: { runStatus: 'paused' } });
    expect(http.calls()).toBe(1);
  },
);

test.each(['openai', 'cloudflare'])(
  'fails on an unknown %s candidate and retains known usage',
  async (provider) => {
    if (provider !== 'openai' && provider !== 'cloudflare')
      throw new Error('Invalid fixture provider');
    const http = await fixture(provider, 'foreign');
    const result = await check([
      '--provider',
      provider,
      '--role',
      'selection',
      '--model',
      provider === 'openai' ? 'configured' : '@cf/cloudflare/clef',
      '--base-url',
      http.baseURL,
    ]);
    expect(result.code).toBe(1);
    expect(result.results).toContainEqual(
      expect.objectContaining({
        provider,
        status: 'failed',
        reason: 'invalid_response',
        attempts: 1,
        httpRequests: 1,
        usageUnknown: false,
      }),
    );
    expect(http.calls()).toBe(1);
  },
);

test.each(['rate_limited', 'hang'])(
  'stops after one request on %s',
  async (mode) => {
    const http = await fixture('cloudflare', mode);
    const result = await check([
      '--provider',
      'cloudflare',
      '--role',
      'selection',
      '--model',
      '@cf/cloudflare/clef',
      '--base-url',
      http.baseURL,
      '--timeout-ms',
      '600',
    ]);
    expect(result.code).toBe(1);
    expect(result.results).toContainEqual(
      expect.objectContaining({
        provider: 'cloudflare',
        status: 'failed',
        attempts: 1,
        httpRequests: 1,
        usageUnknown: true,
      }),
    );
    expect(http.calls()).toBe(1);
  },
);

test('rejects a structurally decoded plan with an invalid goal reference', async () => {
  const http = await fixture('openai', 'foreign_goal');
  const result = await check([
    '--provider',
    'openai',
    '--role',
    'planning',
    '--model',
    'configured',
    '--base-url',
    http.baseURL,
  ]);
  expect(result.code).toBe(1);
  expect(result.results).toContainEqual(
    expect.objectContaining({
      provider: 'openai',
      role: 'planning',
      status: 'failed',
      reason: 'invalid_response',
      attempts: 1,
      httpRequests: 1,
      usageUnknown: false,
    }),
  );
  expect(http.calls()).toBe(1);
});

test('loads an explicit env path only when enabled and lets process values take precedence', async () => {
  const path = join(temporaryRoot, 'configured.env');
  writeFileSync(path, 'UMIBE_LIVE_TESTS=1\nOPENAI_API_KEY=test-secret-key\n', {
    encoding: 'utf8',
  });
  const http = await fixture('openai');
  const args = [
    '--env-path',
    path,
    '--provider',
    'openai',
    '--role',
    'selection',
    '--model',
    'configured',
    '--base-url',
    http.baseURL,
  ];
  const disabled = await check(args, { UMIBE_LIVE_TESTS: undefined });
  expect(disabled.report.status).toBe('not_run');
  expect(http.calls()).toBe(0);
  const overridden = await check(args, { OPENAI_API_KEY: '' });
  expect(overridden.report.errorCode).toBe('missing_credentials');
  expect(http.calls()).toBe(0);
  const loaded = await check(args, { OPENAI_API_KEY: undefined });
  expect(loaded.report.status).toBe('passed');
  expect(http.calls()).toBe(1);
});

test('redacts credential values echoed in metadata and never overwrites reports', async () => {
  const http = await fixture('openai', 'leak');
  const result = await check([
    '--provider',
    'openai',
    '--role',
    'selection',
    '--model',
    'configured',
    '--base-url',
    http.baseURL,
  ]);
  expect(result.code).toBe(0);
  expect(result.stdout).not.toContain('test-secret');
  expect(result.results).toContainEqual(
    expect.objectContaining({
      provider: 'openai',
      role: 'selection',
      actualModel: null,
    }),
  );
  const path = join(temporaryRoot, 'existing.json');
  writeFileSync(path, 'preserve', { encoding: 'utf8' });
  const blocked = await check(['--report', path], { UMIBE_LIVE_TESTS: '0' });
  expect(blocked.report).toMatchObject({
    status: 'failed',
    errorCode: 'report_write_failed',
  });
  expect(readFileSync(path, 'utf8')).toBe('preserve');
});
