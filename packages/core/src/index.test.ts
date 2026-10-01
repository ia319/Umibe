import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execPath } from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { beforeAll, expect, test } from 'vitest';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const compilerPath = fileURLToPath(import.meta.resolve('typescript/bin/tsc'));

beforeAll(() => {
  execFileSync(execPath, [compilerPath, '-p', 'tsconfig.build.json'], {
    cwd: packageRoot,
    encoding: 'utf8',
    timeout: 15_000,
  });
}, 20_000);

test('loads the built ESM entry through the package export', () => {
  expect(() =>
    execFileSync(
      execPath,
      ['--input-type=module', '-e', "await import('@umibe/core');"],
      { cwd: packageRoot, encoding: 'utf8', timeout: 5_000 },
    ),
  ).not.toThrow();
});

test('prevents consumers from importing internal modules', () => {
  execFileSync(
    execPath,
    [
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict';
       await assert.rejects(import('@umibe/core/dist/contracts/json.js'), {
         code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
       });`,
    ],
    { cwd: packageRoot, encoding: 'utf8', timeout: 5_000 },
  );
});

test('emits declarations with resolvable dependencies', () => {
  const program = ts.createProgram([join(packageRoot, 'dist/index.d.ts')], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2023,
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    types: [],
  });

  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    );

  expect(diagnostics).toEqual([]);
  expect(
    program.getSourceFiles().map((file) => resolve(file.fileName)),
  ).toContain(join(packageRoot, 'dist/contracts/json.d.ts'));
});

test('excludes tests and fixtures from build output', () => {
  const files = readdirSync(join(packageRoot, 'dist'), {
    recursive: true,
    encoding: 'utf8',
  });

  expect(files).toContain('index.js');
  expect(files).toContain('index.d.ts');
  expect(files).not.toEqual(
    expect.arrayContaining([
      expect.stringMatching(
        /(^|[/\\])(?:tests?|__tests__|fixtures)([/\\]|$)|\.(?:test(?:-d)?|spec)\./,
      ),
    ]),
  );
});
