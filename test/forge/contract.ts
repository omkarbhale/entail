import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { ChangeDeduplicator } from "../../src/changes.ts";
import { CursorStore } from "../../src/cursors.ts";
import {
  type Actor,
  type Change,
  type Forge,
  ForgeLoggedOutError,
  type ForgeSetting,
  projectKey,
  RateLimitedError,
  sameActor,
} from "../../src/forge/forge.ts";
import type { Transport } from "../../src/forge/transport.ts";
import { RecordedTransport, type Recording } from "./recorded-transport.ts";

/**
 * The recorded scenarios every adapter answers. Each adapter records them in
 * its own forge's wire format, playing out the same world described below, and
 * must give the same forge-neutral answers.
 */
export type Scenario = "actor" | "logged-out" | "project" | "changes" | "rate-limited";

export interface ForgeContractSubject {
  name: string;
  setting: ForgeSetting;
  recording(scenario: Scenario): Recording;
  createForge(setting: ForgeSetting, transport: Transport): Forge;
}

/*
 * The world the recordings play out, on repo `setting.path`:
 *
 * - The CLI is logged in as `owner`, user id 1001. `reporter` is user id 1002.
 * - The project's id is 5001 and its default branch is `main`.
 * - At first: issue #1 (id 9001) by owner, and issue #2 (id 9002) by reporter,
 *   with an `/entail` comment (id 7001) on it by owner. A pull request and a
 *   comment on it are also there, and are not issues or issue comments.
 * - Two polls with nothing changed.
 * - Then reporter edits issue #2's title, it is labelled `entail:deciding`, and
 *   owner, having renamed the account to `owner-renamed`, opens issue #3 (id 9003).
 * - Rate limited: the forge refuses reads until 2026-11-08T12:00:00Z.
 */
const OWNER = { id: 1001, username: "owner" };
const REPORTER = { id: 1002, username: "reporter" };

/** Runs the forge contract suite against one adapter on its recorded responses. */
export function forgeContract(subject: ForgeContractSubject): void {
  const { setting } = subject;
  const actor = (who: { id: number; username: string }): Actor => ({
    forge: setting.forge,
    host: setting.host,
    ...who,
  });

  function forgeFor(t: TestContext, scenario: Scenario): Forge {
    const transport = new RecordedTransport(subject.recording(scenario));
    t.after(() => transport.assertDone());
    return subject.createForge(setting, transport);
  }

  describe(`the Forge contract on ${subject.name}`, () => {
    test("the logged-in actor is the forge, host and numeric user id, with the username for display", async (t) => {
      const forge = forgeFor(t, "actor");
      assert.deepEqual(await forge.currentActor(), actor(OWNER));
    });

    test("a CLI that reports no login gives no actor, and reads fail as logged out", async (t) => {
      const forge = forgeFor(t, "logged-out");
      assert.equal(await forge.currentActor(), null);
      await assert.rejects(forge.changesSince(null), (error: unknown) => {
        return error instanceof ForgeLoggedOutError && error.host === setting.host;
      });
    });

    test("the project is known by its numeric id, with its default branch", async (t) => {
      const forge = forgeFor(t, "project");
      const project = await forge.project();
      assert.deepEqual(project, {
        forge: setting.forge,
        host: setting.host,
        id: 5001,
        path: setting.path,
        defaultBranch: "main",
      });
      assert.equal(projectKey(project), `${setting.forge}:${setting.host}:5001`);
    });

    test("what changed since a cursor, deduplicated by kind, id and update time", async (t) => {
      const forge = forgeFor(t, "changes");
      const dataDirectory = mkdtempSync(join(tmpdir(), "entail-contract-"));
      t.after(() => rmSync(dataDirectory, { recursive: true, force: true }));
      const key = projectKey({ forge: setting.forge, host: setting.host, id: 5001 });
      const deduplicator = new ChangeDeduplicator();

      // Each poll starts from the cursor kept as operational state, as a restart would.
      async function poll(): Promise<Change[]> {
        const cursors = new CursorStore(dataDirectory);
        const batch = await forge.changesSince(cursors.get(key));
        cursors.set(key, batch.cursor);
        return deduplicator.fresh(batch.changes);
      }

      const first = await poll();
      assert.deepEqual(first.map(summary).sort(), [
        "issue 9001 2026-11-01T10:00:00.000Z",
        "issue 9002 2026-11-01T11:00:00.000Z",
        "issue-comment 7001 2026-11-01T11:05:00.000Z",
      ]);
      const issue1 = issueOf(first, 9001);
      assert.deepEqual(withoutUrl(issue1), {
        id: 9001,
        number: 1,
        title: "Read from standard input when no file is given",
        body: "tally should count standard input when it is given no file.",
        state: "open",
        author: actor(OWNER),
        labels: [],
        createdAt: "2026-11-01T10:00:00.000Z",
        updatedAt: "2026-11-01T10:00:00.000Z",
      });
      assert.ok(issue1.url.startsWith(`https://${setting.host}/`), "the issue's URL is on its host");
      assert.deepEqual(withoutUrl(issueOf(first, 9002)).author, actor(REPORTER));
      const comment = first.find((change) => change.kind === "issue-comment");
      assert.ok(comment?.kind === "issue-comment");
      assert.deepEqual(
        { ...comment.comment, url: undefined },
        {
          id: 7001,
          issueNumber: 2,
          body: "/entail",
          author: actor(OWNER),
          createdAt: "2026-11-01T11:05:00.000Z",
          updatedAt: "2026-11-01T11:05:00.000Z",
          url: undefined,
        },
      );

      assert.deepEqual(await poll(), [], "nothing changed, so nothing is reported");
      assert.deepEqual(await poll(), [], "still nothing changed");

      const later = await poll();
      assert.deepEqual(later.map(summary).sort(), [
        "issue 9002 2026-11-02T09:00:00.000Z",
        "issue 9003 2026-11-02T09:30:00.000Z",
      ]);
      const edited = issueOf(later, 9002);
      assert.equal(edited.title, "Word counts are one too high after a leading space");
      assert.deepEqual(edited.labels, ["entail:deciding"]);

      const opened = issueOf(later, 9003);
      assert.equal(opened.author.username, "owner-renamed", "the username is kept for display");
      assert.ok(sameActor(opened.author, actor(OWNER)), "a renamed account is still the same actor");
      assert.ok(!sameActor(edited.author, actor(OWNER)), "another account is not the owner");
    });

    test("a rate-limited read is surfaced with its reset time", async (t) => {
      const forge = forgeFor(t, "rate-limited");
      await assert.rejects(forge.changesSince(null), (error: unknown) => {
        return (
          error instanceof RateLimitedError &&
          error.host === setting.host &&
          error.resetAt.toISOString() === "2026-11-08T12:00:00.000Z"
        );
      });
    });
  });
}

function summary(change: Change): string {
  return `${change.kind} ${change.id} ${change.updatedAt}`;
}

function issueOf(changes: Change[], id: number) {
  const change = changes.find((c) => c.kind === "issue" && c.id === id);
  assert.ok(change?.kind === "issue", `issue ${id} is reported`);
  return change.issue;
}

function withoutUrl<T extends { url: string }>(value: T): Omit<T, "url"> {
  const { url: _url, ...rest } = value;
  return rest;
}
