import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function tally(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

test('--help prints the usage', () => {
  const result = tally(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Usage: tally/);
});

test('counts the lines, words and characters of a file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tally-'));
  const file = join(dir, 'notes.txt');
  writeFileSync(file, 'one two three\nfour five\n');
  const result = tally([file]);
  assert.equal(result.status, 0);
  assert.deepEqual(result.stdout.trim().split(/ +/), ['2', '5', '24', file]);
});
