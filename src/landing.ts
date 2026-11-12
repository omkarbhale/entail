import { matchesGlob } from "node:path";
import { issueTitle, type ForgeFacts, type LandingCase, type LandingCriterion } from "./case-book.ts";
import { allChecksPassed, requiredChecksReported, type ChangedFile } from "./forge/forge.ts";
import type { RestsOn } from "./judgment.ts";
import { DEFAULT_MODEL, type Effort, type MachineFailure, type ModelRunner, type RunFacts, type RunOptions } from "./model-runner.ts";
import { arrayOf, boolean, nullable, object, oneOf, string, type Infer } from "./schema.ts";

/**
 * The call on a PR: one model run that answers the owner's question, "does
 * this PR solve its issue's problem, meet its criteria and leave the product
 * better?", with merge, send back or ask. The prompt below is the whole of
 * how entail judges a PR; the code here builds it, parses the answer, checks
 * that the answer agrees with itself, and applies the two mechanical rules no
 * model decides: a PR whose CI is not green at the judged head is never
 * merged, and a PR that changes VISION.md or a pinned path is merged only on
 * the owner's answer.
 */

/** What a run of the landing judgment is called, for the runner and its records. */
export const LANDING_KIND = "pr-call";

/** Changes whenever the prompt or the answer's shape changes, so a call records what judged it. */
export const LANDING_PROMPT_VERSION = "pr-call-1";

/** How anything a PR does beyond its criteria is sorted; only unwanted sends a PR back. */
export const BEYOND_SORTS = ["needed", "harmless", "unwanted"] as const;

export type BeyondSort = (typeof BEYOND_SORTS)[number];

/** The answer the model gives, as JSON. */
export const LANDING_SCHEMA = object({
  call: oneOf(
    ["merge", "send-back", "ask"],
    "merge: it solves the problem, meets every criterion, CI is green and nothing it does is unwanted; send-back: something must change before it can merge; ask: you cannot tell, or it makes a large or hard-to-undo change the issue did not approve.",
  ),
  reason: string("Why, in plain words, in one to three sentences, for the owner to read."),
  solves: object(
    {
      solved: boolean("Whether the PR solves the problem the issue describes."),
      evidence: string("What in the diff or the repo at the PR's head shows it, naming files or code."),
    },
    "Whether the PR solves the issue's problem, which is always required.",
  ),
  criteria: arrayOf(
    object({
      criterion: string("The criterion, as given."),
      met: boolean("Whether the PR meets it."),
      evidence: string("What in the diff, the repo at the PR's head or the forge's facts you relied on, naming files or code; for unmet, what is missing."),
    }),
    "One entry per criterion given, in the order given; empty when none was given.",
  ),
  beyond: arrayOf(
    object({
      change: string("What the PR does that no criterion and not the problem itself names, in one sentence a user or maintainer would recognise."),
      sort: oneOf(BEYOND_SORTS, "needed, harmless or unwanted, as defined in the instructions."),
      why: string("Why it is sorted so: for needed, what it is needed for; for unwanted, how it makes the product worse or what the owner did not ask for."),
    }),
    "Each thing the PR does beyond solving the problem and meeting the criteria that is worth the owner's notice. Empty when there is none.",
  ),
  needs_to_change: arrayOf(
    string("One thing the PR must change before it can merge, as an instruction to its author."),
    "For send-back: what must change, one item per change. Empty for merge and ask.",
  ),
  product_call: boolean(
    "For send-back: true when what blocks the PR is a product question the owner must settle (the criteria conflict, or the issue's approach itself is in doubt), rather than work the PR has not yet done right. False otherwise.",
  ),
  question: nullable(
    object({
      question: string("The one question for the owner, answerable without reading anything else."),
      why: string("What makes it a question."),
    }),
    "For ask, and for a send-back that is a product call: the one question for the owner. Null otherwise.",
  ),
  rests_on: object(
    {
      vision_lines: arrayOf(string(), "Each vision line the call rests on, quoted exactly as it stands in the vision; empty when none."),
      cases: arrayOf(string(), "The slug of each past case the call rests on; empty when none does."),
    },
    "What the call rests on.",
  ),
});

export type LandingAnswer = Infer<typeof LANDING_SCHEMA>;

export type CriterionCheck = LandingAnswer["criteria"][number];

export type BeyondItem = LandingAnswer["beyond"][number];

/** A rule the code applied over the model's call, and why. */
export interface Guard {
  /** ci: CI was not green at the judged head; vision: the PR changes VISION.md; pins: it changes a pinned path. */
  rule: "ci" | "vision" | "pins";
  /** The model's call before the rule applied. */
  from: "merge";
  detail: string;
}

/** The call on a PR as routed: what entail does with it. */
export interface LandingCall {
  call: "merge" | "send-back" | "ask";
  reason: string;
  restsOn: RestsOn;
  solves: { solved: boolean; evidence: string };
  criteria: CriterionCheck[];
  beyond: BeyondItem[];
  needsToChange: string[];
  /** For a send-back: whether what blocks the PR is a product question for the owner. */
  productCall: boolean;
  question: { question: string; why: string } | null;
  /** Set when a mechanical rule changed the model's call. */
  guard: Guard | null;
}

/** Whether the forge's facts say CI is green: every check at the head passed and every required check reported. */
export function ciGreen(facts: Pick<ForgeFacts, "checks" | "required">): boolean {
  return allChecksPassed({ sha: "", checks: facts.checks, required: facts.required }) && requiredChecksReported({ sha: "", checks: facts.checks, required: facts.required });
}

/** What keeps CI from being green, one line per check, or none. */
export function ciProblems(facts: Pick<ForgeFacts, "checks" | "required">): string[] {
  const problems = facts.checks.filter((check) => check.status !== "passed").map((check) => `the check \`${check.name}\` ${check.status === "failed" ? "failed" : "has not finished"}`);
  for (const required of facts.required) if (!required.reported) problems.push(`the required check \`${required.name}\` has not reported`);
  return problems;
}

/**
 * The pins that name paths: a pin with no spaces that holds a `/`, a `.` or a
 * `*`, such as `src/billing/`, `schema.sql` or `migrations/**`. Other pins are
 * topics, which only the model can weigh.
 */
export function pinnedPaths(pins: readonly string[]): string[] {
  return pins.map((pin) => pin.trim().replace(/^`|`$/gu, "")).filter((pin) => pin !== "" && !/\s/u.test(pin) && /[/.*]/u.test(pin));
}

/** Whether a changed path falls under a pinned path: the path itself, a directory holding it, or a glob matching it. */
export function underPin(path: string, pin: string): boolean {
  const bare = pin.replace(/^\.\//u, "").replace(/\/+$/u, "");
  if (bare === "") return false;
  if (path === bare || path.startsWith(`${bare}/`)) return true;
  return /[*?[]/u.test(bare) && matchesGlob(path, bare);
}

/** What a PR's changed files touch that only the owner can let merge: VISION.md, and each pinned path. */
export function touched(files: readonly ChangedFile[], pins: readonly string[]): { vision: boolean; pins: string[] } {
  const paths = files.flatMap((file) => (file.previousPath === null ? [file.path] : [file.path, file.previousPath]));
  return {
    vision: paths.some((path) => path === "VISION.md"),
    pins: pinnedPaths(pins).filter((pin) => paths.some((path) => underPin(path, pin))),
  };
}

/**
 * Routes the model's answer. The answer must agree with itself: a merge marks
 * the problem solved, every criterion met and nothing unwanted; a send-back
 * names what must change, and has a reason to: the problem unsolved, a
 * criterion unmet, something unwanted, or CI not green. A send-back of a PR
 * that meets everything with nothing unwanted is refused as an answer, since
 * nothing else sends a PR back. Then the mechanical rules apply to a merge:
 * CI not green sends it back with the failing checks; VISION.md or a pinned
 * path changed makes it a question for the owner.
 */
export function routeLanding(
  answer: LandingAnswer,
  given: { criteria: readonly LandingCriterion[]; facts: ForgeFacts; touched: { vision: boolean; pins: string[] } },
): { ok: true; call: LandingCall } | { ok: false; problem: string } {
  if (answer.criteria.length !== given.criteria.length) {
    return { ok: false, problem: `the answer marks ${answer.criteria.length} criteria, but ${given.criteria.length} were given` };
  }
  const unmet = answer.criteria.filter((check) => !check.met);
  const unwanted = answer.beyond.filter((item) => item.sort === "unwanted");
  const green = ciGreen(given.facts);
  const blocking = [
    ...(answer.solves.solved ? [] : ["the problem unsolved"]),
    ...(unmet.length > 0 ? [`${unmet.length} criteria unmet`] : []),
    ...(unwanted.length > 0 ? [`${unwanted.length} unwanted changes`] : []),
  ];
  const call: LandingCall = {
    call: answer.call,
    reason: answer.reason,
    restsOn: { visionLines: answer.rests_on.vision_lines, cases: answer.rests_on.cases },
    solves: answer.solves,
    criteria: answer.criteria,
    beyond: answer.beyond,
    needsToChange: answer.call === "send-back" ? answer.needs_to_change.filter((item) => item.trim() !== "") : [],
    productCall: answer.call === "send-back" && answer.product_call,
    question: answer.question === null || answer.question.question.trim() === "" ? null : answer.question,
    guard: null,
  };
  if (answer.call === "merge" && blocking.length > 0) return { ok: false, problem: `the answer is merge but marks ${blocking.join(", ")}` };
  if (answer.call === "send-back") {
    if (blocking.length === 0 && green) return { ok: false, problem: "the answer is send-back, but the problem is solved, every criterion met, nothing unwanted and CI green" };
    if (call.needsToChange.length === 0) return { ok: false, problem: "the answer is send-back but names nothing to change" };
    if (call.productCall && call.question === null) return { ok: false, problem: "the send-back is a product call but carries no question" };
  }
  if (answer.call === "ask" && call.question === null) return { ok: false, problem: "the answer is ask but carries no question" };

  if (call.call === "merge" && !green) {
    const problems = ciProblems(given.facts);
    return {
      ok: true,
      call: { ...call, call: "send-back", needsToChange: problems.map((problem) => `Make CI green: ${problem}.`), productCall: false, question: null, guard: { rule: "ci", from: "merge", detail: problems.join("; ") } },
    };
  }
  if (call.call === "merge" && (given.touched.vision || given.touched.pins.length > 0)) {
    const what = [...(given.touched.vision ? ["VISION.md"] : []), ...given.touched.pins.map((pin) => `the pinned path \`${pin}\``)];
    const rule = given.touched.vision ? "vision" : "pins";
    return {
      ok: true,
      call: {
        ...call,
        call: "ask",
        question: { question: `This PR changes ${what.join(" and ")}. Merge it?`, why: "Only the owner lets a change to the vision or a pinned path merge; entail would otherwise merge it." },
        guard: { rule, from: "merge", detail: `the PR changes ${what.join(" and ")}` },
      },
    };
  }
  return { ok: true, call };
}

/** One earlier send-back of the same PR, for the judgment to read. */
export interface EarlierSendBack {
  head: string;
  needsToChange: string[];
}

/** Everything the landing judgment reads about one PR. */
export interface LandingInputs {
  /** The repo, as `owner/name`. */
  repo: string;
  pr: { number: number; text: string };
  /** The PR's head commit being judged. */
  head: string;
  /** The default branch's commit the diff is taken against. */
  base: string;
  issue: { number: number; text: string };
  /** The criteria entail set at intake. */
  criteria: LandingCriterion[];
  vision: { text: string; commit: string } | null;
  pins: string[];
  facts: ForgeFacts;
  /** The PR's diff against the base, from git. */
  diff: string;
  precedents: LandingCase[];
  /** Earlier send-backs of this PR, oldest first. */
  sendBacks: EarlierSendBack[];
  /** A read-only checkout of the PR's head. */
  checkout: string;
}

/** How much of a diff goes into the prompt; the rest is read in the checkout. */
export const DIFF_LIMIT = 120_000;

/** The landing judgment's prompt. */
export function landingPrompt(inputs: LandingInputs): string {
  const name = `${inputs.repo}#${inputs.pr.number}`;
  const issueName = `${inputs.repo}#${inputs.issue.number}`;
  const vision =
    inputs.vision === null
      ? "This repo has no VISION.md. Judge on the merits alone."
      : `VISION.md on the default branch at ${inputs.vision.commit}:\n\n<vision>\n${inputs.vision.text.trim()}\n</vision>`;
  const pins =
    inputs.pins.length === 0
      ? "The owner has pinned no topics for this repo."
      : `The owner pinned these topics for this repo; a change to a pinned topic the issue did not approve is the owner's to make:\n\n${inputs.pins.map((pin) => `- ${pin}`).join("\n")}`;
  const criteria =
    inputs.criteria.length === 0
      ? "entail set no criteria for this issue beyond solving its problem. Answer with an empty criteria list."
      : inputs.criteria.map((c, index) => `${index + 1}. ${c.criterion}${c.basis.trim() === "" ? "" : `\n   (Basis: ${c.basis.trim()})`}`).join("\n");
  const precedents = inputs.precedents.length === 0 ? "There are no past landing cases yet." : inputs.precedents.map(landingPrecedent).join("\n\n");
  const sendBacks =
    inputs.sendBacks.length === 0
      ? ""
      : `\n\n## Earlier send-backs of this PR\n\nentail sent this PR back ${inputs.sendBacks.length} time${inputs.sendBacks.length === 1 ? "" : "s"} before:\n\n${inputs.sendBacks
          .map((back) => `At ${back.head}:\n${back.needsToChange.map((item) => `- ${item}`).join("\n")}`)
          .join("\n\n")}`;
  const diff = inputs.diff.length <= DIFF_LIMIT ? inputs.diff : `${inputs.diff.slice(0, DIFF_LIMIT)}\n[…the diff is cut here; read the rest in the checkout]`;

  return `You are making the owner's landing call on ${name}, a pull request that closes ${issueName}.

The question is the owner's: does this PR solve the problem the issue describes, meet the criteria entail set for it, and leave the product better? If it does, it should be merged.

Answer merge, send-back or ask.

- **merge**: it solves the problem, meets every criterion, CI is green, and nothing it does is unwanted. It is merged at ${inputs.head} without the owner.
- **send-back**: something must change before it can merge. Your list of what must change is posted on the PR for its author; entail never changes the PR itself.
- **ask**: you cannot tell whether merging leaves the product better, or the PR makes a large or hard-to-undo change the issue did not approve. The owner gets one question.

## How to judge

Judge substance, not wording. Read the diff and, where it helps, the repo at the PR's head; the checkout you are in is that head. The PR's description is its author's account and proves nothing: CI results and changed files come from the forge, below, and whether the work is right comes from the code.

1. **The problem.** Does the PR solve the problem the issue describes? Say what shows it.
2. **The criteria.** Mark each criterion met or unmet, in the order given, with the evidence you relied on. A criterion is met when the PR does what it asks; it does not have to use the criterion's words.
3. **Beyond the criteria.** List what the PR does that neither the problem nor a criterion names and that is worth the owner's notice, and sort each:
   - **needed**: it follows from solving the problem or meeting a criterion; the job could not be done well without it. A client-rendered app shows a loading message while it starts and a note when JavaScript is off; a page rebuilt as an app has its data served as JSON; a moved endpoint follows from the new design; a new button gets a hover style; tests, docs and build changes that go with the change. These are part of the job, never beyond it.
   - **harmless**: not needed, but it does not make the product worse and the owner would not mind: a small tidy-up, a clearer message, a refactor nearby.
   - **unwanted**: it makes the product worse, goes against the vision, or is a separate change the owner did not ask for and would want to decide on: an extra feature, an unrelated change to how something works, a change to a pinned topic, removing something users rely on that the issue did not ask to remove.
   Leave out what is too small to notice. When unsure between needed and harmless, either is fine: neither sends the PR back.
4. **The call.** Merge when the problem is solved, every criterion met, CI green and nothing unwanted. Send back when the problem is not solved, a criterion is unmet, CI is not green, or something is unwanted, and say exactly what must change. Only those send a PR back: never send back a PR for what is needed or harmless, for style, or for doing more than the criteria named when that more is part of the job.

Ask only when you cannot tell whether merging leaves the product better, or when the PR makes a large or hard-to-undo change the issue did not approve: it removes or replaces something users rely on, changes stored data or a public interface others depend on, or changes the vision or a pinned topic. A large change the issue itself asked for and the owner approved is not a question again.

A send-back is a **product call** when what blocks the PR is a question for the owner rather than work the PR has not done right: the criteria conflict with each other or with the vision, or the issue's approach itself looks wrong now that it is built. Then also ask the one question the owner must answer.

The past cases below are landing calls the owner actually made, with their reasons. Where one is like this PR, follow it and name it.

## The repo

You are in a read-only checkout of ${inputs.repo} at ${inputs.head}, the PR's head. The diff below is against ${inputs.base}, the default branch it would merge into. This is a product call with an eye on whether the code does what it claims, not a style review.

## The vision

${vision}

## Pins

${pins}

## Past landing cases

${precedents}

## The issue: ${issueName}

<issue>
${inputs.issue.text.trim()}
</issue>

## The criteria entail set for ${issueName}

${criteria}

## What the forge reports at ${inputs.head}

${factsText(inputs.facts)}

## The PR: ${name}, as its author describes it

<pr>
${inputs.pr.text.trim()}
</pr>${sendBacks}

## The diff

<diff>
${diff.trim()}
</diff>

Now answer the owner's question for this PR: does it solve the issue's problem, meet its criteria and leave the product better?`;
}

/** The forge's facts as the prompt states them. */
export function factsText(facts: ForgeFacts): string {
  const checks =
    facts.checks.length === 0
      ? "No checks reported at this head."
      : facts.checks.map((check) => `- \`${check.name}\`: ${check.status}${check.reported ? "" : " (not reported)"}`).join("\n");
  const required = facts.required.length === 0 ? "" : `\n\nRequired before merging: ${facts.required.map((r) => `\`${r.name}\`${r.reported ? "" : " (not reported)"}`).join(", ")}.`;
  const files =
    facts.files.length === 0
      ? "No files changed."
      : facts.files.map((file) => `- ${file.path} (${file.status}${file.previousPath === null ? "" : ` from ${file.previousPath}`}, +${file.additions} -${file.deletions})`).join("\n");
  return `CI: ${ciGreen(facts) ? "green" : "not green"}.\n\n${checks}${required}\n\nChanged files (${facts.files.length}):\n\n${files}`;
}

function landingPrecedent(past: LandingCase): string {
  const lines = [
    `### Case ${past.slug}: the owner's call was ${past.call}`,
    `${past.repo} PR #${past.pr}, closing #${past.issue} ("${issueTitle(past.issueText)}"), decided ${past.date}. The owner's reason: ${past.reason}`,
  ];
  if (past.notes !== "") lines.push(past.notes);
  if (past.criteria.length > 0) lines.push(`The criteria it was judged against:\n${past.criteria.map((c) => `- ${c.criterion}`).join("\n")}`);
  return lines.join("\n\n");
}

export interface LandingOptions extends RunOptions {
  model?: string;
  effort?: Effort;
}

export type LandingJudgment =
  | { ok: true; call: LandingCall; answer: LandingAnswer; facts: RunFacts }
  | { ok: false; failure: MachineFailure; facts: RunFacts | null };

/** Makes the call on one PR: one model run, parsed and routed. */
export async function judgeLanding(runner: ModelRunner, inputs: LandingInputs, options: LandingOptions = {}): Promise<LandingJudgment> {
  const { model = DEFAULT_MODEL, effort, ...runOptions } = options;
  const result = await runner.run(
    {
      kind: LANDING_KIND,
      ticket: `${inputs.repo}#${inputs.pr.number}`,
      prompt: landingPrompt(inputs),
      promptVersion: LANDING_PROMPT_VERSION,
      schema: LANDING_SCHEMA,
      checkout: inputs.checkout,
      sha: inputs.head,
      model,
      ...(effort === undefined ? {} : { effort }),
    },
    runOptions,
  );
  if (!result.ok) return result;
  const routed = routeLanding(result.output, { criteria: inputs.criteria, facts: inputs.facts, touched: touched(inputs.facts.files, inputs.pins) });
  if (!routed.ok) return { ok: false, failure: { kind: "no-structured-output", message: routed.problem }, facts: result.facts };
  return { ok: true, call: routed.call, answer: result.output, facts: result.facts };
}

/** A landing call as plain text, for the terminal. */
export function formatLandingCall(call: LandingCall): string {
  const lines = [`${call.call}: ${call.reason}`];
  if (call.guard !== null) lines.push(`  (the model said ${call.guard.from}; ${call.guard.rule === "ci" ? "CI is not green" : "only the owner lets this merge"}: ${call.guard.detail})`);
  for (const line of call.restsOn.visionLines) lines.push(`  rests on the vision: > ${line}`);
  for (const slug of call.restsOn.cases) lines.push(`  rests on case ${slug}`);
  lines.push("", `Solves the problem: ${call.solves.solved ? "yes" : "no"}. ${call.solves.evidence}`);
  if (call.criteria.length > 0) {
    lines.push("", "Criteria:");
    for (const check of call.criteria) lines.push(`  - [${check.met ? "met" : "UNMET"}] ${check.criterion}`, `      ${check.evidence}`);
  }
  if (call.beyond.length > 0) {
    lines.push("", "Beyond the criteria:");
    for (const item of call.beyond) lines.push(`  - [${item.sort}] ${item.change}`, `      ${item.why}`);
  }
  if (call.needsToChange.length > 0) {
    lines.push("", "What needs to change:");
    for (const item of call.needsToChange) lines.push(`  - ${item}`);
  }
  if (call.question !== null) lines.push("", `Question: ${call.question.question}`, `Why it is a question: ${call.question.why}`);
  return lines.join("\n");
}
