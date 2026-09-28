import { expect, test } from 'vitest';
import { parseApplicationEvent } from './event.js';

function eventInput() {
  return {
    kind: 'application',
    eventId: 'event-1',
    runId: 'run-1',
    type: 'entity_changed',
    source: { kind: 'application', id: 'environment' },
    observedAt: '2026-09-28T12:00:00.000Z',
    reasonCode: 'nearby_entity',
    impact: 'candidates',
    timing: 'immediate',
    control: 'none',
    currentGoalRef: { id: 'child', version: 1 },
    planRef: { id: 'plan', version: 2, rootGoalVersion: 1 },
    goalPathRef: 'path-1',
    executionId: null,
    observationRef: { id: 'observation-1', revision: 3 },
    affectedGoalRefs: [{ id: 'child', version: 1 }],
    details: { affected: 'entities' },
  };
}

test('accepts a detached application event with explicit impact and control', () => {
  const input = eventInput();
  const event = parseApplicationEvent(input);
  input.details.affected = 'changed';
  expect(event.details.affected).toBe('entities');
  expect(event.impact).toBe('candidates');
  expect(event.control).toBe('none');
  expect(Object.isFrozen(event.affectedGoalRefs)).toBe(true);
});

test('requires immediate timing for interruption and blocks forged result fields', () => {
  const delayed = {
    ...eventInput(),
    timing: 'actionBoundary',
    control: 'interruptAction',
  };
  expect(() => parseApplicationEvent(delayed)).toThrowError(
    expect.objectContaining({
      path: '/control',
      reason: 'control_requires_immediate',
    }),
  );
  const forged = { ...eventInput(), outcome: 'succeeded' };
  expect(() => parseApplicationEvent(forged)).toThrowError(
    expect.objectContaining({ path: '/outcome', reason: 'unknown_field' }),
  );
});
