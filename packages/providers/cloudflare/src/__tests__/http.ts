import { createServer } from 'node:http';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import { afterEach } from 'vitest';
import type { ChoiceRequest, JsonObject } from '@umibe/core/model';

const servers = new Set<ReturnType<typeof createServer>>();
afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  servers.clear();
});

export interface HttpRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: unknown;
}

export async function httpFixture(
  handle: (
    request: HttpRequest,
    response: ServerResponse,
  ) => void | Promise<void>,
) {
  const requests: HttpRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
        );
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const received = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
      };
      requests.push(received);
      await handle(received, response);
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  servers.add(server);
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('HTTP fixture did not bind');
  return { baseURL: `http://127.0.0.1:${address.port}/client/v4`, requests };
}

export const options = {
  accountId: 'test-account',
  apiToken: 'test-only-token',
  model: '@cf/cloudflare/clef',
} as const;
export const choiceRequest: ChoiceRequest = {
  input: { status: 'known' },
  instructions: {
    question: 'Choose an option',
    reference: { goal: 'synthetic' },
  },
  options: [
    { id: 'a', description: { action: 'safe_a' } },
    { id: 'none', description: 'Abstain' },
  ],
};

export function responseBody(
  ids: readonly string[] = ['a', 'none'],
  choice = ids[0]!,
): JsonObject {
  return {
    success: true,
    errors: [],
    messages: [],
    result: {
      model: 'actual-clef',
      usage: { input_tokens: 17, output_tokens: 0 },
      answers: {
        selection: {
          type: 'choice',
          choice,
          probabilities: Object.fromEntries(
            ids.map((id) => [id, id === choice ? 1 : 0]),
          ),
          confidence: 0.04,
        },
      },
    },
  };
}

export function callControl(milliseconds = 5_000) {
  return {
    signal: new AbortController().signal,
    deadlineAt: new Date(Date.now() + milliseconds).toISOString(),
  };
}
