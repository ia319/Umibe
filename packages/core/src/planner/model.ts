import type { Planner } from './contracts.js';
import type { StructuredOutputModel } from '#internal/model/contracts';
import { captureModelIdentity } from '#internal/model/validation';
import { captureDecisionRequest } from '#internal/candidate/context';
import { captureControl } from '#internal/candidate/control';
import { parseJsonValue } from '#internal/validation/json';
import { modelOutputError } from '#internal/model/output-error';
import { ModelRequestError } from '#internal/runtime/model';
import {
  decodePlanOutput,
  plannerInstructions,
  plannerOutputSchema,
} from './format.js';

export interface PlannerOptions {
  readonly model: StructuredOutputModel;
  /** Application-specific meaning and supported shape of non-null acceptance criteria. */
  readonly criteriaDescription?: string;
}

/** Create a stateless planner. Each plan call generates once; Agent retains plan admission and budgets. */
export function createPlanner(options: PlannerOptions): Planner {
  if (
    options.model?.kind !== 'structuredOutput' ||
    typeof options.model.generate !== 'function'
  )
    throw new TypeError('Planner requires a structured output model');
  const identity = captureModelIdentity(options.model.identity);
  const generate = options.model.generate.bind(options.model);
  const criteriaDescription = options.criteriaDescription ?? null;
  if (
    criteriaDescription !== null &&
    (typeof criteriaDescription !== 'string' ||
      criteriaDescription.trim() === '')
  )
    throw new TypeError('criteriaDescription must be nonempty');
  return Object.freeze<Planner>({
    model: identity,
    async plan(request, controlInput) {
      const control = captureControl(controlInput);
      if (control.signal.aborted)
        throw new DOMException('Model request cancelled', 'AbortError');
      if (Date.now() >= control.deadlineMs)
        throw new ModelRequestError('deadline_exceeded');
      const basis = captureDecisionRequest({
        requestId: request.requestId,
        decisionEpoch: request.decisionEpoch,
        context: request.context,
      });
      const input = parseJsonValue(
        { request: { ...request, ...basis }, criteriaDescription },
        'planner_request',
      );
      const output = await generate(
        {
          instructions: plannerInstructions,
          input,
          output: { name: 'umibe_plan', schema: plannerOutputSchema },
        },
        control,
      );
      if (control.signal.aborted)
        throw new DOMException('Model request cancelled', 'AbortError');
      if (Date.now() >= control.deadlineMs)
        throw new ModelRequestError('deadline_exceeded');
      try {
        return decodePlanOutput(output, basis);
      } catch (error) {
        throw modelOutputError('planning', error);
      }
    },
  });
}
