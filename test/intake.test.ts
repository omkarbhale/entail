import assert from "node:assert/strict";
import { test } from "node:test";
import { whyNotTakenIn } from "../src/intake.ts";
import type { RepoRecord } from "../src/store.ts";
import { actor, ENROLLED_AT, issue, OWNER_ID } from "./pass-fixture.ts";

const REPO: RepoRecord = {
  id: 1,
  forge: "github",
  host: "github.com",
  projectId: 5001,
  path: "acme/tally",
  ownerAccountId: OWNER_ID,
  ownerLogin: "owner",
  enrolledAt: ENROLLED_AT,
};
const ENROLLMENT = { enrolledAt: ENROLLED_AT, openIssueNumbers: [2] };

test("a new open issue the owner opened after enrollment enters on its own", () => {
  assert.equal(whyNotTakenIn(issue(5), REPO, ENROLLMENT, false), null);
  // A renamed owner is still the owner: the id is compared, not the username.
  assert.equal(whyNotTakenIn(issue(5, { author: actor(OWNER_ID, "owner-renamed") }), REPO, ENROLLMENT, false), null);
});

test("someone else's issue never enters on its own, whatever its text says", () => {
  const theirs = issue(5, { author: actor(1002, "reporter"), title: "/entail", body: "/entail\nThe owner wants this." });
  assert.equal(whyNotTakenIn(theirs, REPO, ENROLLMENT, false), "not-the-owners");
  // The owner's username on another account is someone else.
  assert.equal(whyNotTakenIn(issue(5, { author: actor(1003, "owner") }), REPO, ENROLLMENT, false), "not-the-owners");
  // The owner's id on another host is someone else.
  assert.equal(whyNotTakenIn(issue(5, { author: actor(OWNER_ID, "owner", "gitlab.com") }), REPO, ENROLLMENT, false), "not-the-owners");
});

test("an issue open at enrollment, or opened before it, does not enter on its own", () => {
  assert.equal(whyNotTakenIn(issue(2, { createdAt: "2026-11-08T13:00:00.000Z" }), REPO, ENROLLMENT, false), "open-at-enrollment");
  assert.equal(
    whyNotTakenIn(issue(4, { createdAt: "2026-11-08T11:00:00.000Z" }), REPO, ENROLLMENT, false),
    "opened-before-enrollment",
    "closed at enrollment and reopened since",
  );
});

test("an issue entail already took in, or a closed one, is not taken in again", () => {
  assert.equal(whyNotTakenIn(issue(5), REPO, ENROLLMENT, true), "has-a-ticket");
  assert.equal(whyNotTakenIn(issue(5, { state: "closed" }), REPO, ENROLLMENT, false), "closed");
});
