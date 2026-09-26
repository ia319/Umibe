import js from '@eslint/js';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, globalIgnores, includeIgnoreFile } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import tseslint from 'typescript-eslint';

// Worktrees can store local exclusions outside the checkout directory.
const localExclude = execFileSync(
  'git',
  ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'],
  { cwd: import.meta.dirname, encoding: 'utf8' },
).trim();
const ignoreFiles = [
  localExclude,
  fileURLToPath(new URL('.gitignore', import.meta.url)),
].filter((file) => existsSync(file));

export default defineConfig(
  includeIgnoreFile(ignoreFiles),
  globalIgnores(['**/node_modules/**', '**/dist/**', '**/coverage/**']),
  {
    files: ['**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
    ],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  prettier,
);
