import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Node test workers need the source condition as well as transformed imports.
  ssr: {
    resolve: {
      conditions: ['umibe-source'],
    },
  },
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts'],
  },
});
