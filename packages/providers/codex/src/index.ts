import { isAbsolute } from 'node:path';
import {
  isJsonObject,
  ModelRequestError,
  parseJsonValue,
} from '@umibe/core/model';
import type { StructuredOutputModel } from '@umibe/core/model';
import { runTurn } from './app-server.js';

export interface CodexModelOptions {
  /** Absolute path to the App-bundled CLI. PATH lookup is never used. */
  readonly executablePath: string;
  /** Omit to use app-server's configured default, independent of this chat's UI. */
  readonly model?: string;
  /** Omit to use app-server's default; supported values depend on the model. */
  readonly reasoningEffort?: string;
}

/**
 * Create a local testing adapter without starting a process or inference.
 * Each generate call owns one process, ephemeral thread and turn. Codex may make
 * internal model calls; Umibe counts the whole turn as one provider invocation.
 * The CLI manages the existing ChatGPT login. No API key is accepted or read here.
 * Cancellation terminates the owned process; remote work may already have begun.
 * Invalid options throw TypeError. The identity model is `default` when omitted.
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
  const config = Object.freeze({ ...options });
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
      if (Buffer.byteLength(JSON.stringify(captured), 'utf8') > 1_048_576)
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
