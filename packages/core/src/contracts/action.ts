import type * as z from 'zod';
import type { CallControl, DecisionContext } from './adapters.js';
import type { JsonObject } from './json.js';
import type { ActionIntent, ActionResult } from './record.js';

export type ActionCheck =
  | { readonly outcome: 'allowed' }
  | { readonly outcome: 'denied' | 'unknown'; readonly reason: string };

export interface ActionExecutionContext extends CallControl {
  readonly executionId: string;
  readonly decision: DecisionContext;
  readonly reportProgress: (progress: JsonObject) => void;
}

export type Reconciliation =
  | {
      readonly outcome: 'performed';
      readonly result: ActionResult;
      readonly underlyingSettled: true;
    }
  | {
      readonly outcome: 'notPerformed';
      readonly underlyingSettled: true;
      readonly reason: string;
    }
  | { readonly outcome: 'unknown'; readonly reason: string };

/** The application owns domain checks and effects. P2 fixes parsed params once per candidate. */
export interface ActionDefinition<TSchema extends z.ZodObject> {
  readonly id: string;
  readonly version: number;
  readonly description: string;
  readonly tags: readonly string[];
  readonly parameters: TSchema;
  readonly expectedEffects: JsonObject;
  readonly retryMode: 'never' | 'idempotent' | 'reconcile';
  check(
    context: DecisionContext,
    params: z.output<TSchema>,
    control: CallControl,
  ): Promise<ActionCheck>;
  execute(
    params: z.output<TSchema>,
    context: ActionExecutionContext,
  ): Promise<ActionResult>;
  verifyResult?(
    intent: ActionIntent,
    result: ActionResult,
    control: CallControl,
  ): Promise<ActionResult>;
  reconcile?(
    intent: ActionIntent,
    control: CallControl,
  ): Promise<Reconciliation>;
}
