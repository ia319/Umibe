import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import {
  isJsonObject,
  isJsonArray,
  ModelRequestError,
  parseJsonValue,
} from '@umibe/core/model';
import type {
  CallControl,
  JsonObject,
  JsonValue,
  ModelFailureCode,
  ModelUsage,
  StructuredOutputRequest,
} from '@umibe/core/model';
import type { CodexModelOptions } from './index.js';

// These process-local overrides target the App's 0.159.2 protocol. Empty
// environments remove filesystem tools; feature flags also remove built-ins.
// https://learn.chatgpt.com/docs/app-server
const disabledFeatures = [
  'apps',
  'plugins',
  'hooks',
  'multi_agent',
  'multi_agent_v2',
  'code_mode',
  'code_mode_host',
  'shell_tool',
  'unified_exec',
  'js_repl',
  'skill_search',
  'skill_mcp_dependency_install',
  'memories',
  'context_management',
  'goals',
  'sleep_tool',
  'view_image',
  'image_generation',
  'browser_use',
  'computer_use',
  'workspace_dependencies',
  'tool_suggest',
  'default_mode_request_user_input',
];
const overrides = [
  ...disabledFeatures.map((name) => `features.${name}=false`),
  'features.skip_host_skill_discovery=true',
  'tools.update_plan.enabled=false',
  'tools.experimental_request_user_input.enabled=false',
  'web_search="disabled"',
  'skills.include_instructions=false',
  'skills.bundled.enabled=false',
  'project_doc_max_bytes=0',
  'include_environment_context=false',
  'include_apps_instructions=false',
  'include_collaboration_mode_instructions=false',
];

function object(value: JsonValue | undefined): JsonObject {
  if (!isJsonObject(value)) throw new ModelRequestError('invalid_response');
  return value;
}

function turnFailure(info: JsonValue | undefined): ModelRequestError {
  const codes: Readonly<Record<string, ModelFailureCode>> = {
    contextWindowExceeded: 'input_limit',
    usageLimitExceeded: 'rate_limited',
    rateLimitExceeded: 'rate_limited',
    serverOverloaded: 'unavailable',
    flexUnavailable: 'unavailable',
    internalServerError: 'unavailable',
    unauthorized: 'unauthorized',
    badRequest: 'invalid_request',
    cyberPolicy: 'refused',
    misalignmentPolicyViolation: 'refused',
  };
  return new ModelRequestError(
    typeof info === 'string' && Object.hasOwn(codes, info)
      ? (codes[info] ?? 'request_failed')
      : 'request_failed',
  );
}

export async function runTurn(
  options: CodexModelOptions,
  request: StructuredOutputRequest,
  control: CallControl,
): Promise<JsonValue> {
  const deadline = Date.parse(control.deadlineAt);
  const child = spawn(
    options.executablePath,
    [
      'app-server',
      '--listen',
      'stdio://',
      ...overrides.flatMap((value) => ['-c', value]),
    ],
    { cwd: homedir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const closed = new Promise<void>((resolve) =>
    child.once('close', () => resolve()),
  );
  const pending = new Map<
    number,
    {
      resolve(value: JsonObject): void;
      reject(error: Error): void;
    }
  >();
  let nextId = 1;
  let buffer = '';
  let threadId: string | null = null;
  let turnId: string | null = null;
  let turnRequested = false;
  let actualModel: string | null = null;
  let usage: ModelUsage | null = null;
  let invalidUsage = false;
  let finalText: string | null = null;
  let failure: Error | null = null;
  let settled = false;
  let turnFinished = false;
  let reported = false;
  let finishTurn!: (turn: JsonObject) => void;
  let rejectTurn!: (error: Error) => void;
  const completion = new Promise<JsonObject>((resolve, reject) => {
    finishTurn = resolve;
    rejectTurn = reject;
  });
  // Completion can fail during initialization, before the caller awaits it.
  void completion.catch(() => {});

  const fail = (error: Error) => {
    if (settled || failure !== null) return;
    failure = error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    rejectTurn(error);
  };
  const checkActive = () => {
    if (failure !== null) throw failure;
    if (control.signal.aborted)
      throw new DOMException('Model request cancelled', 'AbortError');
    if (Date.now() >= deadline)
      throw new ModelRequestError('deadline_exceeded');
  };
  const send = (message: JsonObject) => {
    checkActive();
    child.stdin.write(JSON.stringify(message) + '\n');
  };
  const rpc = (method: string, params: JsonObject): Promise<JsonObject> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      try {
        send({ id, method, params });
      } catch (error) {
        pending.delete(id);
        reject(
          error instanceof Error
            ? error
            : new ModelRequestError('request_failed'),
        );
      }
    });
  const abort = () =>
    fail(new DOMException('Model request cancelled', 'AbortError'));
  const timer = setTimeout(
    () => fail(new ModelRequestError('deadline_exceeded')),
    Math.max(1, Math.min(deadline - Date.now(), 2_147_483_647)),
  );
  control.signal.addEventListener('abort', abort, { once: true });
  child.on('error', () => fail(new ModelRequestError('request_failed')));
  child.on('close', () => fail(new ModelRequestError('request_failed')));
  child.stdin.on('error', () => fail(new ModelRequestError('request_failed')));
  child.stdout.on('error', () => fail(new ModelRequestError('request_failed')));
  child.stderr.on('error', () => fail(new ModelRequestError('request_failed')));
  child.stderr.resume();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (settled || failure !== null) return;
    try {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > 8_388_608)
        throw new ModelRequestError('invalid_response');
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        const message = object(
          parseJsonValue(JSON.parse(line), 'codex_protocol'),
        );
        if (message.method === undefined && typeof message.id === 'number') {
          const waiter = pending.get(message.id);
          if (waiter === undefined) continue;
          pending.delete(message.id);
          if (message.error !== undefined) {
            waiter.reject(
              new ModelRequestError(
                object(message.error).code === -32602
                  ? 'invalid_request'
                  : 'request_failed',
              ),
            );
          } else waiter.resolve(object(message.result));
          continue;
        }
        if (message.id !== undefined) {
          // No client tools or interactive approvals exist in this adapter.
          send({
            id: message.id,
            error: { code: -32601, message: 'Unsupported client request' },
          });
          throw new ModelRequestError('invalid_response');
        }
        if (typeof message.method !== 'string' || !isJsonObject(message.params))
          continue;
        if (turnFinished) continue;
        const params = message.params;
        if (!turnRequested || params.threadId !== threadId) continue;
        if (message.method === 'turn/started') {
          const id = object(params.turn).id;
          if (typeof id !== 'string')
            throw new ModelRequestError('invalid_response');
          if (turnId !== null && turnId !== id)
            throw new ModelRequestError('invalid_response');
          turnId = id;
        }
        const eventTurnId =
          message.method === 'turn/completed'
            ? object(params.turn).id
            : params.turnId;
        if (eventTurnId !== turnId || turnId === null) continue;
        if (message.method === 'model/rerouted') {
          actualModel =
            typeof params.toModel === 'string' ? params.toModel : null;
        } else if (message.method === 'thread/tokenUsage/updated') {
          const total = object(object(params.tokenUsage).total);
          const tokens = (value: JsonValue | undefined): number | null => {
            if (value === null || value === undefined) return null;
            if (
              typeof value === 'number' &&
              Number.isSafeInteger(value) &&
              value >= 0
            )
              return value;
            invalidUsage = true;
            return null;
          };
          // A fresh thread contains only this turn. Totals are cumulative;
          // adding notifications would double-count internal model calls.
          usage = {
            inputTokens: tokens(total.inputTokens),
            outputTokens: tokens(total.outputTokens),
            totalTokens: tokens(total.totalTokens),
          };
        } else if (message.method === 'item/completed') {
          const item = object(params.item);
          if (
            item.type === 'agentMessage' &&
            item.phase === 'final_answer' &&
            typeof item.text === 'string'
          )
            finalText = item.text;
        } else if (message.method === 'turn/completed') {
          turnFinished = true;
          finishTurn(object(params.turn));
        }
      }
    } catch (error) {
      fail(
        error instanceof ModelRequestError
          ? error
          : new ModelRequestError('invalid_response'),
      );
    }
  });

  try {
    if (control.signal.aborted) abort();
    await rpc('initialize', {
      clientInfo: { name: 'umibe_provider_codex', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    });
    send({ method: 'initialized', params: {} });
    const account = await rpc('account/read', { refreshToken: false });
    if (!isJsonObject(account.account) || account.account.type !== 'chatgpt')
      throw new ModelRequestError('unauthorized');
    const started = await rpc('thread/start', {
      ephemeral: true,
      environments: [],
      dynamicTools: [],
      selectedCapabilityRoots: [],
      approvalPolicy: 'never',
      allowProviderModelFallback: false,
      baseInstructions: request.instructions,
      developerInstructions: '',
      // App 0.159.2 replaces this table in thread overrides, removing inherited MCP servers.
      config: { mcp_servers: {} },
      ...(options.model === undefined ? {} : { model: options.model }),
    });
    const id = object(started.thread).id;
    if (typeof id !== 'string' || !id)
      throw new ModelRequestError('invalid_response');
    threadId = id;
    actualModel =
      typeof started.model === 'string' && started.model.trim()
        ? started.model
        : null;
    turnRequested = true;
    const startedTurn = await rpc('turn/start', {
      threadId,
      environments: [],
      input: [{ type: 'text', text: JSON.stringify(request.input) }],
      outputSchema: request.output.schema,
      ...(options.reasoningEffort === undefined
        ? {}
        : { effort: options.reasoningEffort }),
    });
    const returnedTurnId = object(startedTurn.turn).id;
    if (
      typeof returnedTurnId !== 'string' ||
      !returnedTurnId ||
      (turnId !== null && turnId !== returnedTurnId)
    )
      throw new ModelRequestError('invalid_response');
    turnId = returnedTurnId;
    const turn = await completion;
    checkActive();
    reported = true;
    control.reportModelResponse?.({
      model: actualModel,
      requestId: null,
      usage,
    });
    if (invalidUsage) throw new ModelRequestError('invalid_response');
    if (turn.status === 'failed')
      throw turnFailure(
        isJsonObject(turn.error) ? turn.error.codexErrorInfo : null,
      );
    if (turn.status !== 'completed')
      throw new ModelRequestError('request_failed');
    if (isJsonArray(turn.items)) {
      for (const value of turn.items) {
        const item = object(value);
        if (
          item.type === 'agentMessage' &&
          item.phase !== 'commentary' &&
          typeof item.text === 'string'
        )
          finalText = item.text;
      }
    }
    try {
      if (finalText === null) throw new ModelRequestError('invalid_response');
      return parseJsonValue(JSON.parse(finalText), 'codex_output');
    } catch {
      throw new ModelRequestError('invalid_response');
    }
  } catch (error) {
    if (
      !reported &&
      usage !== null &&
      !control.signal.aborted &&
      Date.now() < deadline
    )
      control.reportModelResponse?.({
        model: actualModel,
        requestId: null,
        usage,
      });
    throw error;
  } finally {
    settled = true;
    clearTimeout(timer);
    control.signal.removeEventListener('abort', abort);
    if (
      !turnFinished &&
      threadId !== null &&
      turnId !== null &&
      !child.stdin.destroyed
    )
      child.stdin.write(
        JSON.stringify({
          id: nextId++,
          method: 'turn/interrupt',
          params: { threadId, turnId },
        }) + '\n',
      );
    child.kill('SIGKILL');
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      closed,
      new Promise<void>((resolve) => {
        cleanupTimer = setTimeout(resolve, 1000);
      }),
    ]);
    clearTimeout(cleanupTimer);
    child.unref();
  }
}
