// What the scripted test executor and the board driver bring to each fixture
// ticket: a prepared change for every ticket expected to merge, the prepared
// findings for the investigated one (T11), and the owner's prepared answers.
//
// A prepared change is a transform of whatever tree the default branch holds
// when the PR is built, not a fixed patch, so a PR rebuilt after another one
// merged still applies. The transforms are written to touch separate regions
// of tally's code; the ones that cannot (T3 moves the counting code that T11
// and T13 edit) are reconciled by rebuilding the PR on the new default branch.
import type { TicketId, Tree } from "./fixture.ts";

/** One commit of a prepared change. */
export interface PreparedStep {
  /** The commit message's subject. */
  subject: string;
  apply(tree: Tree): void;
}

export interface PreparedChange {
  id: TicketId;
  /**
   * The commits the executor pushes, in order. A change with more than one
   * step pushes the next step only after entail's landing comment on the
   * previous head: T1's first step fails CI and the second fixes it.
   */
  steps: readonly PreparedStep[];
  /** One sentence for the PR description: what the change does. */
  summary: string;
  /**
   * Facts the evidence reports, each with words that select it for a
   * criterion whose text mentions any of them. A criterion no fact matches is
   * given every fact.
   */
  facts: readonly { keywords: readonly string[]; text: string }[];
}

export class PreparedChangeError extends Error {}

function edit(tree: Tree, path: string, change: (text: string) => string): void {
  const text = tree.get(path);
  if (text === undefined) throw new PreparedChangeError(`${path} is missing`);
  tree.set(path, change(text));
}

function replaceOnce(text: string, from: string, to: string, where: string): string {
  const at = text.indexOf(from);
  if (at < 0) throw new PreparedChangeError(`${where}: expected to find ${JSON.stringify(from)}`);
  return text.slice(0, at) + to + text.slice(at + from.length);
}

function addFile(tree: Tree, path: string, text: string): void {
  tree.set(path, text);
}

const TEST_PREAMBLE = `import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function tally(args, input) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input });
}

function file(text) {
  const path = join(mkdtempSync(join(tmpdir(), 'tally-')), 'input.txt');
  writeFileSync(path, text);
  return path;
}

function counts(stdout) {
  return stdout.trim().split(/ +/).slice(0, 3).map(Number);
}
`;

// T1 ------------------------------------------------------------------------

const STDIN_READ = "readFileSync(0, 'utf8')";

const T1: PreparedChange = {
  id: "T1",
  summary: "tally reads the text from standard input when it is given no file.",
  steps: [
    {
      subject: "Read from standard input when no file is given",
      apply(tree) {
        // Only what the issue asks: --help is left as it is (ADR-0014 merges only what was asked).
        // The first push trims the input, so the line count comes out wrong
        // and CI fails: the path where the executor's first PR fails (#28).
        edit(tree, "src/cli.js", (text) =>
          replaceOnce(
            text,
            "function readInputs(files) {\n",
            `function readInputs(files) {\n  if (files.length === 0) return [{ text: ${STDIN_READ}.trim() }];\n`,
            "T1 input",
          ),
        );
        addFile(
          tree,
          "test/stdin.test.js",
          `${TEST_PREAMBLE}
test('reads standard input when no file is given', () => {
  const result = tally([], 'one two three\\nfour five\\n');
  assert.equal(result.status, 0);
  assert.deepEqual(counts(result.stdout), [2, 5, 24]);
});

test('still reads the files it is given', () => {
  const result = tally([file('one two\\n')], 'ignored input\\n');
  assert.equal(result.status, 0);
  assert.deepEqual(counts(result.stdout), [1, 2, 8]);
});
`,
        );
      },
    },
    {
      subject: "Count standard input without trimming it",
      apply(tree) {
        edit(tree, "src/cli.js", (text) => replaceOnce(text, `${STDIN_READ}.trim()`, STDIN_READ, "T1 fix"));
      },
    },
  ],
  facts: [
    {
      keywords: ["standard input", "stdin", "no file", "pipe"],
      text: "test/stdin.test.js pipes `one two three\\nfour five\\n` into `tally` with no file arguments and checks it prints `2 5 24`",
    },
    {
      keywords: ["file", "given", "argument"],
      text: "test/stdin.test.js checks that a file given as an argument is still counted and standard input is then ignored",
    },
  ],
};

// T2 ------------------------------------------------------------------------

const T2: PreparedChange = {
  id: "T2",
  summary: "A missing file makes tally print an error naming the file to standard error and exit with status 1, instead of a stack trace.",
  steps: [
    {
      subject: "Print an error instead of a stack trace when a file is missing",
      apply(tree) {
        // Where tally crashed, it now prints the error and exits: nothing else changes.
        edit(tree, "src/cli.js", (text) =>
          replaceOnce(
            text,
            "function readFile(file) {\n  return readFileSync(file, 'utf8');\n}\n",
            `function readFile(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    process.stderr.write(\`tally: \${file}: no such file\\n\`);
    process.exit(1);
  }
}
`,
            "T2 read",
          ),
        );
        addFile(
          tree,
          "test/missing-file.test.js",
          `${TEST_PREAMBLE}
test('a missing file prints an error to standard error and exits non-zero', () => {
  const result = tally(['does-not-exist.txt']);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'tally: does-not-exist.txt: no such file\\n');
  assert.doesNotMatch(result.stderr, /\\bat /);
  assert.equal(result.stdout, '');
});

test('a readable file still prints the same line of counts', () => {
  const path = file('one two\\n');
  const result = tally([path]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, \`      1       2       8 \${path}\\n\`);
});
`,
        );
      },
    },
  ],
  facts: [
    {
      keywords: ["error", "stack", "missing", "exist", "standard error", "stderr"],
      text: "test/missing-file.test.js runs `tally does-not-exist.txt` and checks standard error is exactly `tally: does-not-exist.txt: no such file`, with no stack trace and nothing on standard output",
    },
    {
      keywords: ["status", "exit", "non-zero"],
      text: "test/missing-file.test.js checks the exit status is 1",
    },
    {
      keywords: ["format", "readable", "count line", "line of counts", "current", "unchanged", "as before", "plain text"],
      text: "test/missing-file.test.js checks that a readable file still prints exactly the line of counts it printed before, `      1       2       8 <file>`, and the diff leaves src/format.js untouched",
    },
  ],
};

// T3 ------------------------------------------------------------------------

const COUNT_BLOCK = /\/\/ Counting\n\n(function countText\(text\) \{\n[\s\S]*?\n\}\n)\n/;

const T3: PreparedChange = {
  id: "T3",
  summary: "The counting code moves from src/cli.js into src/count.js, with nothing tally prints changed.",
  steps: [
    {
      subject: "Move the counting code into its own module",
      apply(tree) {
        let moved = "";
        edit(tree, "src/cli.js", (text) => {
          const match = COUNT_BLOCK.exec(text);
          if (!match?.[1]) throw new PreparedChangeError("T3: the counting code is not in src/cli.js");
          moved = match[1];
          const without = text.replace(COUNT_BLOCK, "");
          return replaceOnce(
            without,
            "import { readFileSync } from 'node:fs';\n",
            "import { readFileSync } from 'node:fs';\nimport { countText } from './count.js';\n",
            "T3 import",
          );
        });
        addFile(
          tree,
          "src/count.js",
          `// Counting\n\n/** Counts the lines, words and characters in a text. */\nexport ${moved}`,
        );
        addFile(
          tree,
          "test/count.test.js",
          `import assert from 'node:assert/strict';
import { test } from 'node:test';

import { countText } from '../src/count.js';

test('counts lines, words and characters', () => {
  assert.deepEqual(countText('one two three\\nfour five\\n'), { lines: 2, words: 5, characters: 24 });
});

test('counts an empty text as zero', () => {
  assert.deepEqual(countText(''), { lines: 0, words: 0, characters: 0 });
});
`,
        );
      },
    },
  ],
  facts: [
    {
      keywords: ["module", "count", "own", "separate", "moved", "move"],
      text: "src/count.js now holds `countText`, src/cli.js imports it, and test/count.test.js tests it on its own",
    },
    {
      keywords: ["output", "print", "behaviour", "behavior", "unchanged", "same", "change"],
      text: "the existing test/tally.test.js, which checks the printed counts and the help text, passes unchanged",
    },
    {
      keywords: ["format", "vision", "fence", "leave", "touch"],
      text: "the diff changes only src/cli.js, src/count.js and test/count.test.js; src/format.js and VISION.md are untouched",
    },
  ],
};

// T5 ------------------------------------------------------------------------

const T5: PreparedChange = {
  id: "T5",
  summary: "tally shows the counts in colour when standard output is a terminal, and prints plain text when it is piped or redirected.",
  steps: [
    {
      subject: "Show the counts in colour in a terminal",
      apply(tree) {
        edit(tree, "src/cli.js", (text) =>
          replaceOnce(
            text,
            "function output(line) {\n  process.stdout.write(line + '\\n');\n}\n",
            `const COLOUR = '\\x1b[36m';
const RESET = '\\x1b[0m';

// Colour only the counts, and only in a terminal, so piped output stays plain text.
function output(line) {
  const counts = process.stdout.isTTY ? /^(?: *\\d+){3}/.exec(line) : null;
  const shown = counts ? COLOUR + counts[0] + RESET + line.slice(counts[0].length) : line;
  process.stdout.write(shown + '\\n');
}
`,
            "T5 output",
          ),
        );
        addFile(
          tree,
          "test/colour.test.js",
          `${TEST_PREAMBLE}
test('piped output is plain text with no colour codes', () => {
  const result = tally([file('one two\\n')]);
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /\\x1b/);
  assert.deepEqual(counts(result.stdout), [1, 2, 8]);
});

test('output to a terminal is in colour', (t) => {
  const probe = spawnSync('script', ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) return t.skip('no script(1) to give tally a terminal');
  const path = file('one two\\n');
  const result = spawnSync('script', ['-qec', \`"\${process.execPath}" "\${CLI}" "\${path}"\`, '/dev/null'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\\x1b\\[36m +1 +2 +8\\x1b\\[0m /);
});

test('no configuration file or environment setting turns colour on', () => {
  const home = mkdtempSync(join(tmpdir(), 'tally-home-'));
  writeFileSync(join(home, '.tallyrc'), '--colour\\n');
  const env = { ...process.env, HOME: home, FORCE_COLOR: '1', CLICOLOR_FORCE: '1' };
  const result = spawnSync(process.execPath, [CLI, file('one two\\n')], { encoding: 'utf8', cwd: home, env });
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /\\x1b/);
});
`,
        );
      },
    },
  ],
  facts: [
    {
      keywords: ["pipe", "piped", "plain", "redirect", "not a terminal", "parse"],
      text: "test/colour.test.js checks that output to a pipe has no colour escape codes and the counts are unchanged",
    },
    {
      keywords: ["colour", "color", "terminal", "tty"],
      text: "test/colour.test.js runs tally under script(1), so its output is a terminal, and checks the counts, and only the counts, are coloured",
    },
    {
      keywords: ["configuration", "config", "environment", "flag", "command-line", "setting"],
      text: "test/colour.test.js puts a `.tallyrc` in HOME and the working directory and sets FORCE_COLOR and CLICOLOR_FORCE, and checks piped output is still plain: colour depends only on whether standard output is a terminal, and tally still reads no configuration file",
    },
  ],
};

// T6 ------------------------------------------------------------------------

const T6: PreparedChange = {
  id: "T6",
  summary: "`--json` prints each input's counts as one JSON object per line instead of the plain columns.",
  steps: [
    {
      subject: "Add a --json flag",
      apply(tree) {
        edit(tree, "src/cli.js", (text) => {
          let next = replaceOnce(
            text,
            "import { formatCounts } from './format.js';\n",
            "import { formatCounts } from './format.js';\nimport { formatJson } from './json.js';\n",
            "T6 import",
          );
          next = replaceOnce(
            next,
            "      options.help = true;\n    } else {\n",
            "      options.help = true;\n    } else if (arg === '--json') {\n      options.json = true;\n    } else {\n",
            "T6 flag",
          );
          next = replaceOnce(
            next,
            "    output(formatCounts(countText(input.text), input.name));\n",
            "    const counts = countText(input.text);\n    output(options.json ? formatJson(counts) : formatCounts(counts, input.name));\n",
            "T6 main",
          );
          return next;
        });
        addFile(
          tree,
          "src/json.js",
          `/** Formats one input's counts as one JSON object on one line. */
export function formatJson(counts) {
  return JSON.stringify({ lines: counts.lines, words: counts.words, characters: counts.characters });
}
`,
        );
        addFile(
          tree,
          "test/json.test.js",
          `${TEST_PREAMBLE}
test('--json prints one JSON object per input, one per line', () => {
  const first = file('one two\\n');
  const second = file('three\\n');
  const result = tally(['--json', first, second]);
  assert.equal(result.status, 0);
  const lines = result.stdout.trimEnd().split('\\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { lines: 1, words: 2, characters: 8 });
  assert.deepEqual(JSON.parse(lines[1]), { lines: 1, words: 1, characters: 6 });
});

test('only --json turns JSON on, never a configuration file or the environment', () => {
  const home = mkdtempSync(join(tmpdir(), 'tally-home-'));
  writeFileSync(join(home, '.tallyrc'), '--json\\n');
  const env = { ...process.env, HOME: home, TALLY_JSON: '1', TALLY_OPTIONS: '--json' };
  const result = spawnSync(process.execPath, [CLI, file('one two\\n')], { encoding: 'utf8', cwd: home, env });
  assert.equal(result.status, 0);
  assert.deepEqual(counts(result.stdout), [1, 2, 8]);
});

test('with --json an error still goes to standard error and tally exits non-zero', () => {
  const result = tally(['--json', 'does-not-exist.txt']);
  assert.notEqual(result.status, 0);
  assert.notEqual(result.stderr, '');
  assert.equal(result.stdout, '');
});

test('without --json the output is unchanged', () => {
  const result = tally([file('one two\\n')]);
  assert.deepEqual(counts(result.stdout), [1, 2, 8]);
});
`,
        );
      },
    },
  ],
  facts: [
    {
      keywords: ["json", "object", "line", "per input", "parse"],
      text: "test/json.test.js runs `tally --json` on two files and checks it prints two lines, each one JSON object with that input's lines, words and characters",
    },
    {
      keywords: ["without", "default", "plain", "unchanged"],
      text: "test/json.test.js checks that without `--json` the plain output is unchanged",
    },
    {
      keywords: ["configuration", "config", "environment", "flag", "command-line", "setting"],
      text: "test/json.test.js puts `--json` in a `.tallyrc` in HOME and the working directory and in environment variables, and checks tally still prints plain counts: only the `--json` flag turns JSON on",
    },
    {
      keywords: ["error", "standard error", "stderr", "status", "non-zero", "exit"],
      text: "test/json.test.js runs `tally --json does-not-exist.txt` and checks the error goes to standard error, nothing goes to standard output and the exit status is non-zero",
    },
  ],
};

// T9 ------------------------------------------------------------------------

const T9: PreparedChange = {
  id: "T9",
  summary: "The variables in src/format.js get descriptive names; the exported `formatCounts` and the printed output are unchanged.",
  steps: [
    {
      subject: "Rename variables in src/format.js for readability",
      apply(tree) {
        edit(tree, "src/format.js", (text) =>
          replaceOnce(
            text,
            "export function formatCounts(c, n) {\n  const f = [c.lines, c.words, c.characters].map((x) => String(x).padStart(7));\n  if (n !== undefined) f.push(n);\n  return f.join(' ');\n}\n",
            "export function formatCounts(counts, name) {\n  const fields = [counts.lines, counts.words, counts.characters].map((count) => String(count).padStart(7));\n  if (name !== undefined) fields.push(name);\n  return fields.join(' ');\n}\n",
            "T9 rename",
          ),
        );
        addFile(
          tree,
          "test/format.test.js",
          `import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatCounts } from '../src/format.js';

test('formats the counts and the name as before', () => {
  assert.equal(formatCounts({ lines: 2, words: 5, characters: 24 }, 'notes.txt'), '      2       5      24 notes.txt');
});

test('formats the counts alone when there is no name', () => {
  assert.equal(formatCounts({ lines: 0, words: 0, characters: 0 }), '      0       0       0');
});
`,
        );
      },
    },
  ],
  facts: [
    {
      keywords: ["rename", "name", "variable", "readab"],
      text: "src/format.js renames `c`, `n`, `f` and `x` to `counts`, `name`, `fields` and `count`; nothing else in the file changes",
    },
    {
      keywords: ["export", "formatCounts"],
      text: "the exported function is still `formatCounts`, and test/format.test.js imports it by that name",
    },
    {
      keywords: ["output", "print", "unchanged", "same"],
      text: "test/format.test.js checks the exact formatted line, padding included, and test/tally.test.js passes unchanged",
    },
  ],
};

// T11 -----------------------------------------------------------------------

/** The word-splitting expression, in whatever form the default branch holds it. */
const WORD_SPLIT = /line\.split\([^\n]*?\)(?:\.filter\(Boolean\))?\.length/;
/** T11 alone: runs of ASCII whitespace; whether other Unicode whitespace separates words is T13's question. */
const ASCII_RUNS = "line.split(/[ \\t\\n\\r\\f\\v]+/).filter(Boolean).length";
/** T13 alone: any Unicode whitespace separates words, one character at a time as the space did. */
const UNICODE_SINGLE = "line.split(/\\p{White_Space}/u).length";
/** T11 and T13 together. */
const UNICODE_RUNS = "line.split(/\\p{White_Space}+/u).filter(Boolean).length";

/** Replaces the word-splitting expression under src/; throws when there is none. */
function replaceWordSplit(tree: Tree, id: TicketId, next: (current: string) => string): void {
  let found = false;
  for (const [path, text] of tree) {
    const match = path.startsWith("src/") ? WORD_SPLIT.exec(text) : null;
    if (!match) continue;
    tree.set(path, text.replace(WORD_SPLIT, next(match[0])));
    found = true;
  }
  if (!found) throw new PreparedChangeError(`${id}: the word-splitting code was not found under src/`);
}

const T11: PreparedChange = {
  id: "T11",
  summary: "Words are counted as runs of characters between whitespace, so a leading, doubled or trailing space no longer adds a word.",
  steps: [
    {
      subject: "Count a word as a run of characters between whitespace",
      apply(tree) {
        // Runs of whitespace, not single spaces: on Unicode whitespace once T13 has merged.
        replaceWordSplit(tree, "T11", (current) => (current.includes("White_Space") ? UNICODE_RUNS : ASCII_RUNS));
        addFile(
          tree,
          "test/words.test.js",
          `${TEST_PREAMBLE}
test('a leading space does not count as a word', () => {
  assert.deepEqual(counts(tally([file(' one two\\n')]).stdout), [1, 2, 9]);
});

test('doubled and trailing spaces do not count as words', () => {
  assert.deepEqual(counts(tally([file('one  two \\n')]).stdout), [1, 2, 10]);
});

test('a tab separates words', () => {
  assert.deepEqual(counts(tally([file('one\\ttwo\\n')]).stdout), [1, 2, 8]);
});
`,
        );
      },
    },
  ],
  facts: [
    {
      keywords: ["leading", "one too high", "extra", "space"],
      text: "test/words.test.js counts ` one two` as 2 words; before the change tally counted 3",
    },
    {
      keywords: ["whitespace", "run", "doubled", "trailing", "tab"],
      text: "test/words.test.js checks that doubled and trailing spaces add no word and that a tab separates words",
    },
    {
      keywords: ["unicode", "non-breaking", "other whitespace", "whitespace character"],
      text: "words are split on runs of ASCII whitespace (space, tab, line feed, carriage return, vertical tab, form feed); which other Unicode characters separate words is not changed here",
    },
  ],
};

// T13 -----------------------------------------------------------------------

const T13: PreparedChange = {
  id: "T13",
  summary: "Any Unicode whitespace, including a non-breaking space, separates words.",
  steps: [
    {
      subject: "Separate words on any Unicode whitespace",
      apply(tree) {
        // \p{White_Space}, not \s: \s also matches U+FEFF, which is not whitespace. Only which
        // characters separate words changes: runs stay as they were until T11 merges.
        replaceWordSplit(tree, "T13", (current) => (current.includes("filter(Boolean)") ? UNICODE_RUNS : UNICODE_SINGLE));
        addFile(
          tree,
          "test/unicode-whitespace.test.js",
          `${TEST_PREAMBLE}
test('a non-breaking space separates words', () => {
  assert.deepEqual(counts(tally([file('one\\u00a0two\\n')]).stdout), [1, 2, 8]);
});

test('other Unicode whitespace separates words', () => {
  assert.deepEqual(counts(tally([file('one\\u2003two\\u3000three\\n')]).stdout), [1, 3, 14]);
});
`,
        );
      },
    },
  ],
  facts: [
    {
      keywords: ["non-breaking", "nbsp", "u+00a0", "no-break"],
      text: "test/unicode-whitespace.test.js counts `one\\u00a0two` as 2 words; before the change tally counted 1",
    },
    {
      keywords: ["unicode", "whitespace", "any", "other tools"],
      text: "test/unicode-whitespace.test.js checks that an em space (U+2003) and an ideographic space (U+3000) separate words too",
    },
    {
      keywords: ["only", "ascii", "unchanged", "same", "run", "between whitespace", "u+feff", "byte-order"],
      text: "only which characters separate words changes: the split uses Unicode's White_Space property (not `\\s`, which would also match U+FEFF), and runs of spaces count as they did before",
    },
  ],
};

/** The prepared change for every ticket expected to merge. */
export const PREPARED_CHANGES: ReadonlyMap<TicketId, PreparedChange> = new Map(
  [T1, T2, T3, T5, T6, T9, T11, T13].map((change) => [change.id, change]),
);

/** Applies a change's first `steps` steps to a copy of the tree. */
export function applyPrepared(tree: Tree, change: PreparedChange, steps = change.steps.length): Tree {
  const next: Tree = new Map(tree);
  for (const step of change.steps.slice(0, steps)) step.apply(next);
  return next;
}

/**
 * The findings the executor posts for each investigated ticket, given for
 * every question id the intake comment lists (#28: T11's findings are "a
 * leading space counts as a word").
 */
export const PREPARED_FINDINGS: ReadonlyMap<TicketId, string> = new Map([
  [
    "T11",
    "Reproduced: a leading space counts as a word. A file holding the line ` one two` is counted as 3 words instead of 2. src/cli.js splits each line on a single space character, so a leading space yields an empty first word; a doubled or trailing space adds a word the same way.",
  ],
]);

/** What the board driver answers on a board item. */
export type PreparedAnswer =
  | { shape: "own words"; text: string }
  | { shape: "don't go ahead" }
  | { shape: "option"; label: string; fallback: string };

/**
 * The owner's answers (#28, as amended under ADR-0011). T8 is left
 * unanswered on purpose. T10 expects no board item, so an item for it is
 * left unanswered too: it is reported as an extra board item.
 */
export const EXPECTED_ANSWERS: ReadonlyMap<TicketId, PreparedAnswer> = new Map<TicketId, PreparedAnswer>([
  ["T7", { shape: "don't go ahead" }],
  ["T9", { shape: "own words", text: "Rename only; keep every exported name and the printed output unchanged." }],
  ["T13", { shape: "own words", text: "Any Unicode whitespace separates words, including a non-breaking space." }],
]);

/**
 * Answers for board items the outcomes table does not expect, on tickets
 * expected to merge. They keep the ticket on its way to merged, so a run with
 * an extra question differs only by that question (ADR-0010); every one used
 * is reported as an extra board item.
 */
export const EXTRA_ANSWERS: ReadonlyMap<TicketId, PreparedAnswer> = new Map<TicketId, PreparedAnswer>([
  ["T1", { shape: "option", label: "Go ahead as read", fallback: "Read standard input when no file is given, and count it like a file." }],
  ["T2", { shape: "own words", text: "Print an error naming the missing file to standard error, then exit with a non-zero status." }],
  ["T3", { shape: "own words", text: "Move the counting code into its own module without changing anything tally prints." }],
  ["T5", { shape: "own words", text: "Colour the counts only when the output is a terminal; print plain text when it is piped." }],
  ["T6", { shape: "own words", text: "Print one JSON object per input, one per line." }],
  ["T11", { shape: "option", label: "Go ahead as read", fallback: "A word is a run of characters between whitespace; a leading space is not a word." }],
]);

/** The answer for an item raised at landing because a PR touched a pin. */
export const LANDING_PIN_ANSWER = { shape: "option", label: "Merge this PR as it is" } as const;
