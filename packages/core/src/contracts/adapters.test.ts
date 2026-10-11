import { expect, test } from 'vitest';
import { z } from 'zod';
import type { CandidateGenerator, Environment, Verifier } from './adapters.js';
import type { SingleCallSelector } from '#internal/selector/contracts';
import type { Planner } from '#internal/planner/contracts';
import type { DecisionContext } from '#internal/contracts/context';
import type { ActionDefinition } from './action.js';
import type { ChangeBatch } from './changes.js';
import { parseCandidateSet } from '../validation/candidate.js';
import { parseGoalGraph } from '../validation/goal.js';
import { parseObservation } from '../validation/observation.js';
import { parsePlanProposal } from '#internal/planner/validation';
import { parseSelection } from '#internal/selector/validation';
import { describeActionParameters } from '../action/describe.js';

const control = {
  signal: new AbortController().signal,
  deadlineAt: '2026-09-29T01:00:00.000Z',
};

const moveParameters = z.strictObject({
  target: z.string().min(1),
  mode: z.enum(['walk', 'sprint']).default('sprint'),
});

function graph() {
  const root = { id: 'root', version: 1 };
  const current = { id: 'search', version: 1 };
  return parseGoalGraph({
    runId: 'run-1',
    rootGoalRef: root,
    currentGoalRef: current,
    goals: [
      {
        kind: 'root',
        runId: 'run-1',
        ...root,
        description: 'Find and trade',
        criteria: { traded: true },
        lifecycle: 'inProgress',
        lastAssessment: null,
        parentGoalRef: null,
        acceptedPlanRef: null,
        hardConstraints: [],
        limits: {},
        preferences: [],
      },
      {
        kind: 'child',
        runId: 'run-1',
        ...current,
        description: 'Find a village',
        criteria: { seen: true },
        lifecycle: 'inProgress',
        lastAssessment: null,
        parentGoalRef: root,
        acceptedPlanRef: { id: 'plan-1', version: 1, rootGoalVersion: 1 },
      },
    ],
  });
}

function observation(seen: boolean) {
  return parseObservation({
    runId: 'run-1',
    id: seen ? 'obs-2' : 'obs-1',
    revision: seen ? 2 : 1,
    observedAt: '2026-09-29T00:00:00.000Z',
    source: 'test',
    coverage: {
      scope: 'nearby',
      completeness: 'complete',
      uncheckedScopes: [],
    },
    data: {
      seen: seen ? { status: 'known', value: true } : { status: 'absent' },
    },
  });
}

function context(seen: boolean): DecisionContext {
  return {
    graph: graph(),
    planRef: { id: 'plan-1', version: 1, rootGoalVersion: 1 },
    planGuidance: 'Search nearby land',
    observation: observation(seen),
    constraintsVersion: 1,
    effectiveConstraints: { maxDistance: 32 },
    lastActionResult: null,
    recentEvents: [],
  };
}

test('manually wires planning, full candidate calls, selection, action and verification', async () => {
  const current = context(false);
  const planner: Planner = {
    plan(request) {
      return Promise.resolve({
        requestId: request.requestId,
        decisionEpoch: request.decisionEpoch,
        rootGoalRef: request.context.graph.rootGoalRef,
        currentGoalRef: request.context.graph.currentGoalRef,
        planRef: request.context.planRef,
        observationRef: {
          id: request.context.observation.id,
          revision: request.context.observation.revision,
        },
        outcome: 'decompose',
        nextTempId: 'approach',
        guidance: 'Approach the village',
        goals: [
          {
            tempId: 'approach',
            parent: {
              kind: 'accepted',
              goalRef: request.context.graph.currentGoalRef,
            },
            description: 'Approach village',
            criteria: { seen: true },
          },
        ],
      });
    },
  };
  const request = {
    requestId: 'plan-req-1',
    decisionEpoch: 1,
    context: current,
    capabilities: [
      {
        id: 'move',
        version: 1,
        description: 'Move nearby',
        parameters: describeActionParameters(moveParameters),
        expectedEffects: { positionMayChange: true },
        tags: ['movement'],
      },
    ],
    trigger: {
      kind: 'branchExhausted' as const,
      goalRef: current.graph.currentGoalRef,
    },
  };
  const proposal = parsePlanProposal(
    await planner.plan(request, control),
    request,
    {
      maxNewGoals: 2,
      maxTotalGoals: 3,
      maxDepth: 3,
    },
  );
  expect(proposal.outcome).toBe('decompose');

  const provider: CandidateGenerator = {
    generate(input) {
      const { graph: goals, observation: state, planRef } = input.context;
      if (planRef === null)
        throw new Error('This fixture needs an accepted plan');
      return Promise.resolve(
        parseCandidateSet({
          id: 'set-1',
          runId: goals.runId,
          rootGoalRef: goals.rootGoalRef,
          currentGoalRef: goals.currentGoalRef,
          goalPathRef: 'path-1',
          goalPath: goals.goalPath,
          planRef,
          observationRef: { id: state.id, revision: state.revision },
          constraintsVersion: input.context.constraintsVersion,
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
              id: 'move-north',
              candidateSetId: 'set-1',
              actionId: 'move',
              actionVersion: 1,
              params: { target: 'north', mode: 'sprint' },
              paramSources: {
                target: { kind: 'application', reference: 'nearby-route-rule' },
                mode: { kind: 'model', reference: 'candidate-request-1' },
              },
              description: 'Move north',
              expectedEffects: {},
              cost: null,
              risk: null,
              source: 'test-provider',
              goalRef: goals.currentGoalRef,
              goalPathRef: 'path-1',
              planRef,
              observationRef: { id: state.id, revision: state.revision },
              constraintsVersion: input.context.constraintsVersion,
            },
          ],
        }),
      );
    },
  };
  const set = await provider.generate(
    {
      requestId: 'candidate-request-1',
      decisionEpoch: 1,
      context: current,
      capabilities: request.capabilities,
    },
    control,
  );
  const selector: SingleCallSelector = {
    kind: 'single',
    select(input) {
      expect(input.context.graph.goalPath).toEqual([
        current.graph.rootGoalRef,
        current.graph.currentGoalRef,
      ]);
      return Promise.resolve({
        decisionId: 'decision-1',
        candidateSetId: input.candidates.id,
        outcome: 'selected',
        candidateId: input.candidates.candidates[0]!.id,
      });
    },
  };
  const choice = parseSelection(
    await selector.select(
      {
        requestId: 'select-1',
        decisionEpoch: 1,
        context: current,
        candidates: set,
      },
      control,
    ),
    set,
  );
  expect(choice.outcome).toBe('selected');
  const move: ActionDefinition<typeof moveParameters> = {
    id: 'move',
    version: 1,
    description: 'Move nearby',
    tags: ['movement'],
    parameters: moveParameters,
    expectedEffects: {},
    retryMode: 'never',
    check(_context, params) {
      return Promise.resolve(
        params.target === 'north'
          ? { outcome: 'allowed' }
          : { outcome: 'denied', reason: 'No route' },
      );
    },
    execute(_params, execution) {
      return Promise.resolve({
        executionId: execution.executionId,
        outcome: 'succeeded',
        reasonCode: 'arrived',
        underlyingSettled: true,
        confirmedEffects: { location: 'village' },
        unresolvedEffects: {},
        progress: {},
        stopCauseEventId: null,
      });
    },
  };
  const params = move.parameters.parse(set.candidates[0]!.params);
  expect(await move.check(current, params, control)).toEqual({
    outcome: 'allowed',
  });
  const result = await move.execute(params, {
    ...control,
    executionId: 'execute-1',
    decision: current,
    reportProgress() {},
  });
  expect(result.outcome).toBe('succeeded');

  const verifier: Verifier<{ seen: boolean }> = {
    support(criteria) {
      const parsed = z.strictObject({ seen: z.boolean() }).safeParse(criteria);
      return Promise.resolve(
        parsed.success
          ? {
              outcome: 'supported',
              criteria: parsed.data,
              requiredEvidence: ['seen'],
            }
          : { outcome: 'unsupported', reason: 'Unsupported condition' },
      );
    },
    verify(input) {
      const observed = input.context.observation.data.seen;
      return Promise.resolve(
        observed?.status === 'known' && observed.value === input.criteria.seen
          ? {
              goalRef: { id: input.goal.id, version: input.goal.version },
              observationRef: {
                id: input.context.observation.id,
                revision: input.context.observation.revision,
              },
              outcome: 'passed',
              reason: null,
              evidence: {
                source: 'application',
                observationPaths: ['seen'],
                executionIds: [],
                details: {},
              },
            }
          : {
              goalRef: { id: input.goal.id, version: input.goal.version },
              observationRef: {
                id: input.context.observation.id,
                revision: input.context.observation.revision,
              },
              outcome: 'notYet',
              evidence: null,
              reason: 'Village not observed',
            },
      );
    },
  };
  const goal = current.graph.goals[1]!;
  const support = await verifier.support(goal.criteria, control);
  expect(support.outcome).toBe('supported');
  if (support.outcome !== 'supported') throw new Error('Unexpected criteria');
  const assessed = await verifier.verify(
    {
      goal,
      criteria: support.criteria,
      context: context(true),
      actionResults: [result],
    },
    control,
  );
  expect(assessed.outcome).toBe('passed');
  expect(current.graph.goals[0]?.lifecycle).toBe('inProgress');
});

test('supports pull observations and application-pushed facts without choosing a policy', async () => {
  const pull: Environment = {
    observe: {
      snapshot() {
        return Promise.resolve(observation(false));
      },
    },
  };
  expect((await pull.observe.snapshot(null, control)).data.seen?.status).toBe(
    'absent',
  );

  const batch: ChangeBatch = {
    id: 'batch-1',
    source: 'world',
    changes: [
      {
        sourceEvent: 'villageSeen',
        occurredAt: '2026-09-29T00:00:00.000Z',
        data: {},
      },
    ],
  };
  const push: Environment = {
    observe: {
      snapshot() {
        return Promise.resolve(observation(true));
      },
      changes(_scope, publish) {
        void publish(batch);
        return () => {};
      },
    },
  };
  const emitted: ChangeBatch[] = [];
  const unsubscribe = push.observe.changes?.(
    { runId: 'run-1', signal: control.signal },
    (value) => {
      emitted.push(value);
      return Promise.resolve();
    },
  );
  expect(emitted).toEqual([batch]);
  expect((await push.observe.snapshot(null, control)).data.seen?.status).toBe(
    'known',
  );
  unsubscribe?.();
});
