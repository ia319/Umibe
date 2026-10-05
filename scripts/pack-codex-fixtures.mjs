export const codexConsumerRuntime = String.raw`
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createPlanner, createSelector } from '@umibe/core';
import { createCodexModel } from '@umibe/provider-codex';

for (const dependency of ['@umibe/provider-openai', '@umibe/provider-cloudflare', 'openai'])
  await assert.rejects(import(dependency), { code: 'ERR_MODULE_NOT_FOUND' });
assert.throws(() => createCodexModel({ executablePath: 'codex' }), TypeError);
const model = createCodexModel({ executablePath: join(process.cwd(), 'missing-codex') });
assert.deepEqual(model.identity, { provider: 'codex', model: 'default' });
assert.deepEqual(createPlanner({ model }).model, model.identity);
assert.deepEqual(createSelector({ model }).model, model.identity);
const request = {
  instructions: 'Return JSON', input: {},
  output: { name: 'packed', schema: { type: 'object', properties: {}, required: [], additionalProperties: false } },
};
await assert.rejects(model.generate(request, {
  signal: AbortSignal.abort(), deadlineAt: new Date(Date.now() + 5000).toISOString(),
}), { name: 'AbortError' });
await assert.rejects(model.generate(request, {
  signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 5000).toISOString(),
}), { name: 'ModelRequestError', code: 'request_failed' });
console.log('Packed Codex imports, role wiring, cancellation and process failure passed.');
`;

export const codexConsumerTypes = String.raw`
import { createPlanner, createSelector } from '@umibe/core';
import type { StructuredOutputModel } from '@umibe/core/model';
import { createCodexModel, type CodexModelOptions } from '@umibe/provider-codex';

declare const executablePath: string;
const options: CodexModelOptions = { executablePath };
const model: StructuredOutputModel = createCodexModel(options);
createPlanner({ model });
createSelector({ model });
createCodexModel({ executablePath, model: 'explicit-model', reasoningEffort: 'low' });
// @ts-expect-error The App CLI path must be supplied explicitly.
createCodexModel({ model: 'explicit-model' });
// @ts-expect-error The provider reuses ChatGPT login instead of accepting API credentials.
createCodexModel({ executablePath, apiKey: 'unused' });
`;
