import { parentPort, workerData } from 'node:worker_threads';
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
      return database.acquireRun(command.runId);
    case 'releaseRun':
      return database.releaseRun(command.runId, command.token);
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
      return database.commit(command.input);
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

port.on('message', ({ id, command }: StoreRequest) => {
  let response: StoreResponse;
  try {
    response = { id, ok: true, value: execute(command) };
  } catch (error) {
    const detail = failure(error);
    response = {
      id,
      ok: false,
      error: detail,
      fatal: detail.type === 'storage' && detail.code !== 'STORE_OWNERSHIP',
    };
  }
  port.postMessage(response);
  if (command.op === 'close') port.close();
});
