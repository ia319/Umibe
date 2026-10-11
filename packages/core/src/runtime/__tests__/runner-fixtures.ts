import { vi } from 'vitest';
import { z } from 'zod';
import { defineAction } from '#internal/action/registry';
import type { ActionExecutionContext } from '#internal/contracts/action';
import type { ActionResult } from '#internal/contracts/record';
import type { AgentOptions, StartRun } from '#internal/contracts/runtime';
import type { ApplicationEvent } from '#internal/contracts/event';
import type {
  CandidateProvider,
  Environment,
  Verifier,
} from '#internal/contracts/adapters';
import type { SingleCallSelector } from '#internal/selector/contracts';
import type { DecisionPolicy } from '#internal/contracts/decision';
import type { Planner, PlannerRequest } from '#internal/planner/contracts';
import {
  candidateSet,
  generationInput,
} from '#internal/candidate/__tests__/fixtures';
import { MemoryRunStore } from '#internal/storage/memory';
import { createAgent } from '../agent.js';

export const fixtureDecisionPolicy: DecisionPolicy = {
  decide(request) {
    const options = request.options;
    const option =
      options.find(({ decision }) => decision.kind === 'adoptPlan') ??
      ((request.input.acceptedPlan === null ||
        request.input.planning.need !== null) &&
      !request.input.planning.inFlight
        ? options.find(({ decision }) => decision.kind === 'replan')
        : undefined) ??
      (request.input.execution === null && request.input.selection === null
        ? options.find(({ decision }) => decision.kind === 'selectOperation')
        : undefined) ??
      options.find(({ decision }) => decision.kind === 'continueAction') ??
      options.find(({ decision }) => decision.kind === 'continueSelection') ??
      options.find(({ decision }) => decision.kind === 'wait') ??
      options.find(({ decision }) => decision.kind === 'abstain');
    if (option === undefined)
      throw new Error('Fixture has no applicable decision option');
    return Promise.resolve({ optionId: option.id });
  },
};

export function applicationEvent(
  overrides: Partial<ApplicationEvent> = {},
): ApplicationEvent {
  return {
    kind: 'application',
    eventId: 'event',
    runId: 'run',
    type: 'fixture_event',
    source: { kind: 'application', id: 'fixture' },
    observedAt: '2026-10-02T00:00:00.000Z',
    reasonCode: 'facts_changed',
    impact: 'candidates',
    timing: 'immediate',
    control: 'none',
    currentGoalRef: null,
    planRef: null,
    goalPathRef: null,
    executionId: null,
    observationRef: null,
    affectedGoalRefs: [],
    details: {},
    ...overrides,
  };
}

export function proposalBasis(request: PlannerRequest) {
  return {
    requestId: request.requestId,
    decisionEpoch: request.decisionEpoch,
    rootGoalRef: request.context.graph.rootGoalRef,
    currentGoalRef: request.context.graph.currentGoalRef,
    planRef: request.context.planRef,
    observationRef: {
      id: request.context.observation.id,
      revision: request.context.observation.revision,
    },
  };
}

export function runnerFixture(initial = 0, target = 2) {
  let count = initial;
  let revision = 0;
  const store = new MemoryRunStore();
  const observe = vi.fn<Environment['observe']['snapshot']>(() =>
    Promise.resolve({
      ...generationInput().context.observation,
      revision: ++revision,
      data: { count: { status: 'known', value: count } },
    }),
  );
  const execute = vi.fn(
    (
      _params: { target: string; count: number },
      context: ActionExecutionContext,
    ): Promise<ActionResult> => {
      count++;
      return Promise.resolve({
        executionId: context.executionId,
        outcome: 'succeeded' as const,
        reasonCode: 'collected',
        underlyingSettled: true,
        confirmedEffects: { count },
        unresolvedEffects: {},
        progress: {},
        stopCauseEventId: null,
      });
    },
  );
  const action = defineAction({
    id: 'collect',
    version: 1,
    description: 'Collect sample',
    tags: [],
    expectedEffects: { count: 1 },
    parameters: z.strictObject({
      target: z.string(),
      count: z.number().default(1),
    }),
    check: () => Promise.resolve({ outcome: 'allowed' }),
    execute,
  });
  const plan = vi.fn<Planner['plan']>((request) =>
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
      guidance: 'Collect samples until the count is met',
    }),
  );
  const generate = vi.fn<CandidateProvider['bind']>((request) =>
    Promise.resolve(
      candidateSet(request, [{ id: 'collect', params: { target: 'north' } }]),
    ),
  );
  const listOperations = vi.fn<CandidateProvider['listOperations']>((request) =>
    Promise.resolve({
      id: `${request.requestId}:operations`,
      requestId: request.requestId,
      operations: request.capabilities.map((capability) => ({
        operationId: capability.id,
        actionVersion: capability.version,
        availability: { status: 'available' as const },
        parameterSources: {},
        informationGaps: [],
      })),
      informationGaps: [],
      capabilityGaps: [],
    }),
  );
  const select = vi.fn<SingleCallSelector['select']>((request) =>
    Promise.resolve({
      outcome: 'selected',
      decisionId: request.requestId,
      candidateSetId: request.candidates.id,
      candidateId: request.candidates.candidates[0]!.id,
    }),
  );
  const support = vi.fn<Verifier<{ count: number }>['support']>((criteria) => {
    const parsed = z.strictObject({ count: z.number() }).safeParse(criteria);
    return Promise.resolve(
      parsed.success
        ? {
            outcome: 'supported',
            criteria: parsed.data,
            requiredEvidence: ['/count'],
          }
        : { outcome: 'unsupported', reason: 'unsupported_criteria' },
    );
  });
  const verify = vi.fn<Verifier<{ count: number }>['verify']>((request) => {
    const basis = {
      goalRef: { id: request.goal.id, version: request.goal.version },
      observationRef: {
        id: request.context.observation.id,
        revision: request.context.observation.revision,
      },
    };
    const fact = request.context.observation.data.count;
    return Promise.resolve(
      fact?.status === 'known' &&
        typeof fact.value === 'number' &&
        fact.value >= request.criteria.count
        ? {
            ...basis,
            outcome: 'passed',
            reason: null,
            evidence: {
              source: 'application',
              observationPaths: ['/count'],
              executionIds: request.actionResults.map(
                (result) => result.executionId,
              ),
              details: {},
            },
          }
        : {
            ...basis,
            outcome: 'notYet',
            reason: 'more_samples_needed',
            evidence: null,
          },
    );
  });
  const options: AgentOptions<{ count: number }> = {
    store,
    actions: [action],
    environment: { observe: { snapshot: observe } },
    planner: { plan },
    decisionPolicy: fixtureDecisionPolicy,
    candidateProvider: { listOperations, bind: generate },
    selector: { kind: 'single', select },
    verifier: { support, verify },
  };
  const input: StartRun = {
    runId: 'run',
    goal: {
      id: 'root',
      version: 1,
      description: 'Collect samples',
      criteria: { count: target },
      hardConstraints: [],
      limits: {},
      preferences: [],
    },
    effectiveConstraints: {},
    context: { source: 'integration_fixture' },
  };
  return {
    options,
    input,
    store,
    observe,
    execute,
    plan,
    generate,
    listOperations,
    select,
    support,
    verify,
    create: () => createAgent(options),
  };
}
