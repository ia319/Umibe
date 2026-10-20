import { z } from 'zod';
import type { ChoiceHistoryEntry } from '#internal/contracts/choice-history';
import type { DecisionChoice } from '#internal/contracts/decision';
import { ContractError } from '#internal/errors';
import { requireTimestamp, type FieldContext } from './fields.js';
import { parseJsonValue } from './json.js';

const text = z.string().min(1);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const candidate = z.strictObject({
  id: text,
  actionId: text,
  params: z.record(z.string(), z.json()),
});
const basis = {
  recordedAt: text,
  goalRef: z.strictObject({ id: text, version: count.min(1) }),
};
const choice = z
  .strictObject({
    id: text,
    kind: z.enum([
      'continueAction',
      'continueSelection',
      'wait',
      'stopAction',
      'selectOperation',
      'replan',
      'adoptPlan',
      'abstain',
    ]),
    operationId: text.optional(),
    execution: z.enum(['none', 'keep', 'stop']).optional(),
    proposal: z.enum(['defer', 'discard']).optional(),
  })
  .transform(
    ({ id, kind, operationId, execution, proposal }): DecisionChoice => ({
      id,
      kind,
      ...(operationId === undefined ? {} : { operationId }),
      ...(execution === undefined ? {} : { execution }),
      ...(proposal === undefined ? {} : { proposal }),
    }),
  );
const entry = z.discriminatedUnion('kind', [
  z.strictObject({
    ...basis,
    kind: z.literal('decision'),
    choice,
    selectionId: text.nullable(),
  }),
  z.strictObject({
    ...basis,
    kind: z.literal('selectionStarted'),
    selectionId: text,
    operationId: text,
    candidateCount: count,
  }),
  z.strictObject({
    ...basis,
    kind: z.literal('selectionResult'),
    selectionId: text,
    operationId: text,
    round: count,
    batchIndex: count,
    comparisonComplete: z.boolean(),
    outcome: z.enum([
      'selected',
      'abstain',
      'no_candidates',
      'candidate_limit',
      'cancelled',
      'deadlineExceeded',
      'failed',
    ]),
    candidate: candidate.nullable(),
    reasonCode: text.nullable(),
  }),
  z.strictObject({
    ...basis,
    kind: z.literal('selectionDiscarded'),
    selectionId: text,
    operationId: text,
    reasonCode: text,
    candidate: candidate.nullable(),
  }),
]);

/** Validate and detach persisted or caller-supplied history without granting authority. */
export function readChoiceHistory(
  value: unknown,
  context: FieldContext,
  path: string,
): readonly ChoiceHistoryEntry[] {
  const parsed = z
    .array(entry)
    .max(20)
    .safeParse(parseJsonValue(value, context.stage));
  if (!parsed.success)
    throw new ContractError(
      context.code,
      context.stage,
      path,
      'invalid_choice_history',
    );
  for (const [index, item] of parsed.data.entries()) {
    const location = `${path}/${index}`;
    requireTimestamp(item.recordedAt, context, `${location}/recordedAt`);
    if (item.kind === 'decision') {
      const selected = item.choice;
      if (
        (selected.kind === 'selectOperation') !==
          (selected.operationId !== undefined) ||
        (selected.kind === 'replan' || selected.kind === 'adoptPlan') !==
          (selected.execution !== undefined) ||
        (selected.kind === 'adoptPlan' && selected.proposal !== undefined)
      )
        throw new ContractError(
          context.code,
          context.stage,
          location,
          'invalid_historical_choice',
        );
    } else if ('candidate' in item) {
      if (
        (item.candidate !== null &&
          item.candidate.actionId !== item.operationId) ||
        (item.kind === 'selectionResult' &&
          (item.outcome === 'selected') !== (item.candidate !== null))
      )
        throw new ContractError(
          context.code,
          context.stage,
          location,
          'invalid_historical_candidate',
        );
    }
  }
  const pending: object[] = [parsed.data];
  while (pending.length > 0) {
    const value = pending.pop()!;
    Object.freeze(value);
    const children: unknown[] = Object.values(value);
    for (const child of children)
      if (
        child !== null &&
        typeof child === 'object' &&
        !Object.isFrozen(child)
      )
        pending.push(child);
  }
  return parsed.data;
}
