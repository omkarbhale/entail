import { GitHubForge } from "../../src/forge/github.ts";
import { forgeContract } from "./contract.ts";
import { loadRecording } from "./recorded-transport.ts";

forgeContract({
  name: "GitHub",
  setting: { forge: "github", host: "github.com", path: "acme/tally" },
  recording: (scenario) => loadRecording(new URL(`./recordings/github/${scenario}.json`, import.meta.url)),
  createForge: (setting, transport) => new GitHubForge(setting, transport, { mergePollIntervalMs: 0 }),
  // Branch protection requires `test`; a ruleset requires `build` and `security`.
  required: (reported) => [
    { name: "test", reported },
    { name: "build", reported },
    { name: "security", reported: false },
  ],
});
