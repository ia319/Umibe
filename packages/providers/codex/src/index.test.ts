import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isJsonObject, parseJsonValue } from '@umibe/core/model';
import type { JsonObject, StructuredOutputRequest } from '@umibe/core/model';
import { createCodexModel } from './index.js';

const launch = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: launch }));

const request: StructuredOutputRequest = {
  instructions: 'Return the requested JSON object',
  input: { task: 'synthetic' },
  output: {
    name: 'probe',
    schema: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    },
  },
};

function server(mode: 'success' | 'invalid' | 'failed' | 'waiting') {
  const messages: JsonObject[] = [];
  const stdout = new PassThrough();
  const process = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    stdin: new Writable({
      write(chunk: Buffer, _encoding, callback) {
        const message = parseJsonValue(
          JSON.parse(chunk.toString('utf8')),
          'fixture',
        );
        if (!isJsonObject(message)) throw new Error('Expected RPC object');
        messages.push(message);
        const reply = (result: JsonObject) =>
          stdout.write(JSON.stringify({ id: message.id, result }) + '\n');
        const event = (method: string, params: JsonObject) =>
          stdout.write(JSON.stringify({ method, params }) + '\n');
        if (message.method === 'initialize') reply({});
        else if (message.method === 'account/read')
          reply({ account: { type: 'chatgpt' } });
        else if (message.method === 'thread/start')
          reply({ thread: { id: 'thread' }, model: 'actual-default' });
        else if (message.method === 'turn/start') {
          // Notifications may precede the RPC response. Usage snapshots are
          // cumulative even when Codex makes more than one internal model call.
          const basis = { threadId: 'thread', turnId: 'turn' };
          event('turn/started', { threadId: 'thread', turn: { id: 'turn' } });
          reply({ turn: { id: 'turn' } });
          if (mode !== 'waiting') {
            event('thread/tokenUsage/updated', {
              ...basis,
              tokenUsage: {
                total: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
              },
            });
            event('thread/tokenUsage/updated', {
              ...basis,
              tokenUsage: {
                total: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
              },
            });
            event('item/completed', {
              ...basis,
              item: {
                type: 'agentMessage',
                phase: 'commentary',
                text: 'Ignored preamble',
              },
            });
            event('turn/completed', {
              threadId: 'thread',
              turn: {
                id: 'turn',
                status: mode === 'failed' ? 'failed' : 'completed',
                error:
                  mode === 'failed'
                    ? {
                        codexErrorInfo: 'unauthorized',
                        message: 'Private service detail',
                      }
                    : null,
                items: [
                  {
                    type: 'agentMessage',
                    phase: 'final_answer',
                    text: mode === 'invalid' ? '{invalid' : '{"ok":true}',
                  },
                ],
              },
            });
          }
        }
        callback();
      },
    }),
    kill: vi.fn(() => {
      queueMicrotask(() => process.emit('close', 0));
      return true;
    }),
    unref: vi.fn(),
  });
  launch.mockReturnValue(process);
  return { process, messages };
}

afterEach(() => vi.clearAllMocks());

describe('Codex provider', () => {
  it('owns one turn, uses defaults and reports cumulative usage once', async () => {
    const { process, messages } = server('success');
    const model = createCodexModel({
      executablePath: globalThis.process.execPath,
    });
    expect(launch).not.toHaveBeenCalled();
    const reportModelResponse = vi.fn();
    await expect(
      model.generate(request, {
        signal: new AbortController().signal,
        deadlineAt: new Date(Date.now() + 10_000).toISOString(),
        reportModelResponse,
      }),
    ).resolves.toEqual({ ok: true });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]?.[1]).toContain('features.shell_tool=false');
    const thread = messages.find(
      (message) => message.method === 'thread/start',
    );
    expect(thread?.params).toMatchObject({
      ephemeral: true,
      environments: [],
      selectedCapabilityRoots: [],
      baseInstructions: request.instructions,
      config: { mcp_servers: {} },
    });
    expect(thread?.params).not.toHaveProperty('model');
    const turns = messages.filter((message) => message.method === 'turn/start');
    expect(turns).toHaveLength(1);
    expect(turns[0]?.params).not.toHaveProperty('effort');
    expect(reportModelResponse).toHaveBeenCalledExactlyOnceWith({
      model: 'actual-default',
      requestId: null,
      usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
    });
    expect(process.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });

  it.each([
    ['invalid', 'invalid_response'],
    ['failed', 'unauthorized'],
  ] as const)('rejects %s output without another turn', async (mode, code) => {
    const { messages, process } = server(mode);
    const model = createCodexModel({
      executablePath: globalThis.process.execPath,
      model: 'chosen',
      reasoningEffort: 'low',
    });
    const reportModelResponse = vi.fn();
    await expect(
      model.generate(request, {
        signal: new AbortController().signal,
        deadlineAt: new Date(Date.now() + 10_000).toISOString(),
        reportModelResponse,
      }),
    ).rejects.toMatchObject({ name: 'ModelRequestError', code, message: code });
    expect(
      messages.filter((message) => message.method === 'turn/start'),
    ).toHaveLength(1);
    expect(
      messages.find((message) => message.method === 'thread/start')?.params,
    ).toHaveProperty('model', 'chosen');
    expect(
      messages.find((message) => message.method === 'turn/start')?.params,
    ).toHaveProperty('effort', 'low');
    expect(reportModelResponse).toHaveBeenCalledTimes(1);
    expect(process.kill).toHaveBeenCalledTimes(1);
  });

  it.each(['cancel', 'timeout'] as const)(
    'terminates a pending turn on %s',
    async (mode) => {
      const { process, messages } = server('waiting');
      const controller = new AbortController();
      const reportModelResponse = vi.fn();
      const result = createCodexModel({
        executablePath: globalThis.process.execPath,
      }).generate(request, {
        signal: controller.signal,
        deadlineAt: new Date(
          Date.now() + (mode === 'timeout' ? 100 : 10_000),
        ).toISOString(),
        reportModelResponse,
      });
      const rejection = expect(result).rejects.toMatchObject(
        mode === 'cancel'
          ? { name: 'AbortError' }
          : { code: 'deadline_exceeded' },
      );
      await vi.waitFor(
        () =>
          expect(
            messages.some((message) => message.method === 'turn/start'),
          ).toBe(true),
        { interval: 1 },
      );
      if (mode === 'cancel') controller.abort();
      await rejection;
      expect(process.kill).toHaveBeenCalledTimes(1);
      expect(
        messages.filter((message) => message.method === 'turn/interrupt'),
      ).toHaveLength(1);
      expect(reportModelResponse).not.toHaveBeenCalled();
    },
  );
});
