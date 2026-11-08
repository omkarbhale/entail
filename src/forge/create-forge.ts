import type { Forge, ForgeSetting } from "./forge.ts";
import { GitHubForge } from "./github.ts";
import { GitLabForge } from "./gitlab.ts";
import { CliTransport, type Transport } from "./transport.ts";

/**
 * The adapter for a repo's forge setting, reached through the owner's CLI for
 * that forge unless another transport is given. This is the one place the
 * forges are told apart; everything above it uses the {@link Forge} interface.
 */
export function createForge(setting: ForgeSetting, transport?: Transport): Forge {
  switch (setting.forge) {
    case "github":
      return new GitHubForge(setting, transport ?? new CliTransport("gh"));
    case "gitlab":
      return new GitLabForge(setting, transport ?? new CliTransport("glab"));
  }
}
