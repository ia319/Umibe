import {
  createAgent,
  createPlanner,
  createSelector,
  ContractError,
  defineAction,
  MemoryRunStore,
  parsePlanProposal,
} from '@umibe/core';
import { ModelRequestError } from '@umibe/core/model';
import { createOpenAIModel } from '@umibe/provider-openai';
import { createCloudflareModel } from '@umibe/provider-cloudflare';
import { z } from 'zod';
import { setTimeout, clearTimeout } from 'node:timers';

/**
 * Run one selected role through the public Agent and its persisted attempt gate.
 * The caller runs this in a dedicated process: fetch counting temporarily owns
 * the process-wide transport. Only an in-memory synthetic action can execute.
 * @param {{ provider: 'openai' | 'cloudflare', role: 'planning' | 'selection', model: string, apiKey: string, accountId: string, apiToken: string, timeoutMs: number, maxOutputTokens: number, baseURL?: string }} options
 */
export async function runScenario(options) {
  const store = new MemoryRunStore();
  const runId = 'model-contract-check';
  let count = 0;
  let revision = 0;
  let httpRequests = 0;
  /** @type {string | null} */
  let decision = null;
  const originalFetch = globalThis.fetch;
  // Count the actual SDK/fetch boundary and enforce the smoke budget independently
  // of model decisions. Never retain request headers, body or credential values.
  globalThis.fetch = (input, init) => {
    if (httpRequests >= 1) throw new ModelRequestError('request_failed');
    httpRequests++;
    return originalFetch(input, init);
  };
  /** @type {import('@umibe/core').Agent | undefined} */
  let agent;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {Promise<void> | undefined} */
  let cancellation;
  try {
    const transport =
      options.baseURL === undefined ? {} : { baseURL: options.baseURL };
    const model =
      options.provider === 'cloudflare'
        ? createCloudflareModel({
            ...transport,
            accountId: options.accountId,
            apiToken: options.apiToken,
            model: '@cf/cloudflare/clef',
          })
        : createOpenAIModel({
            ...transport,
            apiKey: options.apiKey,
            model: options.model,
            maxOutputTokens: options.maxOutputTokens,
          });
    /** @type {import('@umibe/core').Planner} */
    let planner = {
      plan: (request) =>
        Promise.resolve({
          requestId: request.requestId,
          decisionEpoch: request.decisionEpoch,
          rootGoalRef: request.context.graph.rootGoalRef,
          currentGoalRef: request.context.graph.currentGoalRef,
          planRef: request.context.planRef,
          observationRef: {
            id: request.context.observation.id,
            revision: request.context.observation.revision,
          },
          outcome: 'continue',
          nextGoalRef: request.context.graph.currentGoalRef,
          guidance: 'Collect one synthetic sample',
        }),
    };
    /** @type {import('@umibe/core').Selector} */
    let selector = {
      select: (request) =>
        Promise.resolve({
          outcome: 'abstain',
          decisionId: request.requestId,
          candidateSetId: request.candidates.id,
          reason: 'synthetic_observation_only',
        }),
    };
    if (options.role === 'planning') {
      if (model.kind !== 'structuredOutput')
        throw new ModelRequestError('invalid_request');
      const role = createPlanner({
        model,
        criteriaDescription:
          'A criterion is an object with a positive integer count. Only the application can verify observed sample count.',
      });
      planner = {
        ...role,
        async plan(request, control) {
          const result = await role.plan(request, control);
          // Include reference/graph legality in the measured interface assertion;
          // the Agent still owns support checks and final plan admission.
          try {
            const proposal = parsePlanProposal(result, request, {
              maxDepth: 5,
              maxNewGoals: 8,
              maxTotalGoals: 9,
            });
            decision = proposal.outcome;
            return proposal;
          } catch (error) {
            if (error instanceof ContractError)
              throw new ModelRequestError('invalid_response', 0, {
                phase: 'planning',
                path: '',
                reason: 'proposal_contract',
              });
            throw error;
          }
        },
      };
    } else {
      const role = createSelector({ model });
      selector = {
        ...role,
        async select(request, control) {
          const result = await role.select(request, control);
          decision = result.outcome;
          return result;
        },
      };
    }
    const action = defineAction({
      id: 'sample',
      version: 1,
      description: 'Increment an in-memory synthetic sample count',
      tags: [],
      parameters: z.strictObject({ count: z.literal(1) }),
      expectedEffects: { countMayIncrease: true },
      check: () => Promise.resolve({ outcome: 'allowed' }),
      execute: (_params, context) => {
        count++;
        return Promise.resolve({
          executionId: context.executionId,
          outcome: 'succeeded',
          reasonCode: 'synthetic_sample',
          underlyingSettled: true,
          confirmedEffects: { count },
          unresolvedEffects: {},
          progress: {},
          stopCauseEventId: null,
        });
      },
    });
    agent = createAgent({
      store,
      actions: [action],
      planner,
      selector,
      limits: {
        maxModelAttempts: 1,
        modelRetries: 0,
        modelTimeoutMs: options.timeoutMs,
        callbackTimeoutMs: options.timeoutMs,
        verificationTimeoutMs: options.timeoutMs,
        maxActionAttempts: 1,
        actionRetries: 0,
        actionTimeoutMs: 1000,
        stopGraceMs: 100,
        maxGoalDepth: 4,
        maxSubgoals: 8,
        maxNoProgress: 1,
        maxRecoveryAttempts: 1,
      },
      environment: {
        observe: () =>
          Promise.resolve({
            runId,
            id: 'synthetic-observation',
            revision: ++revision,
            observedAt: new Date().toISOString(),
            source: 'synthetic',
            coverage: {
              scope: 'sample',
              completeness: 'complete',
              uncheckedScopes: [],
            },
            data: { count: { status: 'known', value: count } },
          }),
      },
      verifier: {
        support: (criteria) => {
          const parsed = z
            .strictObject({ count: z.number().int().positive() })
            .safeParse(criteria);
          return Promise.resolve(
            parsed.success
              ? {
                  outcome: 'supported',
                  criteria: parsed.data,
                  requiredEvidence: ['/count'],
                }
              : { outcome: 'unsupported', reason: 'unsupported_criteria' },
          );
        },
        verify: (request) => {
          const basis = {
            goalRef: { id: request.goal.id, version: request.goal.version },
            observationRef: {
              id: request.context.observation.id,
              revision: request.context.observation.revision,
            },
          };
          return Promise.resolve(
            count >= request.criteria.count
              ? {
                  ...basis,
                  outcome: 'passed',
                  reason: null,
                  evidence: {
                    source: 'application',
                    observationPaths: ['/count'],
                    executionIds: [],
                    details: {},
                  },
                }
              : {
                  ...basis,
                  outcome: 'notYet',
                  reason: 'sample_needed',
                  evidence: null,
                },
          );
        },
      },
      candidateProvider: {
        generate: ({ context }) => {
          if (context.planRef === null)
            throw new Error('Synthetic candidate needs an accepted plan');
          const basis = {
            id: 'synthetic-candidates',
            runId,
            rootGoalRef: context.graph.rootGoalRef,
            currentGoalRef: context.graph.currentGoalRef,
            goalPath: context.graph.goalPath,
            goalPathRef: 'synthetic-path',
            planRef: context.planRef,
            observationRef: {
              id: context.observation.id,
              revision: context.observation.revision,
            },
            constraintsVersion: context.constraintsVersion,
          };
          return Promise.resolve({
            ...basis,
            coverage: {
              generation: 'complete',
              checking: 'complete',
              uncheckedScopes: [],
              truncated: false,
              exclusions: [],
              informationGaps: [],
              capabilityGaps: [],
            },
            candidates: [
              {
                id: 'sample-once',
                candidateSetId: basis.id,
                actionId: 'sample',
                actionVersion: 1,
                params: { count: 1 },
                paramSources: {
                  count: {
                    kind: 'application',
                    reference: 'synthetic_fixed_call',
                  },
                },
                description: 'Collect one synthetic sample',
                expectedEffects: { countMayIncrease: true },
                cost: null,
                risk: null,
                source: 'synthetic',
                goalRef: context.graph.currentGoalRef,
                goalPathRef: basis.goalPathRef,
                planRef: basis.planRef,
                observationRef: basis.observationRef,
                constraintsVersion: basis.constraintsVersion,
              },
            ],
          });
        },
      },
    });
    const handle = await agent.start({
      runId,
      goal: {
        id: 'root',
        version: 1,
        description: 'Collect one synthetic sample',
        criteria: { count: 1 },
        hardConstraints: ['Use only the supplied synthetic action'],
        limits: {},
        preferences: [],
      },
      effectiveConstraints: { syntheticOnly: true },
    });
    const active = agent;
    timer = setTimeout(() => {
      cancellation = active.cancel(runId, 'live_timeout');
      // Observe rejection immediately, then propagate it during final cleanup.
      void cancellation.catch(() => {});
    }, options.timeoutMs);
    const result = await handle.result;
    clearTimeout(timer);
    const inspection = await agent.inspect(runId);
    const records = (await agent.records(runId, null, 1000)).records;
    const finished = records
      .filter((record) => record.kind === 'coreEvent')
      .filter((record) => record.data.type === 'model_finished');
    return {
      httpRequests,
      attempts: inspection?.checkpoint.state.modelAttempts ?? null,
      decision,
      runStatus: result.status,
      finished: finished.map((record) => record.data),
    };
  } finally {
    clearTimeout(timer);
    globalThis.fetch = originalFetch;
    try {
      await cancellation;
      if (agent !== undefined) await agent.close();
    } finally {
      await store.close();
    }
  }
}
