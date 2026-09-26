# Umibe

Umibe is a TypeScript project for goal-driven agents, combining LLM planning
with replaceable action selection, including JEV. The SDK implementation is
pending; this repository provides the development tooling.

## Set up

Use Node.js 24 and pnpm 12.5.1. With Corepack installed, run:

```sh
corepack install --global pnpm@12.5.1
pnpm install --frozen-lockfile
```

The root package is private. Add workspace packages when their implementation
begins, and register them in `pnpm-workspace.yaml`.

Direct development dependencies use exact versions. Installation enforces a
seven-day minimum release age for registry dependencies, including transitive
dependencies and packages in the lockfile. Missing publication dates fail
installation. Commit `pnpm-lock.yaml` alongside dependency changes.

## Run checks

| Command             | Purpose                                          |
| ------------------- | ------------------------------------------------ |
| `pnpm check`        | Run lint, formatting checks, and type checks     |
| `pnpm lint`         | Run ESLint with TypeScript type information      |
| `pnpm format:check` | Check formatting without writing files           |
| `pnpm format`       | Apply Prettier formatting                        |
| `pnpm typecheck`    | Check the root configuration and tooling scripts |
| `pnpm test`         | Run Vitest once                                  |
| `pnpm test:watch`   | Run Vitest in watch mode                         |

Lint and formatting select tracked and untracked, non-ignored files through
Git. Put repository-local material in `.git/info/exclude`; these commands
respect that file without sharing local paths in the public configuration.
Generated build output, coverage, and the lockfile are excluded from formatting.

Vitest uses the Node environment and discovers `scripts/**/*.test.mjs`.
There are no test cases yet, so `pnpm test` reports no test files and exits
unsuccessfully. Add real tests and extend the discovery configuration as
modules are implemented. `pnpm check` covers tooling and does not imply
that SDK tests have passed.

Write text files as UTF-8 without a BOM. `.gitattributes` enforces LF line
endings for text files, and `.editorconfig` applies the same convention in
editors.
