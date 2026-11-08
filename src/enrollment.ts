import { createForge as createForgeAdapter } from "./forge/create-forge.ts";
import {
  type Actor,
  type Forge,
  type ForgeKind,
  ForgeLoggedOutError,
  ForgeRequestError,
  type ForgeSetting,
  type MergeMethod,
  type Project,
  RateLimitedError,
} from "./forge/forge.ts";
import { TransportError } from "./forge/transport.ts";
import {
  ciFilesAndBuildScripts,
  type GenericCriteriaProposal,
  type GenericCriterionRow,
  normalizeRow,
  numberGenericCriteria,
  proposeGenericCriteria,
  RECENT_DEFAULT_BRANCH_COMMITS,
  reportedCheckNames,
  rowProblems,
} from "./generic-criteria.ts";
import { readGlobalSettings } from "./global-settings.ts";
import { forgeRemote, Mirror, type MirrorRemote } from "./mirror.ts";
import type { ModelRunner } from "./model-runner.ts";
import type { OperationalLog } from "./operational-log.ts";
import { enrollmentSettings, preselectedMergeMethod } from "./repo-settings.ts";
import type { EnrollmentRecord, RepoRecord, SettingsVersionRecord, Store, VisionOrigin } from "./store.ts";
import { readVision, VISION_PATH, type VisionAtCommit } from "./vision.ts";

/** Why enrollment refused a repo; nothing is enrolled after any of these (spec §15 step 2). */
export type RefusalReason =
  | "no-display-name"
  | "invalid-forge-setting"
  | "cli-missing"
  | "logged-out"
  | "host-unreachable"
  | "project-unreadable"
  | "already-enrolled"
  /** The repo was enrolled before, and unenrolled, under another account, which its records name as the owner. */
  | "another-owner"
  | "cannot-label-and-comment"
  | "gitlab-too-old"
  | "no-vision"
  | "empty-vision";

export interface Refusal {
  reason: RefusalReason;
  /** What is wrong and what the owner can do, in one or two sentences. */
  message: string;
}

/** What the owner stated: the forge, its host and the repo's path there (ADR-0015). */
export interface StatedForge {
  forge: string;
  host: string;
  path: string;
}

/**
 * A repo that passed every check, waiting for the owner to confirm the review
 * screen. It holds what was resolved and read, so the owner confirms exactly
 * what they reviewed.
 */
export interface EnrollmentReview {
  setting: ForgeSetting;
  project: Project;
  /** The logged-in account, which becomes "the owner" for this host. */
  owner: Actor;
  /** The default branch and the commit whose VISION.md was read. */
  defaultBranch: string;
  visionSha: string;
  /** Every vision line of that VISION.md, by identity. */
  visionLines: string[];
  /** On GitHub, the merge methods the repo allows (empty when GitHub did not say); null on GitLab. */
  mergeMethods: MergeMethod[] | null;
  /** On GitHub, the merge method preselected by ADR-0018's rule; null on GitLab. */
  preselectedMergeMethod: MergeMethod | null;
  /** Warnings that do not stop enrollment, such as a possible lack of permission to merge. */
  warnings: string[];
  /** The generic criteria entail proposed, for the owner to edit, remove, add to or empty. */
  genericCriteria: GenericCriteriaReview;
}

/** The generic criteria part of the review screen (spec §15 step 4). */
export interface GenericCriteriaReview {
  proposal: GenericCriteriaProposal;
  /**
   * The checks that reported on the default branch's recent commits, against
   * which a row's named check is warned about; null when they could not be read.
   */
  seenChecks: string[] | null;
  /** Why the recent checks could not be read, when they could not. */
  seenChecksProblem: string | null;
  /** The CI files and build scripts at the vision's commit that the run was pointed to. */
  files: string[];
}

export type CheckResult = { ok: true; review: EnrollmentReview } | { ok: false; refusals: Refusal[] };

/** What the owner confirmed on the review screen. */
export interface EnrollmentChoices {
  visionOrigin: VisionOrigin;
  /** Required on GitHub, null on GitLab. */
  mergeMethod: MergeMethod | null;
  /** The generic criteria rows the owner kept, edited or added, in order; none when omitted. */
  genericCriteria?: GenericCriterionRow[];
}

export type ConfirmResult =
  | { ok: true; repo: RepoRecord; settings: SettingsVersionRecord; enrollment: EnrollmentRecord }
  | { ok: false; refusals: Refusal[] };

export interface EnrollerOptions {
  store: Store;
  dataDirectory: string;
  /** Makes the generic criteria proposal run. */
  runner: ModelRunner;
  log?: OperationalLog;
  /** The forge adapter for a forge setting; the owner's own CLI by default. */
  createForge?: (setting: ForgeSetting) => Forge;
  /** Where the mirror fetches a repo from; the forge's HTTPS remote through the owner's CLI by default. */
  remoteFor?: (setting: ForgeSetting, project: Project) => MirrorRemote;
}

const CLI: Record<ForgeKind, string> = { github: "gh", gitlab: "glab" };
const NO_VISION_HINT = "Write one with /vision, commit it to the default branch, and enroll the repo again.";

/**
 * Enrolls repos (spec §15, ADR-0018). {@link Enroller.check} runs every check
 * and sets up the mirror, then the owner confirms the review screen, and
 * {@link Enroller.confirm} records the enrollment in one transaction. Nothing
 * is recorded for a refused repo.
 */
export class Enroller {
  readonly #store: Store;
  readonly #dataDirectory: string;
  readonly #runner: ModelRunner;
  readonly #log: OperationalLog | undefined;
  readonly #createForge: (setting: ForgeSetting) => Forge;
  readonly #remoteFor: (setting: ForgeSetting, project: Project) => MirrorRemote;

  constructor(options: EnrollerOptions) {
    this.#store = options.store;
    this.#dataDirectory = options.dataDirectory;
    this.#runner = options.runner;
    this.#log = options.log;
    this.#createForge = options.createForge ?? ((setting) => createForgeAdapter(setting));
    this.#remoteFor = options.remoteFor ?? ((setting) => forgeRemote(setting.forge, setting.host, setting.path));
  }

  /**
   * Checks a stated repo and, when nothing refuses it, resolves its project id
   * and the logged-in account, sets up its mirror, and returns the review
   * screen's contents. Refuses when the owner's display name is not set, the
   * host's CLI is missing or not logged in, the project cannot be read, the
   * account cannot add labels and comment, GitLab is older than 15.6, or the
   * default branch has no VISION.md or an empty one. A possible lack of
   * permission to merge is a warning only.
   *
   * A repo that passes then gets its generic criteria proposed: entail reads
   * which checks reported on the default branch's recent commits and makes
   * one read-only model run over the mirror's CI files and build scripts.
   * Neither failing refuses the repo; the review shows an empty list instead.
   */
  async check(stated: StatedForge): Promise<CheckResult> {
    const refuseAll = (refusals: Refusal[]): CheckResult => {
      for (const { reason } of refusals) {
        this.#log?.info("enrollment-refused", { forge: stated.forge, host: stated.host, path: stated.path, reason });
      }
      return { ok: false, refusals };
    };
    const refuse = (reason: RefusalReason, message: string) => refuseAll([{ reason, message }]);
    const name = this.#displayNameRefusal();
    if (name) return refuse(name.reason, name.message);

    const parsed = parseStatedForge(stated);
    if (typeof parsed === "string") return refuse("invalid-forge-setting", parsed);
    const setting = parsed;
    let forge: Forge;
    try {
      forge = this.#createForge(setting);
    } catch (error) {
      return refuse("invalid-forge-setting", `${messageOf(error)}.`);
    }
    const cli = CLI[setting.forge];
    const where = `${setting.path} on ${setting.host}`;
    const refuseRead = (error: unknown, what = where) => refuseAll([forgeRefusal(error, cli, setting.host, what)]);

    let owner: Actor | null;
    try {
      owner = await forge.currentActor();
    } catch (error) {
      return refuseRead(error, "the logged-in account");
    }
    if (owner === null) return refuseRead(new ForgeLoggedOutError(setting.host, "no account"));

    let project: Project;
    try {
      project = await forge.project();
    } catch (error) {
      return refuseRead(error);
    }
    const earlier = this.#store.findRepo({ forge: setting.forge, host: setting.host, projectId: project.id });
    if (earlier !== null && this.#store.isEnrolled(earlier.id)) {
      return refuse("already-enrolled", `${where} is already enrolled.`);
    }
    const otherOwner = earlier === null ? null : anotherOwner(earlier, owner, CLI[setting.forge]);
    if (otherOwner !== null) return refuseAll([otherOwner]);

    const refusals: Refusal[] = [];
    const warnings: string[] = [];
    let mergeMethods: MergeMethod[] | null;
    try {
      const instance = await forge.instance();
      if (instance.unsupported !== null) refusals.push({ reason: "gitlab-too-old", message: `${instance.unsupported}.` });

      const access = await forge.access();
      if (access.cannotLabelAndComment !== null) {
        refusals.push({
          reason: "cannot-label-and-comment",
          message: `entail cannot add labels and comment in ${where} as ${owner.username}: ${access.cannotLabelAndComment}.`,
        });
      }
      if (access.mayLackMerge !== null) {
        warnings.push(
          `${owner.username} may lack permission to merge into the default branch: ${access.mayLackMerge}. ` +
            `entail enrolls the repo anyway; if the forge refuses a merge, entail says so on the PR.`,
        );
      }
      mergeMethods = await forge.mergeMethods();
    } catch (error) {
      return refuseRead(error);
    }
    // A repo already refused is not fetched: its mirror would be set up for nothing.
    if (refusals.length > 0) return refuseAll(refusals);

    // The mirror is set up before the review, and VISION.md is read from it (ADR-0015).
    let vision: VisionAtCommit;
    let defaultBranch: string;
    let mirror: Mirror;
    try {
      mirror = await Mirror.open({
        dataDirectory: this.#dataDirectory,
        key: { forge: setting.forge, host: setting.host, projectId: project.id },
        remote: this.#remoteFor(setting, project),
        log: this.#log,
      });
      const head = await mirror.updateDefaultBranch();
      defaultBranch = head.branch;
      vision = await readVision(mirror.git, head.commit);
    } catch (error) {
      return refuse(
        "project-unreadable",
        `git could not read ${where} through \`${cli}\`: ${messageOf(error)}. Check that \`${cli} auth status\` works for ${setting.host}, then enroll again.`,
      );
    }
    if (vision.status === "missing") {
      return refuse("no-vision", `The default branch \`${defaultBranch}\` has no ${VISION_PATH}. ${NO_VISION_HINT}`);
    }
    if (vision.status === "empty") {
      return refuse(
        "empty-vision",
        `${VISION_PATH} on the default branch \`${defaultBranch}\` is empty: it states nothing, so it would contradict no ticket. ${NO_VISION_HINT}`,
      );
    }
    const genericCriteria = await this.#proposeGenericCriteria(forge, mirror, defaultBranch, vision.commit, setting);

    return {
      ok: true,
      review: {
        setting,
        project,
        owner,
        defaultBranch,
        visionSha: vision.commit,
        visionLines: [...new Set(vision.lines.map((line) => line.identity))],
        mergeMethods,
        preselectedMergeMethod: mergeMethods === null ? null : preselectedMergeMethod(mergeMethods),
        warnings,
        genericCriteria,
      },
    };
  }

  /**
   * The generic criteria proposal of spec §15 step 4: the checks seen on the
   * default branch's recent commits, then one read-only model run, with no
   * challenge, over the CI files and build scripts at the vision's commit.
   */
  async #proposeGenericCriteria(
    forge: Forge,
    mirror: Mirror,
    defaultBranch: string,
    commit: string,
    setting: ForgeSetting,
  ): Promise<GenericCriteriaReview> {
    const where = { forge: setting.forge, host: setting.host, path: setting.path };
    let seenChecks: string[] | null = null;
    let seenChecksProblem: string | null = null;
    try {
      seenChecks = reportedCheckNames(await forge.recentDefaultBranchChecks(RECENT_DEFAULT_BRANCH_COMMITS));
    } catch (error) {
      seenChecksProblem = messageOf(error);
      this.#log?.warn("recent-checks-unread", { ...where, error: seenChecksProblem });
    }

    let files: string[] = [];
    let proposal: GenericCriteriaProposal;
    try {
      files = await ciFilesAndBuildScripts(mirror.git, commit);
      const checkout = await mirror.checkout(commit);
      proposal = await proposeGenericCriteria({
        runner: this.#runner,
        model: readGlobalSettings(this.#store).settings.model,
        defaultBranch,
        checkout,
        files,
        seenChecks,
      });
    } catch (error) {
      proposal = { rows: [], failure: { kind: "error", message: messageOf(error) }, run: null };
    }
    if (proposal.failure !== null) {
      // A machine failure: logged, never on the board, and never a refusal (ADR-0017).
      this.#log?.warn("generic-criteria-proposal-failed", { ...where, kind: proposal.failure.kind, error: proposal.failure.message });
    }
    return { proposal, seenChecks, seenChecksProblem, files };
  }

  /**
   * Enrolls a reviewed repo with the owner's choices. It reads the issues open
   * now, which are recorded as not to be taken in, then records the repo with
   * its project id and the owner's account, its first settings version, and
   * the confirmed origin of every existing vision line, in one transaction.
   */
  async confirm(review: EnrollmentReview, choices: EnrollmentChoices): Promise<ConfirmResult> {
    const name = this.#displayNameRefusal();
    if (name) return { ok: false, refusals: [name] };
    const { setting, project, owner } = review;
    const where = `${setting.path} on ${setting.host}`;
    if ((review.mergeMethods === null) !== (choices.mergeMethod === null)) {
      throw new Error(review.mergeMethods === null ? "GitLab has no merge method setting" : "a GitHub repo needs a merge method");
    }
    const rows = (choices.genericCriteria ?? []).map(normalizeRow);
    const problems = rows.flatMap((row, index) => rowProblems(row).map((problem) => `generic criterion ${index + 1}: ${problem}`));
    if (problems.length > 0) throw new Error(problems.join(" "));

    let openIssueNumbers: number[];
    try {
      openIssueNumbers = await this.#createForge(setting).openIssueNumbers();
    } catch (error) {
      return { ok: false, refusals: [forgeRefusal(error, CLI[setting.forge], setting.host, where)] };
    }

    const ownerName = readGlobalSettings(this.#store).settings.ownerDisplayName!;
    let recorded: ReturnType<Store["enroll"]>;
    try {
      recorded = this.#store.transaction(() => {
        const earlier = this.#store.findRepo({ forge: setting.forge, host: setting.host, projectId: project.id });
        if (earlier !== null && this.#store.isEnrolled(earlier.id)) throw new AlreadyEnrolled();
        const otherOwner = earlier === null ? null : anotherOwner(earlier, owner, CLI[setting.forge]);
        if (otherOwner !== null) throw new AnotherOwner(otherOwner);
        return this.#store.enroll({
          repo: {
            forge: setting.forge,
            host: setting.host,
            projectId: project.id,
            path: setting.path,
            ownerAccountId: owner.id,
            ownerLogin: owner.username,
          },
          settings: enrollmentSettings(choices.visionOrigin, choices.mergeMethod, numberGenericCriteria(rows)),
          savedBy: ownerName,
          visionSha: review.visionSha,
          visionLines: review.visionLines,
          visionOrigin: choices.visionOrigin,
          openIssueNumbers,
          modelRuns: review.genericCriteria.proposal.run === null ? [] : [review.genericCriteria.proposal.run],
        });
      });
    } catch (error) {
      if (error instanceof AlreadyEnrolled) {
        return { ok: false, refusals: [{ reason: "already-enrolled", message: `${where} is already enrolled.` }] };
      }
      if (error instanceof AnotherOwner) return { ok: false, refusals: [error.refusal] };
      throw error;
    }
    this.#log?.info("repo-enrolled", {
      repoId: recorded.repo.id,
      forge: setting.forge,
      host: setting.host,
      projectId: project.id,
      path: setting.path,
      openIssuesLeftAlone: openIssueNumbers.length,
      genericCriteria: rows.length,
    });
    return { ok: true, ...recorded };
  }

  #displayNameRefusal(): Refusal | null {
    if (readGlobalSettings(this.#store).settings.ownerDisplayName !== null) return null;
    return {
      reason: "no-display-name",
      message: "Set your display name in the global settings first: every comment and answer carries it.",
    };
  }
}

class AlreadyEnrolled extends Error {}

class AnotherOwner extends Error {
  readonly refusal: Refusal;
  constructor(refusal: Refusal) {
    super(refusal.message);
    this.refusal = refusal;
  }
}

/**
 * Why a repo unenrolled earlier cannot be enrolled again by `owner`, or null
 * when it can. Enrolling again keeps the repo's record, keyed on its project
 * id, and that record names the owner whose new issues enter on their own; so
 * the logged-in account must be that owner (ADR-0018).
 */
function anotherOwner(earlier: RepoRecord, owner: Actor, cli: string): Refusal | null {
  if (owner.id === earlier.ownerAccountId) return null;
  return {
    reason: "another-owner",
    message:
      `${earlier.path} on ${earlier.host} was enrolled before with the account ${earlier.ownerLogin}, which its records name as the owner. ` +
      `Log \`${cli}\` in to ${earlier.host} as ${earlier.ownerLogin}, then enroll again.`,
  };
}

/** Reads the stated forge, host and path, or says what is wrong with them. */
export function parseStatedForge(stated: StatedForge): ForgeSetting | string {
  const forge = stated.forge.trim();
  if (forge !== "github" && forge !== "gitlab") return "Pick the forge: github or gitlab.";
  const host = stated.host.trim().toLowerCase();
  if (host === "") return "Enter the forge's host, such as github.com or gitlab.com.";
  const path = stated.path.trim().replace(/^\/+|\/+$/g, "");
  if (path === "") return "Enter the repo's path on the host, such as owner/name.";
  return { forge, host, path };
}

/** The refusal a failed forge read stands for. */
function forgeRefusal(error: unknown, cli: string, host: string, what: string): Refusal {
  if (error instanceof TransportError && error.cliMissing) {
    return { reason: "cli-missing", message: `\`${cli}\` is not installed. Install it, log it in to ${host}, then enroll again.` };
  }
  if (error instanceof ForgeLoggedOutError) {
    return { reason: "logged-out", message: `\`${cli}\` is not logged in to ${host}. Run \`${cli} auth login --hostname ${host}\`, then enroll again.` };
  }
  if (error instanceof RateLimitedError) {
    return { reason: "host-unreachable", message: `${host} is rate limiting reads until ${error.resetAt.toISOString()}. Enroll again after that.` };
  }
  if (error instanceof ForgeRequestError) {
    return { reason: "project-unreadable", message: `entail cannot read ${what}: ${error.message}.` };
  }
  return { reason: "host-unreachable", message: `entail could not read ${what} through \`${cli}\`: ${messageOf(error)}.` };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
