import { z } from 'zod';
import type {
  ActionDefinition,
  PreparedAction,
  Reconciliation,
} from '#internal/contracts/action';
import type {
  ActionCapability,
  CallControl,
} from '#internal/contracts/adapters';
import type { ActionIntent } from '#internal/contracts/record';
import type { JsonObject } from '#internal/contracts/json';
import { ContractError } from '#internal/errors';
import {
  requireInteger,
  requireKeys,
  requireObject,
  requireString,
} from '#internal/validation/fields';
import type { FieldContext } from '#internal/validation/fields';
import {
  isJsonArray,
  jsonPointerChild,
  parseJsonValue,
} from '#internal/validation/json';
import { readActionIntent } from '#internal/validation/record';
import { describeActionParameters } from './describe.js';
import {
  assertPreservedParameterKeys,
  normalizeActionParameters,
} from './parameters.js';

/** A factory-created registration; copying its metadata does not copy its implementation. */
export interface RegisteredAction {
  readonly capability: ActionCapability;
  readonly retryMode: 'never' | 'idempotent' | 'reconcile';
}

type PrepareAction = (request: JsonObject) => Promise<PreparedAction>;
interface ActionCallbacks {
  readonly prepare: PrepareAction;
  readonly reconcile?: PreparedAction['reconcile'];
}
const definitions = new WeakMap<RegisteredAction, ActionCallbacks>();
const definitionContext: FieldContext = {
  code: 'INVALID_ACTION_DEFINITION',
  stage: 'action_definition',
};
const parameterContext: FieldContext = {
  code: 'INVALID_ACTION_PARAMETERS',
  stage: 'action_parameters',
};

/**
 * Validate and capture an action while its schema still determines callback types.
 * Metadata is copied; schema and callback references are retained. Do not mutate
 * schema configuration afterward. Schema defaults must be deterministic and pure;
 * description export may evaluate their factories before any call is prepared.
 * @throws ContractError for invalid metadata, callbacks or unsupported parameter descriptions.
 */
export function defineAction<TSchema extends z.ZodObject>(
  input: Omit<ActionDefinition<TSchema>, 'retryMode'> & {
    readonly retryMode?: ActionDefinition<TSchema>['retryMode'];
  },
): RegisteredAction {
  if (typeof input !== 'object' || input === null) {
    throw new ContractError(
      definitionContext.code,
      definitionContext.stage,
      '',
      'expected_action_definition',
    );
  }
  const { parameters, check, execute, verifyResult, reconcile } = input;
  const metadata = requireObject(
    parseJsonValue(
      {
        id: input.id,
        version: input.version,
        description: input.description,
        tags: input.tags,
        expectedEffects: input.expectedEffects,
        retryMode: input.retryMode === undefined ? 'never' : input.retryMode,
      },
      definitionContext.stage,
    ),
    definitionContext,
    '',
  );
  const id = requireString(metadata.id, definitionContext, '/id');
  const version = requireInteger(
    metadata.version,
    1,
    definitionContext,
    '/version',
  );
  const description = requireString(
    metadata.description,
    definitionContext,
    '/description',
  );
  const expectedEffects = requireObject(
    metadata.expectedEffects,
    definitionContext,
    '/expectedEffects',
  );
  if (!isJsonArray(metadata.tags)) {
    throw new ContractError(
      definitionContext.code,
      definitionContext.stage,
      '/tags',
      'expected_array',
    );
  }
  const tags = Object.freeze(
    metadata.tags.map((tag, index) =>
      requireString(tag, definitionContext, `/tags/${index}`),
    ),
  );
  const retryMode = metadata.retryMode;
  if (
    retryMode !== 'never' &&
    retryMode !== 'idempotent' &&
    retryMode !== 'reconcile'
  ) {
    throw new ContractError(
      definitionContext.code,
      definitionContext.stage,
      '/retryMode',
      'invalid_retry_mode',
    );
  }
  for (const [name, callback, required] of [
    ['check', check, true],
    ['execute', execute, true],
    ['verifyResult', verifyResult, false],
    ['reconcile', reconcile, retryMode === 'reconcile'],
  ] as const) {
    if (
      typeof callback !== 'function' &&
      (required || callback !== undefined)
    ) {
      throw new ContractError(
        definitionContext.code,
        definitionContext.stage,
        `/${name}`,
        'expected_callback',
      );
    }
  }
  if (!(parameters instanceof z.ZodObject)) {
    throw new ContractError(
      definitionContext.code,
      definitionContext.stage,
      '/parameters',
      'expected_object_schema',
    );
  }
  const parameterDescription = describeActionParameters(parameters);
  assertPreservedParameterKeys(
    parameterDescription,
    definitionContext,
    '/parameters',
  );
  const capability: ActionCapability = Object.freeze({
    id,
    version,
    description,
    tags,
    expectedEffects,
    parameters: parameterDescription,
  });
  const definition: ActionDefinition<TSchema> = Object.freeze({
    id,
    version,
    description,
    tags,
    expectedEffects,
    parameters,
    retryMode,
    check,
    execute,
    ...(verifyResult === undefined ? {} : { verifyResult }),
    ...(reconcile === undefined ? {} : { reconcile }),
  });
  const registration = Object.freeze({ capability, retryMode });
  const prepare: PrepareAction = async (request) => {
    const inputParams = requireObject(
      request.params,
      parameterContext,
      '/params',
    );
    const { call, params } = await normalizeActionParameters(
      definition.parameters,
      capability,
      inputParams,
      request.paramSources,
    );
    const prepared: PreparedAction = {
      call,
      retryMode,
      async check(context, control) {
        return definition.check(context, params, control);
      },
      async execute(context) {
        return definition.execute(params, context);
      },
    };
    if (definition.verifyResult !== undefined) {
      const verify = definition.verifyResult.bind(definition);
      prepared.verifyResult = async (intent, result, control) =>
        verify(intent, result, control);
    }
    if (definition.reconcile !== undefined) {
      const reconcileCall = definition.reconcile.bind(definition);
      prepared.reconcile = async (intent, control) =>
        reconcileCall(intent, control);
    }
    return Object.freeze(prepared);
  };
  definitions.set(registration, {
    prepare,
    ...(definition.reconcile === undefined
      ? {}
      : { reconcile: definition.reconcile.bind(definition) }),
  });
  return registration;
}

/** One version per ID. Registration never replaces an existing implementation. */
export class ActionRegistry {
  readonly #actions = new Map<
    string,
    { registration: RegisteredAction; callbacks: ActionCallbacks }
  >();

  constructor(actions: readonly RegisteredAction[]) {
    const validArray: boolean = Array.isArray(actions);
    if (!validArray) {
      throw new ContractError(
        'INVALID_ACTION_DEFINITION',
        'action_registration',
        '/actions',
        'expected_array',
      );
    }
    for (const action of actions) this.register(action);
  }

  /** @throws ContractError for a duplicate ID or a value not created by defineAction. */
  register(action: RegisteredAction): void {
    const callbacks = definitions.get(action);
    if (callbacks === undefined) {
      throw new ContractError(
        'INVALID_ACTION_DEFINITION',
        'action_registration',
        '/actions',
        'unregistered_definition',
      );
    }
    const id = action.capability.id;
    if (this.#actions.has(id)) {
      throw new ContractError(
        'INVALID_ACTION_DEFINITION',
        'action_registration',
        jsonPointerChild('/actions', id),
        'duplicate_action_id',
      );
    }
    this.#actions.set(id, { registration: action, callbacks });
  }

  /** Each read returns a frozen catalog sorted by action ID, with JSON data only. */
  get capabilities(): readonly ActionCapability[] {
    return Object.freeze(
      [...this.#actions.values()]
        .map(({ registration }) => registration.capability)
        .sort((left, right) =>
          left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
        ),
    );
  }

  /**
   * Capture { actionId, actionVersion, params, paramSources } before yielding,
   * then parse exactly once. Missing defaulted input fields need no source entry.
   * Rejects with ContractError for invalid calls or non-JSON parsed output.
   * The returned callbacks bind these parameters; they do not schedule execution.
   */
  async prepare(input: unknown): Promise<PreparedAction> {
    const request = requireObject(
      parseJsonValue(input, parameterContext.stage),
      parameterContext,
      '',
    );
    requireKeys(
      request,
      ['actionId', 'actionVersion', 'params', 'paramSources'],
      parameterContext,
      '',
    );
    const id = requireString(request.actionId, parameterContext, '/actionId');
    const version = requireInteger(
      request.actionVersion,
      1,
      parameterContext,
      '/actionVersion',
    );
    const action = this.#actions.get(id);
    if (action === undefined) {
      throw new ContractError(
        parameterContext.code,
        parameterContext.stage,
        '/actionId',
        'unknown_action',
      );
    }
    if (action.registration.capability.version !== version) {
      throw new ContractError(
        parameterContext.code,
        parameterContext.stage,
        '/actionVersion',
        'action_version_mismatch',
      );
    }
    return action.callbacks.prepare(request);
  }

  /**
   * Rebind a persisted intent to its exact action version without parsing its
   * normalized parameters again. Missing capability leaves effects unknown.
   */
  async reconcile(
    input: ActionIntent,
    control: CallControl,
  ): Promise<Reconciliation> {
    const intent = readActionIntent(parseJsonValue(input, 'reconciliation'));
    const action = this.#actions.get(intent.actionId);
    if (action?.registration.capability.version !== intent.actionVersion)
      throw new ContractError(
        'INVALID_ACTION_DEFINITION',
        'reconciliation',
        '/actionVersion',
        'action_version_mismatch',
      );
    return action.callbacks.reconcile === undefined
      ? { outcome: 'unknown', reason: 'reconciliation_unavailable' }
      : action.callbacks.reconcile(intent, control);
  }
}
