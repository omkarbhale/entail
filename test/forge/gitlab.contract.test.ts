import { GitLabForge, REQUIRED_PIPELINE } from "../../src/forge/gitlab.ts";
import { forgeContract } from "./contract.ts";
import { loadRecording, type Recording } from "./recorded-transport.ts";

/**
 * The GitLab recordings are made on gitlab.com. A self-hosted GitLab answers
 * the same API at its own host, so the same recordings moved to another host
 * run the contract there too, on the same code path (ADR-0015).
 */
function gitlabRecording(scenario: string, host: string): Recording {
  const recording = loadRecording(new URL(`./recordings/gitlab/${scenario}.json`, import.meta.url));
  return JSON.parse(JSON.stringify(recording).replaceAll("gitlab.com", host)) as Recording;
}

for (const [name, host] of [
  ["GitLab (gitlab.com)", "gitlab.com"],
  ["GitLab (self-hosted)", "gitlab.example.org"],
] as const) {
  forgeContract({
    name,
    setting: { forge: "gitlab", host, path: "acme/tally" },
    recording: (scenario) => gitlabRecording(scenario, host),
    createForge: (setting, transport) => new GitLabForge(setting, transport),
    // "Pipelines must succeed" is on, so the pipeline at the head is required.
    required: (reported) => [{ name: REQUIRED_PIPELINE, reported }],
  });
}
