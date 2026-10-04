import type * as z from 'zod';
import type { CallControl } from '#internal/contracts/control';
import type { DecisionContext } from '#internal/contracts/context';
import type { ParameterSource } from './candidate.js';
import type { JsonObject } from './json.js';
import type { ActionIntent, ActionResult } from './record.js';

export interface ActionCapability {
  readonly id: string;
  readonly version: number;
  readonly description: string;
  readonly parameters: JsonObject;
  readonly expectedEffects: JsonObject;
  readonly tags: readonly string[];
}

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

/**
 * The application owns domain checks and effects. Keep schemas and defaults
 * deterministic after registration. Registered check/execute callbacks receive
 * deeply frozen parameters with null-prototype objects; treat them as read-only.
 */
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

/** JSON Pointer paths are relative to the parameter object, including nested changes. */
export interface ParameterChange {
  readonly kind: 'added' | 'removed' | 'changed';
  readonly path: string;
}

/** Detached normalized data; preparing a call does not establish its current executability. */
export interface FixedActionCall {
  readonly actionId: string;
  readonly actionVersion: number;
  readonly params: JsonObject;
  readonly paramSources: Readonly<Record<string, ParameterSource>>;
  readonly parameterChanges: readonly ParameterChange[];
}

/**
 * Binds callbacks to one frozen parameter snapshot without parsing again.
 * These low-level calls do not enforce deadlines, check results, authorize execution,
 * or persist intents. The caller owns those boundaries and supplies the decision context.
 * Callback failures, including synchronous throws, reject the returned Promise.
 */
export interface PreparedAction {
  readonly call: FixedActionCall;
  readonly retryMode: 'never' | 'idempotent' | 'reconcile';
  check(context: DecisionContext, control: CallControl): Promise<ActionCheck>;
  execute(context: ActionExecutionContext): Promise<ActionResult>;
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
