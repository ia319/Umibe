import type { AgentOptions as CoreOptions, RunHandle } from '@umibe/core';
import { createAgent } from './index.js';
import type {
  Agent,
  AgentOptions,
  RunInspection,
  StorageInspection,
} from './index.js';

declare const adapters: Omit<
  CoreOptions<{ count: number }>,
  'store' | 'applicationId'
>;
const options: AgentOptions<{ count: number }> = {
  ...adapters,
  applicationId: 'app',
};
const agent: Agent = createAgent(options);
const storage: Promise<StorageInspection> = agent.inspect();
const run: Promise<RunInspection | null> = agent.inspect('run');
const resumed: Promise<RunHandle> = agent.resume('run');
void storage;
void run;
void resumed;
createAgent({ ...adapters, persistence: { mode: 'memory' } });
// @ts-expect-error SQLite requires a stable application identity.
createAgent(adapters);
createAgent({
  ...adapters,
  // @ts-expect-error Memory mode cannot silently ignore a configured database path.
  persistence: { mode: 'memory', path: 'run.sqlite' },
});
