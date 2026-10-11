import type { Planner } from './contracts.js';
import type {
  StructuredOutputModel,
  StructuredOutputRequest,
} from '#internal/model/contracts';
import { captureModelIdentity } from '#internal/model/validation';
import { captureDecisionRequest } from '#internal/candidate/context';
import { captureControl } from '#internal/candidate/control';
import { parseJsonValue } from '#internal/validation/json';
import { modelOutputError } from '#internal/model/output-error';
import { ModelRequestError } from '#internal/runtime/model';
import { projectPlannerInput } from '#internal/model/projection';
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
      const captured = { ...request, ...basis };
      const source = parseJsonValue(captured, 'planner_request');
      const input = parseJsonValue(
        projectPlannerInput(captured, criteriaDescription),
        'planner_request',
      );
      const modelRequest: StructuredOutputRequest = Object.freeze({
        instructions: plannerInstructions,
        input,
        output: Object.freeze({
          name: 'umibe_plan',
          schema: plannerOutputSchema,
        }),
      });
      if (control.recordModelProjection !== undefined) {
        await control.recordModelProjection({
          role: 'planning',
          version: 1,
          source,
          request: parseJsonValue(modelRequest, 'planner_request'),
        });
        if (control.signal.aborted)
          throw new DOMException('Model request cancelled', 'AbortError');
        if (Date.now() >= control.deadlineMs)
          throw new ModelRequestError('deadline_exceeded');
      }
      const output = await generate(modelRequest, control);
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
