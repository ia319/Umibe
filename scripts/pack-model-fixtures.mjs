// These programs run outside the repository against installed archives. Keeping
// their inputs local ensures package verification never reads live credentials.
export const modelConsumerRuntime = String.raw`
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createPlanner, createSelector, parseGoalGraph, parseObservation, parseCandidateSet } from '@umibe/core';
import { ModelRequestError } from '@umibe/core/model';

const provider = process.argv[2];
assert.ok(provider === 'openai' || provider === 'cloudflare');
const other = provider === 'openai' ? '@umibe/provider-cloudflare' : '@umibe/provider-openai';
await assert.rejects(import(other), { code: 'ERR_MODULE_NOT_FOUND' });
await assert.rejects(import('umibe'), { code: 'ERR_MODULE_NOT_FOUND' });
if (provider === 'cloudflare') await assert.rejects(import('openai'), { code: 'ERR_MODULE_NOT_FOUND' });
assert.equal(new ModelRequestError('invalid_response').code, 'invalid_response');
const rootGoalRef = { id: 'root', version: 1 };
const planRef = { id: 'plan', version: 1, rootGoalVersion: 1 };
const context = {
  graph: parseGoalGraph({ runId: 'packed-model', rootGoalRef, currentGoalRef: rootGoalRef, goals: [{ ...rootGoalRef, runId: 'packed-model', kind: 'root', description: 'Collect a synthetic sample', criteria: { count: 1 }, lifecycle: 'inProgress', lastAssessment: null, parentGoalRef: null, acceptedPlanRef: null, hardConstraints: [], limits: {}, preferences: [] }] }),
  planRef, planGuidance: 'Collect one sample',
  observation: parseObservation({ runId: 'packed-model', id: 'observed', revision: 1, observedAt: new Date().toISOString(), source: 'packed_http_fixture', coverage: { scope: 'sample', completeness: 'complete', uncheckedScopes: [] }, data: { available: { status: 'known', value: true } } }),
  constraintsVersion: 1, effectiveConstraints: {}, lastActionResult: null, recentEvents: [],
};
const observationRef = { id: context.observation.id, revision: 1 };
const candidates = parseCandidateSet({ id: 'fixed', runId: 'packed-model', rootGoalRef, currentGoalRef: rootGoalRef, goalPathRef: 'path', goalPath: context.graph.goalPath, planRef, observationRef, constraintsVersion: 1,
  coverage: { generation: 'complete', checking: 'complete', uncheckedScopes: [], truncated: false, exclusions: [], informationGaps: [], capabilityGaps: [] },
  candidates: [{ id: 'candidate', candidateSetId: 'fixed', actionId: 'sample', actionVersion: 1, params: { target: 'north' }, paramSources: { target: { kind: 'application', reference: 'fixed' } }, description: 'Take the sample', expectedEffects: { count: 1 }, cost: null, risk: null, source: 'fixture', goalRef: rootGoalRef, goalPathRef: 'path', planRef, observationRef, constraintsVersion: 1 }],
});
let calls = 0;
const server = createServer((request, response) => {
  void (async () => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    calls++;
    response.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'packed-openai', 'cf-ai-req-id': 'packed-clef' });
    if (provider === 'openai') {
      assert.equal(request.url, '/v1/responses');
      assert.equal(request.headers['x-stainless-retry-count'], '0');
      assert.equal(body.text.format.strict, true);
      const output = body.text.format.name === 'umibe_plan'
        ? { proposal: { outcome: 'continue', nextGoalRef: rootGoalRef, guidance: 'Continue with the candidate', goalOrder: null } }
        : body.text.format.name === 'umibe_selection'
          ? { outcome: 'selected', candidateId: 'candidate', reason: null }
          : { ok: true };
      response.end(JSON.stringify({ object: 'response', model: 'actual-openai', status: 'completed', error: null, incomplete_details: null, usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 }, output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] }));
    } else {
      assert.equal(request.url, '/v1/accounts/test-account/ai/run/@cf/cloudflare/clef');
      assert.equal(body.model, 'clef');
      assert.equal(body.questions.selection.type, 'choice');
      const ids = Object.keys(body.questions.selection.criteria);
      response.end(JSON.stringify({ success: true, errors: [], result: { model: 'actual-clef', usage: { input_tokens: 9, output_tokens: 0 }, answers: { selection: { type: 'choice', choice: ids[0], probabilities: Object.fromEntries(ids.map((id, index) => [id, index === 0 ? 1 : 0])), confidence: 0.04 } } } }));
    }
  })().catch((error) => { response.destroy(error); });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseURL = 'http://127.0.0.1:' + server.address().port + '/v1';
const control = () => ({ signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 5000).toISOString() });
try {
  let model;
  if (provider === 'openai') {
    const { createOpenAIModel } = await import('@umibe/provider-openai');
    model = createOpenAIModel({ apiKey: 'test-only-key', model: 'configured', maxOutputTokens: 200, baseURL });
    const generated = await model.generate({ instructions: 'Return an object', input: 'Synthetic', output: { name: 'capability', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } }, control());
    assert.equal(generated.ok, true);
    assert.deepEqual(Object.keys(generated), ['ok']);
    assert.equal((await createPlanner({ model }).plan({ requestId: 'planning', decisionEpoch: 1, context, capabilities: [], trigger: { kind: 'initial', assessment: 'notYet' } }, control())).outcome, 'continue');
  } else {
    const { createCloudflareModel } = await import('@umibe/provider-cloudflare');
    model = createCloudflareModel({ accountId: 'test-account', apiToken: 'test-only-token', model: '@cf/cloudflare/clef', baseURL });
    assert.equal((await model.choose({ instructions: 'Choose', input: 'Synthetic', options: [{ id: 'a', description: null }, { id: 'none', description: 'Abstain' }] }, control())).optionId, 'a');
    assert.equal(createSelector({ model }).capacity, 254);
  }
  const selected = await createSelector({ model }).select({ requestId: 'selection', decisionEpoch: 1, context, candidates }, control());
  assert.deepEqual(selected, { outcome: 'selected', decisionId: 'selection', candidateSetId: 'fixed', candidateId: 'candidate' });
  assert.equal(calls, provider === 'openai' ? 3 : 2);
  console.log(provider + ' packed capability and roles passed (' + calls + ' local HTTP requests)');
} finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
`;

export const modelConsumerTypes = {
  openai: String.raw`
import { createOpenAIModel, type OpenAIModelOptions } from '@umibe/provider-openai';
import { createPlanner, createSelector, type Planner, type Selector } from '@umibe/core';
import type { StructuredOutputModel, StructuredOutputRequest, CallControl, JsonValue } from '@umibe/core/model';
const options: OpenAIModelOptions = { apiKey: 'test-only', model: 'configured', maxOutputTokens: 200 };
const model: StructuredOutputModel = createOpenAIModel(options);
const planner: Planner = createPlanner({ model });
const selector: Selector = createSelector({ model });
declare const request: StructuredOutputRequest;
declare const control: CallControl;
const result: Promise<JsonValue> = model.generate(request, control);
void planner; void selector; void result;
// @ts-expect-error A structured model has no native choice method.
model.choose(request, control);
`,
  cloudflare: String.raw`
import { createCloudflareModel, type CloudflareModelOptions } from '@umibe/provider-cloudflare';
import { createPlanner, createSelector, type Selector } from '@umibe/core';
import type { ChoiceModel, ChoiceRequest, ChoiceResponse, CallControl } from '@umibe/core/model';
const options: CloudflareModelOptions = { accountId: 'test-account', apiToken: 'test-only', model: '@cf/cloudflare/clef' };
const model: ChoiceModel = createCloudflareModel(options);
const selector: Selector = createSelector({ model });
declare const request: ChoiceRequest;
declare const control: CallControl;
const result: Promise<ChoiceResponse> = model.choose(request, control);
void selector; void result;
// @ts-expect-error Choice cannot generate a plan.
createPlanner({ model });
// @ts-expect-error Preserve fixed options.
request.options = [];
`,
};
