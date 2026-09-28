import { expect, test } from 'vitest';
import { parseCandidateSet } from './candidate.js';
import { parseSelection } from './selection.js';

function candidateSetInput() {
  const rootGoalRef = { id: 'root', version: 2 };
  const currentGoalRef = { id: 'child', version: 1 };
  const planRef = { id: 'plan', version: 3, rootGoalVersion: 2 };
  const observationRef = { id: 'observation', revision: 4 };
  return {
    id: 'set-1',
    runId: 'run-1',
    rootGoalRef,
    currentGoalRef,
    goalPathRef: 'path-1',
    goalPath: [rootGoalRef, currentGoalRef],
    planRef,
    observationRef,
    constraintsVersion: 2,
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
        id: 'move-1',
        candidateSetId: 'set-1',
        actionId: 'move',
        actionVersion: 1,
        params: { target: 'north', mode: 'sprint' },
        paramSources: {
          target: { kind: 'observation', reference: '/data/openDirection' },
          mode: { kind: 'model', reference: 'request-1' },
        },
        description: 'Move north',
        expectedEffects: { displacement: 10 },
        cost: null,
        risk: null,
        source: 'application',
        goalRef: currentGoalRef,
        goalPathRef: 'path-1',
        planRef,
        observationRef,
        constraintsVersion: 2,
      },
    ],
  };
}

test('binds an immutable candidate call and selection to the same basis', () => {
  const input = candidateSetInput();
  const set = parseCandidateSet(input);
  input.candidates[0]!.params.mode = 'walk';
  expect(set.candidates[0]?.params.mode).toBe('sprint');
  expect(set.goalPath).toEqual([
    { id: 'root', version: 2 },
    { id: 'child', version: 1 },
  ]);
  expect(
    parseSelection(
      {
        decisionId: 'decision-1',
        candidateSetId: set.id,
        outcome: 'selected',
        candidateId: 'move-1',
      },
      set,
    ),
  ).toEqual({
    decisionId: 'decision-1',
    candidateSetId: 'set-1',
    outcome: 'selected',
    candidateId: 'move-1',
  });
});

test('rejects candidates with a stale basis and incomplete coverage disguised as complete', () => {
  const input = candidateSetInput();
  input.candidates[0]!.observationRef = { id: 'observation', revision: 3 };
  expect(() => parseCandidateSet(input)).toThrowError(
    expect.objectContaining({
      code: 'INVALID_CANDIDATES',
      path: '/candidates/0',
      reason: 'candidate_basis_mismatch',
    }),
  );

  const incomplete = candidateSetInput();
  incomplete.coverage.truncated = true;
  expect(() => parseCandidateSet(incomplete)).toThrowError(
    expect.objectContaining({
      path: '/coverage',
      reason: 'inconsistent_coverage',
    }),
  );

  const missingSource = candidateSetInput();
  delete (missingSource.candidates[0]!.paramSources as Record<string, unknown>)
    .mode;
  expect(() => parseCandidateSet(missingSource)).toThrowError(
    expect.objectContaining({
      path: '/candidates/0/paramSources',
      reason: 'parameter_source_mismatch',
    }),
  );
});

test('allows abstain and rejects out-of-set or contradictory selector results', () => {
  const set = parseCandidateSet(candidateSetInput());
  expect(
    parseSelection(
      {
        decisionId: 'decision-2',
        candidateSetId: set.id,
        outcome: 'abstain',
        reason: 'No action improves the goal',
      },
      set,
    ).outcome,
  ).toBe('abstain');
  expect(() =>
    parseSelection(
      {
        decisionId: 'decision-3',
        candidateSetId: set.id,
        outcome: 'selected',
        candidateId: 'not-in-set',
      },
      set,
    ),
  ).toThrowError(
    expect.objectContaining({
      path: '/candidateId',
      reason: 'unknown_candidate',
    }),
  );
  expect(() =>
    parseSelection(
      {
        decisionId: 'decision-4',
        candidateSetId: set.id,
        outcome: 'abstain',
        candidateId: 'move-1',
        reason: 'wait',
      },
      set,
    ),
  ).toThrowError(
    expect.objectContaining({ path: '/candidateId', reason: 'unknown_field' }),
  );
});
