import { afterEach, expect, test, vi } from 'vitest';
import { processHasExited } from './ownership.js';

afterEach(() => vi.restoreAllMocks());

test('retains the current live PID', () => {
  expect(processHasExited(process.pid)).toBe(false);
});

test.each(['EPERM', 'EACCES', 'EINVAL', 'unclassified'])(
  'retains ownership when the operating system reports %s',
  (code) => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('process state unavailable'), { code });
    });
    expect(processHasExited(123)).toBe(false);
  },
);

test('allows takeover only after ESRCH', () => {
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('process absent'), { code: 'ESRCH' });
  });
  expect(processHasExited(123)).toBe(true);
});

test('does not probe invalid PIDs or process groups', () => {
  const kill = vi.spyOn(process, 'kill');
  for (const pid of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
    expect(processHasExited(pid)).toBe(false);
  expect(kill).not.toHaveBeenCalled();
});
