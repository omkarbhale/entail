import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Mirror } from "../src/mirror.ts";
import { VisionWatch, visionHaltText } from "../src/vision-change.ts";
import { FixtureRepo } from "./git-fixture.ts";
import { passSetup } from "./pass-fixture.ts";

const VISION = "# tally\n\ntally counts the words of text files.\n\n## Rules\n\ntally never reaches the network.\n";

async function setup(t: TestContext) {
  const pass = passSetup(t);
  const fixture = new FixtureRepo(t);
  const enrolledAt = fixture.write("VISION.md", VISION).commit("vision");
  fixture.push();
  const repo = pass.enroll({ visionSha: enrolledAt, visionLines: ["tally counts the words of text files.", "tally never reaches the network."] });
  const mirror = await Mirror.open({
    dataDirectory: pass.dataDirectory,
    key: { forge: "github", host: "github.com", projectId: repo.projectId },
    remote: { url: fixture.remote, credentialHelper: null },
  });
  await mirror.updateDefaultBranch();
  const watch = new VisionWatch({ store: pass.store, log: pass.log, dataDirectory: pass.dataDirectory, mirrorFor: async () => mirror });
  /** Commits and pushes, and returns the new default branch head as the mirror fetched it. */
  const push = async (content: string | null, message: string) => {
    if (content === null) fixture.remove("VISION.md");
    else fixture.write("VISION.md", content);
    fixture.commit(message);
    fixture.push();
    return (await mirror.updateDefaultBranch()).commit;
  };
  return { ...pass, repo, fixture, mirror, watch, push, enrolledAt };
}

test("a new VISION.md blob is recorded as a vision change, with each added line's origin read from its commit's trailer", async (t) => {
  const s = await setup(t);
  assert.equal((await s.watch.observe(s.repo, s.enrolledAt)).status, "present");
  assert.deepEqual(s.store.visionChanges(s.repo.id), [], "the vision reviewed at enrollment is no change");

  const agent = await s.push(VISION.replace("tally never reaches the network.", "tally never reaches the network, and never writes files."), "Reword the network line\n\nVision-Origin: agent-proposed-owner-approved\n");
  const standing = await s.watch.observe(s.repo, agent);
  assert.equal(standing.status, "present");
  const [change] = s.store.visionChanges(s.repo.id);
  assert.deepEqual([change!.commitSha, change!.removed, change!.added], [agent, ["tally never reaches the network."], ["tally never reaches the network, and never writes files."]]);
  const reworded = s.store.visionLineOrigin(s.repo.id, "tally never reaches the network, and never writes files.")!;
  assert.deepEqual([reworded.origin, reworded.source, reworded.commitSha, reworded.rawTrailer], ["agent-proposed-owner-approved", "trailer", agent, "agent-proposed-owner-approved"]);

  // Seen again, the same blob is no new change.
  await s.watch.observe(s.repo, agent);
  assert.equal(s.store.visionChanges(s.repo.id).length, 1);

  // No trailer, or an unknown value: stated by the owner, with the raw trailer kept.
  const hand = await s.push(`${VISION.replace("tally never reaches the network.", "tally never reaches the network, and never writes files.")}Counts are exact.\n`, "A hand edit");
  await s.watch.observe(s.repo, hand);
  const unknown = await s.push(
    `${VISION.replace("tally never reaches the network.", "tally never reaches the network, and never writes files.")}Counts are exact.\nOutput is plain.\n`,
    "Agent edit\n\nVision-Origin: agent-wrote-it\n",
  );
  await s.watch.observe(s.repo, unknown);
  const exact = s.store.visionLineOrigin(s.repo.id, "Counts are exact.")!;
  const plain = s.store.visionLineOrigin(s.repo.id, "Output is plain.")!;
  assert.deepEqual([exact.origin, exact.source, exact.rawTrailer], ["owner-stated", "no-trailer", null]);
  assert.deepEqual([plain.origin, plain.source, plain.rawTrailer], ["owner-stated", "trailer", "agent-wrote-it"]);
  assert.deepEqual(
    s.store.visionChanges(s.repo.id).map((c) => [c.removed, c.added]),
    [
      [["tally never reaches the network."], ["tally never reaches the network, and never writes files."]],
      [[], ["Counts are exact."]],
      [[], ["Output is plain."]],
    ],
  );
});

test("a blob that only moves lines is a vision change that removes and adds nothing", async (t) => {
  const s = await setup(t);
  const moved = await s.push("# tally\n\n## Rules\n\ntally never reaches the network.\n\ntally counts the words of text files.\n", "Move lines");
  await s.watch.observe(s.repo, moved);
  assert.deepEqual(s.store.visionChanges(s.repo.id).map((c) => [c.removed, c.added]), [[[], []]]);
});

test("while VISION.md is gone or empty nothing is recorded and the repo stays halted for merges, until a vision is back, which is then recorded against the last vision of record", async (t) => {
  const s = await setup(t);
  const gone = await s.push(null, "Remove the vision");
  assert.deepEqual(await s.watch.observe(s.repo, gone), { status: "gone", commit: gone, why: visionHaltText("missing") });
  assert.equal(s.watch.halted(s.repo.id), visionHaltText("missing"));
  const empty = await s.push("# tally\n", "Only a heading");
  assert.equal((await s.watch.observe(s.repo, empty)).status, "gone");
  assert.equal(s.watch.halted(s.repo.id), visionHaltText("empty"));
  assert.deepEqual(s.store.visionChanges(s.repo.id), []);

  const back = await s.push(`${VISION}Counts are exact.\n`, "Restore the vision");
  assert.equal((await s.watch.observe(s.repo, back)).status, "present");
  assert.equal(s.watch.halted(s.repo.id), null);
  assert.deepEqual(s.store.visionChanges(s.repo.id).map((c) => [c.commitSha, c.removed, c.added]), [[back, [], ["Counts are exact."]]]);
});
