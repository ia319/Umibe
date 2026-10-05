import type {
  ChoiceModel,
  ChoiceRequest,
  ChoiceResponse,
} from '@umibe/core/model';
import { createPlanner, createSelector } from '@umibe/core';

declare const model: ChoiceModel;
declare const request: ChoiceRequest;
declare const response: ChoiceResponse;

createSelector({ model });
// @ts-expect-error Native choice cannot generate structured planning output.
createPlanner({ model });
// @ts-expect-error A request cannot rewrite the fixed options.
request.options = [];
// @ts-expect-error Returned probabilities are immutable.
response.probabilities!.candidate = 0;
