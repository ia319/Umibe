import { MemoryRunStore } from './memory.js';
import { runStoreContract } from './__tests__/run-store-contract.js';

runStoreContract('MemoryRunStore', () => Promise.resolve(new MemoryRunStore()));
