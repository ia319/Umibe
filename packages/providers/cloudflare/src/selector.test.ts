import { expect, test, vi } from 'vitest';
import { createAgent, createSelector, parseCandidateSet } from '@umibe/core';
import { isJsonObject, parseJsonValue } from '@umibe/core/model';
import {
  candidateSet,
  generationInput,
} from '../../../core/src/candidate/__tests__/fixtures.js';
import { runnerFixture } from '../../../core/src/runtime/__tests__/runner-fixtures.js';
import { createCloudflareModel } from './index.js';
import {
  callControl,
  httpFixture,
  options,
  responseBody,
} from './__tests__/http.js';

test.each([0, 1, 254, 255])(
  'sends exactly the allowed options for %s action candidates',
  async (count) => {
    const h = await httpFixture((request, response) => {
      const body = parseJsonValue(request.body, 'http_request');
      if (
        !isJsonObject(body) ||
        !isJsonObject(body.questions) ||
        !isJsonObject(body.questions.selection) ||
        !isJsonObject(body.questions.selection.criteria)
      )
        throw new Error('Expected native choice request');
      const ids = Object.keys(body.questions.selection.criteria);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(responseBody(ids, ids.at(-1))));
    });
    const source = generationInput();
    const request = {
      ...source,
      candidates: parseCandidateSet(
        candidateSet(
          { ...source, capabilities: [] },
          Array.from({ length: count }, (_, index) => ({
            id: `candidate-${index}`,
            params: { target: 'north', count: 2 },
          })),
        ),
      ),
    };
    const selector = createSelector({
      model: createCloudflareModel({ ...options, baseURL: h.baseURL }),
    });
    if (count === 255)
      await expect(
        selector.select(request, callControl()),
      ).rejects.toMatchObject({ reason: 'candidate_limit' });
    else
      await expect(
        selector.select(request, callControl()),
      ).resolves.toMatchObject({
        outcome: 'abstain',
        reason: count === 0 ? 'no_candidates' : 'model_abstained',
      });
    expect(h.requests).toHaveLength(count === 0 || count === 255 ? 0 : 1);
    if (count === 0 || count === 255) return;
    const { observation, ...context } = request.context;
    const { candidates, ...candidateContext } = request.candidates;
    const body = parseJsonValue(h.requests[0]!.body, 'http_request');
    expect(body).toMatchObject({
      state: JSON.stringify(observation),
      questions: {
        selection: {
          instructions: {
            references: {
              requestId: request.requestId,
              decisionEpoch: request.decisionEpoch,
              context,
              candidates: candidateContext,
            },
          },
          criteria: Object.fromEntries(
            candidates.map((candidate) => [candidate.id, candidate]),
          ),
        },
      },
    });
    expect(context.graph.goalPath).toHaveLength(3);
    expect(
      isJsonObject(body) &&
        isJsonObject(body.questions) &&
        isJsonObject(body.questions.selection) &&
        isJsonObject(body.questions.selection.criteria) &&
        Object.keys(body.questions.selection.criteria),
    ).toHaveLength(count + 1);
  },
);

test('isolates the abstention mapping when action IDs collide over HTTP', async () => {
  const ids = ['__proto__', 'constructor', '__umibe_abstain__'];
  const source = generationInput();
  const request = {
    ...source,
    candidates: parseCandidateSet(
      candidateSet(
        { ...source, capabilities: [] },
        ids.map((id) => ({ id, params: { target: 'north' } })),
      ),
    ),
  };
  const h = await httpFixture((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify(responseBody([...ids, '__umibe_abstain___'], '__proto__')),
    );
  });
  const report = vi.fn();
  await expect(
    createSelector({
      model: createCloudflareModel({ ...options, baseURL: h.baseURL }),
    }).select(request, { ...callControl(), reportModelChoice: report }),
  ).resolves.toMatchObject({ outcome: 'selected', candidateId: '__proto__' });
  expect(report.mock.calls[0]![0]).toMatchObject({
    candidateSetId: request.candidates.id,
    optionId: '__proto__',
    options: [
      ...ids.map((id) => ({
        id,
        candidateId: id,
        probability: id === '__proto__' ? 1 : 0,
      })),
      { id: '__umibe_abstain___', candidateId: null, probability: 0 },
    ],
    confidence: 0.04,
  });
});

test('pauses without dispatching actions on an illegal native response and retains usage', async () => {
  const h = runnerFixture();
  const http = await httpFixture((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(responseBody(['foreign', 'none'])));
  });
  const agent = createAgent({
    ...h.options,
    selector: createSelector({
      model: createCloudflareModel({ ...options, baseURL: http.baseURL }),
    }),
  });
  try {
    await expect((await agent.start(h.input)).result).resolves.toMatchObject({
      status: 'paused',
      blocker: { reasonCode: 'invalid_response' },
    });
    expect(h.execute).not.toHaveBeenCalled();
    expect(http.requests).toHaveLength(1);
    const records = (await agent.records('run', null, 1000)).records;
    expect(
      records.find(
        (record) =>
          record.kind === 'coreEvent' && record.data.type === 'model_finished',
      ),
    ).toMatchObject({
      data: {
        details: {
          usage: { inputTokens: 17, outputTokens: 0, totalTokens: 17 },
          issue: { phase: 'protocol', reason: 'unknown_option' },
        },
      },
    });
  } finally {
    await agent.close();
  }
});
