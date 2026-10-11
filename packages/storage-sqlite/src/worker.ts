import { parentPort, workerData } from 'node:worker_threads';
import { writeSync } from 'node:fs';
import { ContractError, StoreError } from '@umibe/core';
import { RunDatabase } from './database.js';
import type {
  StoreCommand,
  StoreFailure,
  StoreReply,
  StoreRequest,
  StoreResponse,
} from './protocol.js';

const port = parentPort;
if (port === null || typeof workerData !== 'string')
  throw new Error('Invalid SQLite Worker initialization');
const database = new RunDatabase(workerData);

function execute(command: StoreCommand): StoreReply {
  switch (command.op) {
    case 'acquireRun':
      return database.acquireRun(command.runId, command.clientId);
    case 'releaseRun':
      return database.releaseRun(
        command.runId,
        command.token,
        command.clientId,
      );
    case 'releaseClient':
      return database.releaseClient(command.clientId);
    case 'readRun':
      return database.readRun(command.runId);
    case 'readRecord':
      return database.readRecord(command.runId, command.eventId);
    case 'readRecords':
      return database.readRecords(
        command.runId,
        command.sequence,
        command.limit,
      );
    case 'commit':
      return database.commit(command.input, command.clientId);
    case 'inspect':
      return database.inspect();
    case 'close':
      return database.close();
  }
}

function failure(error: unknown): StoreFailure {
  if (error instanceof ContractError)
    return {
      type: 'contract',
      code: error.code,
      stage: error.stage,
      path: error.path,
      reason: error.reason,
    };
  if (error instanceof StoreError)
    return { type: 'storage', code: error.code, reason: error.reason };
  const code =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : 'unknown_storage_error';
  return {
    type: 'storage',
    code: /^SQLITE_(BUSY|LOCKED)/.test(code)
      ? 'STORE_BUSY'
      : /^SQLITE_(CORRUPT|NOTADB)/.test(code)
        ? 'STORE_CORRUPT'
        : 'STORE_FAILED',
    reason: code,
  };
}

port.on('message', function handleRequest({ id, command }: StoreRequest) {
  let response: StoreResponse;
  try {
    response = { id, ok: true, value: execute(command) };
  } catch (error) {
    const detail = failure(error);
    response = {
      id,
      ok: false,
      error: detail,
      // Lock contention does not invalidate the connection or process ownership.
      fatal:
        detail.type === 'storage' &&
        detail.code !== 'STORE_BUSY' &&
        (detail.code !== 'STORE_OWNERSHIP' ||
          detail.reason === 'process_owner_lost'),
    };
  }
  // Flush this boundary before native Worker shutdown can interrupt buffered output.
  if (process.env.UMIBE_SQLITE_TRACE === '1' && !response.ok && response.fatal)
    writeSync(
      2,
      `[sqlite-diag worker ${process.pid}] send fatal ${command.op} ${response.error.reason}\n`,
    );
  port.postMessage(response);
  if (process.env.UMIBE_SQLITE_TRACE === '1' && !response.ok && response.fatal)
    writeSync(2, `[sqlite-diag worker ${process.pid}] fatal response posted\n`);
  if (command.op === 'close' || (!response.ok && response.fatal)) {
    // Stop queued commands and drain native finalizers without releasing a failed owner's claim.
    port.off('message', handleRequest);
    try {
      if (command.op !== 'close') database.dispose();
    } finally {
      port.close();
    }
  }
});
