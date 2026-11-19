import type { Forge, ForgeSetting } from "./forge.ts";
import { GitHubForge } from "./github.ts";
import { GitLabForge } from "./gitlab.ts";
import { CliTransport, type Transport } from "./transport.ts";

/**
 * The adapter for a repo's forge setting, reached through the owner's CLI for
 * that forge unless another transport is given: `gh` for GitHub, `glab` for
 * GitLab. This is the one place the forges are told apart; everything above
 * it uses the {@link Forge} interface. `baseBranch` is the base branch the
 * owner set for the repo; null or left out works against the forge's default
 * branch.
 */
export function createForge(setting: ForgeSetting, transport?: Transport, baseBranch: string | null = null): Forge {
  switch (setting.forge) {
    case "github":
      return new GitHubForge(setting, transport ?? new CliTransport("gh"), { baseBranch });
    case "gitlab":
      return new GitLabForge(setting, transport ?? new CliTransport("glab"), { baseBranch });
  }
}
