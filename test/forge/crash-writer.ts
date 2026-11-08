// A child process for the forge writer's crash test: it sends one write through
// the forge writer and is killed the moment the forge has applied it, before
// the store can confirm it.
//
// Usage: node test/forge/crash-writer.ts <data-directory> <comment|label|close|merge>
import { join } from "node:path";
import { composeComment } from "../../src/comment-rules.ts";
import { ForgeWriter } from "../../src/forge-writer.ts";
import { Store } from "../../src/store.ts";
import { StateForge } from "./state-forge.ts";

export const CRASH_OWNER = "James";
export const CRASH_HEAD = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

async function main(): Promise<void> {
  const [dir, kind] = process.argv.slice(2);
  if (!dir || !kind) throw new Error("usage: crash-writer.ts <data-directory> <kind>");
  const store = Store.openIn(dir);
  const repo = store.getRepo(1);
  const ticket = store.getTicket(1);
  if (!repo || !ticket) throw new Error("the store has no repo or ticket to write for");
  const forge = new StateForge({
    file: join(dir, "forge.json"),
    afterWrite: () => process.kill(process.pid, "SIGKILL"),
  });
  const writer = new ForgeWriter(store, forge, repo, CRASH_OWNER);
  const write = { ticketId: ticket.id };
  switch (kind) {
    case "comment":
      await writer.comment(write, "issue", ticket.issueNumber, composeComment(CRASH_OWNER, ticket.id, "Cleared."));
      break;
    case "label":
      await writer.addLabel(write, ticket.issueNumber, "entail:cleared");
      break;
    case "close":
      await writer.closeIssue(write, ticket.issueNumber, "not-planned");
      break;
    case "merge":
      await writer.merge(write, 4, CRASH_HEAD);
      break;
    default:
      throw new Error(`unknown write ${kind}`);
  }
  throw new Error("the process outlived its write");
}

if (import.meta.main) await main();
