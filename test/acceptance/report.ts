// The acceptance test's report: per run and per ticket, with each pass check,
// every extra board item, and the model runs and estimated cost of each run
// (no threshold, ADR-0010), then the verdict across runs.
import type { RunReport, Verdict } from "./checks.ts";

const usd = (value: number) => `$${value.toFixed(2)}`;
const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");

/** One run as Markdown. */
export function renderRun(report: RunReport): string {
  const lines = [
    `### ${report.forge} run ${report.run}: ${report.passed ? "every pass check held" : "pass checks failed"}`,
    "",
    `${report.repo} · ${report.startedAt} → ${report.finishedAt}${report.settled ? "" : " · **stopped at the time limit before every ticket settled**"}`,
    "",
    `Model runs: **${report.modelRuns}**, estimated cost **${usd(report.costUsd)}**.`,
    "",
    "| Ticket | Issue | Expected | Ended | Cleared by entail | Path | Model runs | Cost |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.tickets.map(
      (t) =>
        `| ${t.id}${t.wrongClear ? " **wrong clear**" : ""} | ${t.issue === null ? "–" : `#${t.issue}`} | ${t.expectedEnd} | ${t.endsAsExpected ? "" : "✗ "}${t.endState} | ${
          t.clearedAutomatically ? `yes (${t.clearedAs})` : "no"
        } | ${cell(t.path)} | ${t.modelRuns} | ${usd(t.costUsd)} |`,
    ),
    "",
    "| Check | Result |",
    "| --- | --- |",
    ...report.checks.map((c) => `| ${c.id}. ${cell(c.name)} | ${c.passed ? "✓" : `✗ ${cell(c.failures.slice(0, 8).join("; "))}${c.failures.length > 8 ? ` (and ${c.failures.length - 8} more)` : ""}`} |`),
    "",
  ];
  if (report.extraBoardItems.length === 0) lines.push("Extra board items: none.");
  else {
    lines.push("Extra board items:", "");
    for (const item of report.extraBoardItems) {
      lines.push(
        `- ${item.ticket ?? "?"} (issue #${item.issue}), item ${item.item}, raised for ${item.whyRaised}: “${item.decision}” — ${
          item.answered === null ? "left unanswered" : `answered ${JSON.stringify(item.answered)}`
        }`,
      );
    }
  }
  return lines.join("\n");
}

/** The verdict across runs as Markdown. */
export function renderVerdict(verdict: Verdict, reports: readonly RunReport[]): string {
  const total = reports.reduce((sum, r) => sum + r.costUsd, 0);
  const runs = reports.reduce((sum, r) => sum + r.modelRuns, 0);
  const lines = [
    `## Acceptance verdict: ${verdict.status}`,
    "",
    `- GitHub: ${verdict.github}`,
    `- gitlab.com: ${verdict.gitlab}`,
    `- Wrong clears: ${verdict.wrongClears.length === 0 ? "none" : verdict.wrongClears.map((w) => `${w.ticket} (${w.forge} run ${w.run})`).join(", ")}`,
    `- Expected clears across GitHub runs: ${Object.entries(verdict.clears)
      .map(([id, c]) => `${id} ${c.cleared}/${c.runs}`)
      .join(", ")}`,
    `- Model runs across all runs: ${runs}, estimated cost ${usd(total)}`,
  ];
  if (verdict.reasons.length > 0) lines.push("", ...verdict.reasons.map((r) => `- ${r}`));
  return lines.join("\n");
}

export function renderReport(verdict: Verdict, reports: readonly RunReport[]): string {
  return [`# entail MVP-1 acceptance test`, "", renderVerdict(verdict, reports), "", "## Runs", "", ...reports.map(renderRun).flatMap((r) => [r, ""])].join("\n");
}
