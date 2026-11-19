import { GitHubForge } from "../../src/forge/github.ts";
import { forgeContract } from "./contract.ts";
import { loadRecording } from "./recorded-transport.ts";

/*
 * The contract on a GitHub Enterprise Server, `ghe.example.com`. No such
 * server was available to record from, so these recordings are the github.com
 * ones with the host's own URLs (`https://ghe.example.com/...`, its REST API
 * under `/api/v3`) and its version header, except for the merge: a server has
 * no `merge-async`, so it is merged with `PUT pulls/:number/merge`, and the
 * merge recordings are written to the shape that endpoint documents.
 */
forgeContract({
  name: "GitHub Enterprise Server",
  setting: { forge: "github", host: "ghe.example.com", path: "acme/tally" },
  recording: (scenario) => loadRecording(new URL(`./recordings/ghes/${scenario}.json`, import.meta.url)),
  createForge: (setting, transport) => new GitHubForge(setting, transport, { mergePollIntervalMs: 0 }),
  required: (reported) => [
    { name: "test", reported },
    { name: "build", reported },
    { name: "security", reported: false },
  ],
});
