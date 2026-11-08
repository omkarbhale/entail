// The acceptance test's fixture: the made-up product `tally`, its starting
// tree, the settings it is enrolled with and the issues T1–T13, as recorded on
// the map's acceptance ticket (#28) and amended under ADR-0011 (ADR-0010).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The directory holding tally's starting tree, file for file. */
export const FIXTURE_DIRECTORY = fileURLToPath(new URL("./fixture/tally/", import.meta.url));

/**
 * Words every fixture repo's description carries. The reset refuses a repo
 * without them, so it can never touch entail's own repo or any other.
 */
export const FIXTURE_MARKER = "entail acceptance fixture";

export const FIXTURE_DESCRIPTION = `tally, a word-count command-line tool: the ${FIXTURE_MARKER}. The harness resets it.`;

/** The default name of each fixture repo, under the logged-in account. */
export const FIXTURE_REPO_NAME = "entail-fixture-tally";

export const DEFAULT_BRANCH = "main";

/** A repo tree: each tracked file's path (with `/`) and its contents. */
export type Tree = Map<string, string>;

/** Files committed with the executable bit. */
export const EXECUTABLE_FILES: ReadonlySet<string> = new Set(["src/cli.js"]);

/** Reads tally's starting tree from {@link FIXTURE_DIRECTORY}. */
export function startingTree(): Tree {
  const tree: Tree = new Map();
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else {
        tree.set(relative(FIXTURE_DIRECTORY, path).split(sep).join("/"), readFileSync(path, "utf8"));
      }
    }
  };
  walk(FIXTURE_DIRECTORY);
  return tree;
}

/**
 * The starting commit is built with a fixed identity, date and message, so
 * every reset produces the same commit sha and a second reset pushes nothing.
 */
export const STARTING_COMMIT = {
  message: "Start tally\n\nThe starting state of the entail acceptance fixture.\n",
  name: "entail acceptance harness",
  email: "entail-acceptance@users.noreply.github.com",
  date: "2026-11-08T00:00:00Z",
} as const;

/**
 * The repo settings the acceptance test enrolls each fixture repo with
 * (MVP-1 spec, Testing Decisions: Settings). The harness records them; the
 * acceptance run (#110) enters them on the Repos page.
 */
export const FIXTURE_SETTINGS = {
  genericCriteria: [{ sentence: "The CI job `test` passes.", check: { kind: "check passes", name: "test" } }],
  pins: [{ topic: "the output format", paths: ["src/format.js"] }],
  shadow: false,
  visionOrigin: "owner-stated",
  noticeConnector: "file",
} as const;

/** The ids of the fixture's tickets. T4 was cut and T12 dropped (#28). */
export type TicketId = "T1" | "T2" | "T3" | "T5" | "T6" | "T7" | "T8" | "T9" | "T10" | "T11" | "T13";

/** How a ticket is expected to end (MVP-1 spec, Expected outcomes). */
export type ExpectedEnd = "merged" | "cancelled" | "on the board" | "declined";

export interface FixtureIssue {
  id: TicketId;
  title: string;
  body: string;
  /** The expected path, in the words of the spec's outcomes table. */
  expectedPath: string;
  expectedEnd: ExpectedEnd;
}

/**
 * Issues T1–T13, filed under the owner's login in this order. Titles are the
 * recorded ones; bodies are written as the owner would file them, and choose
 * nothing the outcomes table leaves to entail or to the owner's answer.
 */
export const FIXTURE_ISSUES: readonly FixtureIssue[] = [
  {
    id: "T1",
    title: "Read from standard input when no file is given",
    body: "Running `tally` with no file arguments prints nothing. When no file is given it should read the text from standard input, so it can sit at the end of a pipe, for example `cat notes.txt | tally`.",
    expectedPath:
      'settled, citing "tally reads plain text from the files it is given, or from standard input when it is given none."; the first PR fails CI and gets a comment naming the unmet check; the fix merges',
    expectedEnd: "merged",
  },
  {
    id: "T2",
    title: "Print an error instead of a stack trace when a file is missing",
    body: "`tally missing.txt` crashes with a Node stack trace when the file does not exist. It should print a short error naming the file instead.",
    expectedPath: "settled, citing the errors line (unopposed is also acceptable)",
    expectedEnd: "merged",
  },
  {
    id: "T3",
    title: "Move the counting code into its own module",
    body: "The code that counts lines, words and characters lives inside `src/cli.js`. Move it into its own module so it can be tested on its own. Nothing tally prints should change.",
    expectedPath: "unopposed, fenced off `src/format.js` and VISION.md",
    expectedEnd: "merged",
  },
  {
    id: "T5",
    title: "Show the counts in colour",
    body: "The counts would be easier to read at a glance if tally showed them in colour.",
    expectedPath: "cleared (settled or unopposed); criteria require plain output when piped",
    expectedEnd: "merged",
  },
  {
    id: "T6",
    title: "Add a `--json` flag",
    body: "Add a `--json` flag that prints the counts as JSON, so scripts can read them without parsing columns.",
    expectedPath: "cleared (settled or unopposed); criteria state one JSON object per input, one per line",
    expectedEnd: "merged",
  },
  {
    id: "T7",
    title: "Count the words of a web page given its URL",
    body: "Let me pass a URL instead of a file name, for example `tally https://example.com/post`, and have tally fetch the page and count its words.",
    expectedPath: 'needs the owner (contradicts "tally never reaches the network."); answered "don\'t go ahead"',
    expectedEnd: "cancelled",
  },
  {
    id: "T8",
    title: "Read default flags from `~/.tallyrc`",
    body: "I pass the same flags every time. tally should read default flags from a `~/.tallyrc` file in my home directory, with flags on the command line taking precedence.",
    expectedPath: "needs the owner (contradicts the configuration line); left unanswered",
    expectedEnd: "on the board",
  },
  {
    id: "T9",
    title: "Rename variables in `src/format.js` for readability",
    body: "`src/format.js` uses one-letter variable names (`c`, `n`, `f`, `x`) that make it hard to follow. Rename them to descriptive names.",
    expectedPath:
      'needs the owner (pin); answered "Rename only; keep every exported name and the printed output unchanged."; criteria cite the answer',
    expectedEnd: "merged",
  },
  {
    id: "T10",
    title: "Rewrite tally as a desktop app with a plugin system",
    body: "Turn tally into a desktop application with a window where text can be pasted or dropped, and a plugin system so others can add new kinds of counts and new export formats.",
    expectedPath: "declined, with a logged reason and an issue comment, and no board item",
    expectedEnd: "declined",
  },
  {
    id: "T11",
    title: "Word counts are sometimes one too high",
    body: "Sometimes the word count tally prints is one higher than the number of words I can see. I have not worked out when it happens.",
    expectedPath:
      'investigating; findings "a leading space counts as a word"; then settled, citing "A word is a run of characters between whitespace."',
    expectedEnd: "merged",
  },
  {
    id: "T13",
    title: "Word counts differ from other tools on text with non-breaking spaces",
    body: "On text that contains non-breaking spaces, the word count tally prints is different from what other word-count tools print for the same text.",
    expectedPath:
      'needs the owner (consequential readings); answered "Any Unicode whitespace separates words, including a non-breaking space."; criteria cite the answer',
    expectedEnd: "merged",
  },
];

/** Finds the fixture issue a forge issue is, by its exact title. */
export function fixtureIssueByTitle(title: string): FixtureIssue | undefined {
  return FIXTURE_ISSUES.find((issue) => issue.title === title.trim());
}
