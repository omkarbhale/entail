import assert from "node:assert/strict";
import { test } from "node:test";
import type { Forge, ForgeKind } from "../src/forge/forge.ts";
import { checkRecordsRemote, LOCAL_REMOTE_NOTE, remoteLocation } from "../src/records-remote.ts";

test("a remote is read as git reads it: on this machine, or a host and the repo's path there", () => {
  for (const local of ["/srv/records.git", "./records", "../records.git", "records", "file:///srv/records.git", "FILE:///x"]) {
    assert.deepEqual(remoteLocation(local), { kind: "local" }, local);
  }
  const hosted: [string, string, string][] = [
    ["https://github.com/ada/records.git", "github.com", "ada/records"],
    ["https://github.com/ada/records", "github.com", "ada/records"],
    ["git@github.com:ada/records.git", "github.com", "ada/records"],
    ["ssh://git@github.com/ada/records.git", "github.com", "ada/records"],
    ["ssh://git@GitLab.example.com:2222/group/sub/records.git", "gitlab.example.com", "group/sub/records"],
    ["gitlab.com:group/records", "gitlab.com", "group/records"],
    ["https://git.example.org/records.git/", "git.example.org", "records"],
  ];
  for (const [remote, host, path] of hosted) assert.deepEqual(remoteLocation(remote), { kind: "host", host, path }, remote);
  assert.deepEqual(remoteLocation("https://github.com/"), { kind: "unknown" });
});

interface Asked {
  forge: ForgeKind;
  host: string;
  path: string;
}

/** A forge answering only whether the repo is public, recording what it was asked. */
function forges(answer: (asked: Asked) => boolean | Error) {
  const asked: Asked[] = [];
  const forgeFor = (setting: Asked) => {
    asked.push(setting);
    return {
      async isPublic() {
        const result = answer(setting);
        if (result instanceof Error) throw result;
        return result;
      },
    } as unknown as Forge;
  };
  return { asked, forgeFor };
}

const noEnrolledHosts = () => null;

test("a remote entail can verify is public is refused, with the reason", async () => {
  const { asked, forgeFor } = forges(() => true);
  const check = await checkRecordsRemote("git@github.com:ada/records.git", { forgeOfHost: noEnrolledHosts, forgeFor });
  assert.equal(check.kind, "public");
  assert.match(check.kind === "public" ? check.reason : "", /github\.com\/ada\/records is public.*private notes/);
  assert.deepEqual(asked, [{ forge: "github", host: "github.com", path: "ada/records" }]);

  const gitlab = await checkRecordsRemote("https://gitlab.com/acme/ops/records.git", { forgeOfHost: noEnrolledHosts, forgeFor });
  assert.equal(gitlab.kind, "public");
  assert.deepEqual(asked[1], { forge: "gitlab", host: "gitlab.com", path: "acme/ops/records" });
});

test("a remote the forge reports is not public is accepted", async () => {
  const { forgeFor } = forges(() => false);
  assert.deepEqual(await checkRecordsRemote("https://github.com/ada/records", { forgeOfHost: noEnrolledHosts, forgeFor }), { kind: "not-public" });
});

test("a self-hosted forge is checked when an enrolled repo names its forge", async () => {
  const { asked, forgeFor } = forges(() => true);
  const forgeOfHost = (host: string) => (host === "gitlab.example.com" ? ("gitlab" as const) : null);
  const check = await checkRecordsRemote("ssh://git@gitlab.example.com/ada/records.git", { forgeOfHost, forgeFor });
  assert.equal(check.kind, "public");
  assert.deepEqual(asked, [{ forge: "gitlab", host: "gitlab.example.com", path: "ada/records" }]);
});

test("a remote entail cannot check is accepted: an unknown host, or a forge that will not say", async () => {
  const { asked, forgeFor } = forges(() => new Error("HTTP 404"));
  assert.deepEqual(await checkRecordsRemote("git@git.example.org:records.git", { forgeOfHost: noEnrolledHosts, forgeFor }), { kind: "unchecked" });
  assert.equal(asked.length, 0, "an unknown host is not asked");
  assert.deepEqual(await checkRecordsRemote("https://github.com/ada/records.git", { forgeOfHost: noEnrolledHosts, forgeFor }), { kind: "unchecked" });
  assert.equal(asked.length, 1);
});

test("a remote on this machine is accepted, with a note that it does not survive losing the machine", async () => {
  const { asked, forgeFor } = forges(() => true);
  for (const remote of ["/srv/backups/records.git", "file:///srv/backups/records.git"]) {
    assert.deepEqual(await checkRecordsRemote(remote, { forgeOfHost: noEnrolledHosts, forgeFor }), { kind: "local", note: LOCAL_REMOTE_NOTE });
  }
  assert.match(LOCAL_REMOTE_NOTE, /do not survive losing/);
  assert.equal(asked.length, 0);
});
