import { isAbsolute } from 'node:path';
import {
  isJsonObject,
  ModelRequestError,
  parseJsonValue,
} from '@umibe/core/model';
import type { JsonObject, StructuredOutputModel } from '@umibe/core/model';
import { runTurn } from './app-server.js';

export interface CodexModelOptions {
  /** Absolute path to the App-bundled CLI. PATH lookup is never used. */
  readonly executablePath: string;
  /** Omit to use app-server's configured default, independent of this chat's UI. */
  readonly model?: string;
  /** Omit to use app-server's default; supported values depend on the model. */
  readonly reasoningEffort?: string;
  /**
   * Additional thread/start JSON parameters, copied at construction, such as
   * serviceTier. Model identity, role content, session lifecycle, tools and
   * permissions are adapter-owned; conflicts throw TypeError. Native parameters
   * share the 1 MiB request limit with role input.
   */
  readonly threadParameters?: JsonObject;
  /**
   * Additional turn/start JSON parameters, copied at construction, such as summary
   * or serviceTier. The same adapter-owned fields are reserved here; use
   * reasoningEffort above for effort and model above for model.
   */
  readonly turnParameters?: JsonObject;
}

/**
 * Create a local testing adapter without starting a process or inference.
 * Each generate call owns one process, ephemeral thread and turn. Codex may make
 * internal model calls; Umibe counts the whole turn as one provider invocation.
 * The CLI manages the existing ChatGPT login. No API key is accepted or read here.
 * Cancellation terminates the owned process; remote work may already have begun.
 * Invalid options throw. The identity model is `default` when omitted.
 */
export function createCodexModel(
  options: CodexModelOptions,
): StructuredOutputModel {
  if (
    typeof options.executablePath !== 'string' ||
    options.executablePath.includes('\0') ||
    !isAbsolute(options.executablePath)
  )
    throw new TypeError('executablePath must be an absolute App CLI path');
  for (const value of [options.model, options.reasoningEffort]) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim()))
      throw new TypeError(
        'model and reasoningEffort must be nonempty when supplied',
      );
  }
  const threadParameters = parseJsonValue(
    options.threadParameters === undefined ? {} : options.threadParameters,
    'codex_thread_parameters',
  );
  const turnParameters = parseJsonValue(
    options.turnParameters === undefined ? {} : options.turnParameters,
    'codex_turn_parameters',
  );
  if (!isJsonObject(threadParameters))
    throw new TypeError('threadParameters must be a JSON object');
  if (!isJsonObject(turnParameters))
    throw new TypeError('turnParameters must be a JSON object');
  // App-server parameters also control tools and session state. Preserve the
  // adapter's one fresh, inference-only turn when forwarding native settings.
  for (const [name, parameters] of Object.entries({
    threadParameters,
    turnParameters,
  }))
    for (const key of [
      'model',
      'modelProvider',
      'effort',
      'allowProviderModelFallback',
      'threadId',
      'ephemeral',
      'historyMode',
      'projectId',
      'parentTurnId',
      'rootTurnId',
      'baseInstructions',
      'developerInstructions',
      'input',
      'additionalContext',
      'outputSchema',
      'toolOutput',
      'collaborationMode',
      'config',
      'dynamicTools',
      'selectedCapabilityRoots',
      'environments',
      'cwd',
      'runtimeWorkspaceRoots',
      'approvalPolicy',
      'approvalsReviewer',
      'permissions',
      'sandbox',
      'sandboxPolicy',
      'multiAgentMode',
      'disabledPluginIds',
      'daybreakEnabled',
      'cyberAccessProgram',
    ])
      if (Object.hasOwn(parameters, key))
        throw new TypeError(`${name}.${key} is controlled by the adapter`);
  const parameterBytes = Buffer.byteLength(
    JSON.stringify({ threadParameters, turnParameters }),
    'utf8',
  );
  const config = Object.freeze({
    ...options,
    threadParameters,
    turnParameters,
  });
  return Object.freeze<StructuredOutputModel>({
    kind: 'structuredOutput',
    identity: Object.freeze({
      provider: 'codex',
      model: config.model ?? 'default',
    }),
    async generate(request, control) {
      const deadline = Date.parse(control.deadlineAt);
      if (
        !(control.signal instanceof AbortSignal) ||
        !Number.isFinite(deadline) ||
        new Date(deadline).toISOString() !== control.deadlineAt
      )
        throw new ModelRequestError('invalid_request');
      if (control.signal.aborted)
        throw new DOMException('Model request cancelled', 'AbortError');
      if (deadline <= Date.now())
        throw new ModelRequestError('deadline_exceeded');
      let captured;
      try {
        const schema = parseJsonValue(request.output.schema, 'model_schema');
        if (
          !isJsonObject(schema) ||
          schema.type !== 'object' ||
          typeof request.instructions !== 'string' ||
          !request.instructions.trim() ||
          typeof request.output.name !== 'string' ||
          !/^[A-Za-z0-9_-]{1,64}$/.test(request.output.name)
        )
          throw new ModelRequestError('invalid_request');
        captured = {
          instructions: request.instructions,
          input: parseJsonValue(request.input, 'model_input'),
          output: { name: request.output.name, schema },
        };
      } catch {
        throw new ModelRequestError('invalid_request');
      }
      if (
        Buffer.byteLength(JSON.stringify(captured), 'utf8') + parameterBytes >
        1_048_576
      )
        throw new ModelRequestError('input_limit');
      try {
        const result = await runTurn(config, captured, control);
        if (Date.now() >= deadline)
          throw new ModelRequestError('deadline_exceeded');
        if (control.signal.aborted)
          throw new DOMException('Model request cancelled', 'AbortError');
        return result;
      } catch (error) {
        if (control.signal.aborted)
          throw new DOMException('Model request cancelled', 'AbortError');
        if (
          error instanceof ModelRequestError ||
          (error instanceof Error && error.name === 'AbortError')
        )
          throw error;
        throw new ModelRequestError('request_failed');
      }
    },
  });
}
