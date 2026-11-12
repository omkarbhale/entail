import type { Forge, ForgeSetting } from "./forge.ts";
import { GitHubForge } from "./github.ts";
import { CliTransport, type Transport } from "./transport.ts";

/**
 * The adapter for a repo's forge setting, reached through the owner's CLI for
 * that forge unless another transport is given. This is the one place the
 * forges are told apart; everything above it uses the {@link Forge} interface.
 *
 * Only GitHub is served. The GitLab adapter and its recorded contract are in
 * git history before the 2026-11-12 restart (docs/restart-2026-11-12.md) and
 * can be copied back when wanted.
 */
export function createForge(setting: ForgeSetting, transport?: Transport): Forge {
  switch (setting.forge) {
    case "github":
      return new GitHubForge(setting, transport ?? new CliTransport("gh"));
    case "gitlab":
      throw new Error("the GitLab adapter is not in this tree; it is in git history before the 2026-11-12 restart");
  }
}
