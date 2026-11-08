import { GitHubForge } from "../../src/forge/github.ts";
import { forgeContract } from "./contract.ts";
import { loadRecording } from "./recorded-transport.ts";

forgeContract({
  name: "GitHub",
  setting: { forge: "github", host: "github.com", path: "acme/tally" },
  recording: (scenario) => loadRecording(new URL(`./recordings/github/${scenario}.json`, import.meta.url)),
  createForge: (setting, transport) => new GitHubForge(setting, transport, { mergePollIntervalMs: 0 }),
});
