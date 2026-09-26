import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { ESLint } from 'eslint';
import * as prettier from 'prettier';

const mode = process.argv[2];
if (mode !== 'lint' && mode !== 'format' && mode !== 'format:check') {
  throw new Error('Use lint, format, or format:check.');
}

// Include new source files while respecting repository-local exclusions.
const files = [
  ...new Set(
    execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { encoding: 'utf8' },
    )
      .split('\0')
      .filter(Boolean),
  ),
].filter((file) => lstatSync(file, { throwIfNoEntry: false })?.isFile());

if (mode === 'lint') {
  const eslint = new ESLint();
  const results = await eslint.lintFiles(
    files.filter((file) => /\.[cm]?[jt]sx?$/u.test(file)),
  );
  const formatter = await eslint.loadFormatter('stylish');
  process.stdout.write(await formatter.format(results));
  process.exitCode = results.some(
    (result) => result.errorCount > 0 || result.warningCount > 0,
  )
    ? 1
    : 0;
} else {
  let changed = 0;
  for (const file of files) {
    const info = await prettier.getFileInfo(file, {
      ignorePath: '.prettierignore',
    });
    if (info.ignored || info.inferredParser === null) continue;

    const content = await readFile(file, 'utf8');
    const options = await prettier.resolveConfig(file, { editorconfig: true });
    const formatted = await prettier.format(content, {
      ...options,
      filepath: file,
    });
    if (content === formatted) continue;

    changed += 1;
    if (mode === 'format') {
      await writeFile(file, formatted, 'utf8');
      console.log(`Formatted: ${file}`);
    } else {
      console.error(`Needs formatting: ${file}`);
    }
  }
  process.exitCode = mode === 'format:check' && changed > 0 ? 1 : 0;
  if (changed === 0) console.log('Formatting checks passed.');
}
