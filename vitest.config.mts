import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@umibe\/core\/model$/,
        replacement: fileURLToPath(
          new URL('./packages/core/src/model/index.ts', import.meta.url),
        ),
      },
      {
        find: '@umibe/core/storage-adapter',
        replacement: fileURLToPath(
          new URL('./packages/core/src/storage/adapter.ts', import.meta.url),
        ),
      },
      {
        find: '@umibe/core',
        replacement: fileURLToPath(
          new URL('./packages/core/src/index.ts', import.meta.url),
        ),
      },
    ],
  },
  // Node test workers need the source condition as well as transformed imports.
  ssr: {
    resolve: {
      conditions: ['umibe-source'],
    },
  },
  test: {
    environment: 'node',
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/providers/*/src/**/*.test.ts',
    ],
  },
});
