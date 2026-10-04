import { fork } from 'node:child_process';

export interface CrashConfig {
  readonly directory: string;
  readonly operation: 'start' | 'resume' | 'reconcile';
  readonly boundary?:
    | 'beforeIntent'
    | 'afterIntent'
    | 'afterEffect'
    | 'afterResult'
    | 'beforeProgress'
    | 'afterProgress'
    | 'modelReserved'
    | 'modelResponse'
    | 'controlCommitted';
  readonly reconcile?: 'automatic' | 'unknown' | 'missing';
  readonly nested?: boolean;
  readonly target?: number;
  readonly parameterDefault?: number;
  readonly applicationId?: string;
  readonly actionVersion?: number;
  readonly control?: 'pauseRun' | 'cancelRun';
  readonly cancelAfterEffect?: boolean;
  readonly duplicate?: 'pauseRun' | 'cancelRun';
}

export interface CrashReply {
  readonly kind: 'boundary' | 'done' | 'error';
  readonly boundary?: CrashConfig['boundary'];
  readonly status?: string;
  readonly reason?: string;
  readonly duplicate?: { before: number; after: number; conflict: string };
}

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
