import { fork } from 'node:child_process';
import type { CrashConfig, CrashReply } from './crash-process.js';

/** End the entire host after its IPC boundary, including its real storage Worker. */
export async function runCrashProcess(
  config: CrashConfig,
): Promise<CrashReply> {
  const child = fork(
    new URL('./crash-process.ts', import.meta.url),
    [JSON.stringify(config)],
    {
      execArgv: [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  let stderr = '';
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  let stopped = false;
  child.once('exit', () => {
    stopped = true;
  });
  const exited = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<CrashReply>((resolve, reject) => {
      child.once('message', (reply: CrashReply) => resolve(reply));
      child.once('error', reject);
      child.once('exit', (code) =>
        reject(new Error(`Crash fixture exited with ${code}: ${stderr}`)),
      );
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `Crash fixture did not reach ${config.boundary ?? config.operation}: ${stderr}`,
            ),
          ),
        10_000,
      );
    });
  } finally {
    clearTimeout(timer);
    if (!stopped) child.kill('SIGKILL');
    await exited;
  }
}
