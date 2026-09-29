import { z } from 'zod';
import { assertType } from 'vitest';
import type { ActionDefinition } from './action.js';
import type {
  CallControl,
  DecisionContext,
  VerificationRequest,
  Verifier,
} from './adapters.js';
import type { GoalAssessment } from './goal.js';
import type { SelectionResult } from './selection.js';

const moveSchema = z.strictObject({
  target: z.string(),
  mode: z.enum(['walk', 'sprint']).default('sprint'),
});

declare const move: ActionDefinition<typeof moveSchema>;
declare const context: DecisionContext;
declare const control: CallControl;
declare const verification: VerificationRequest<{ traded: boolean }>;
declare const selection: SelectionResult;
declare const assessment: GoalAssessment;

assertType<'walk' | 'sprint'>(moveSchema.parse({ target: 'village' }).mode);
// @ts-expect-error Check receives the normalized enum, never an arbitrary movement mode.
void move.check(context, { target: 'village', mode: 'teleport' }, control);

assertType<boolean>(verification.criteria.traded);
// @ts-expect-error A goal condition has no action parameter.
void verification.criteria.target;
const supportedCriteria: Awaited<
  ReturnType<Verifier<{ traded: boolean }>['support']>
> = {
  outcome: 'supported',
  criteria: { traded: true },
  requiredEvidence: ['tradeCompleted'],
};
assertType<{ traded: boolean }>(supportedCriteria.criteria);

if (selection.outcome === 'selected') {
  assertType<string>(selection.candidateId);
} else {
  // @ts-expect-error An abstention cannot name a candidate.
  void selection.candidateId;
}

if (assessment.outcome === 'passed') {
  assertType<readonly string[]>(assessment.evidence.observationPaths);
} else {
  // @ts-expect-error Non-passed assessments may lack evidence.
  void assessment.evidence.observationPaths;
}
