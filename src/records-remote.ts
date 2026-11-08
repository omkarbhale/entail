import { createForge } from "./forge/create-forge.ts";
import type { Forge, ForgeKind } from "./forge/forge.ts";
import { GITHUB_HOST } from "./forge/github.ts";

/** The hosted forges entail knows by host alone. */
const KNOWN_HOSTS: Readonly<Record<string, ForgeKind>> = { [GITHUB_HOST]: "github", "gitlab.com": "gitlab" };

/** Where a records repo remote points, read from its URL as git reads it. */
export type RemoteLocation = { kind: "local" } | { kind: "host"; host: string; path: string } | { kind: "unknown" };

/**
 * Where a git remote points. A path, a `file://` URL, or anything git would
 * read as a local path is on this machine. A URL or scp-like `host:path`
 * names a host and the repo's path there, without a trailing `.git`.
 */
export function remoteLocation(remote: string): RemoteLocation {
  if (/^file:\/\//i.test(remote)) return { kind: "local" };
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(remote) && URL.canParse(remote) ? new URL(remote) : null;
  if (url !== null) {
    if (url.hostname === "") return { kind: "unknown" };
    return hostPath(url.hostname, decodeURIComponent(url.pathname));
  }
  // git reads `[user@]host:path` as scp-like only when no slash comes before the first colon.
  const scp = /^(?:[^@/]+@)?(\[[^\]]+\]|[^:/]+):(.*)$/.exec(remote);
  if (scp !== null) return hostPath(scp[1]!.replace(/^\[|\]$/g, ""), scp[2]!);
  return { kind: "local" };
}

function hostPath(host: string, path: string): RemoteLocation {
  const clean = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  return clean === "" ? { kind: "unknown" } : { kind: "host", host: host.toLowerCase(), path: clean };
}

/** What checking a records repo remote found, when it is set (ADR-0009). */
export type RemoteCheck =
  /** Refused: entail verified that anyone may read it. */
  | { kind: "public"; reason: string }
  /** Accepted, with a note that it does not survive losing this machine. */
  | { kind: "local"; note: string }
  /** Accepted: entail verified it is not public. */
  | { kind: "not-public" }
  /** Accepted: entail could not check it. */
  | { kind: "unchecked" };

export const LOCAL_REMOTE_NOTE =
  "This remote is on this machine, so your records do not survive losing it. Set a remote on another machine or a forge to keep them safe.";

export interface RemoteCheckOptions {
  /** The forge of each host entail knows: github.com, gitlab.com, and every enrolled repo's host. */
  forgeOfHost: (host: string) => ForgeKind | null;
  /** The adapter for a repo; the owner's own CLI for its forge by default. */
  forgeFor?: (setting: { forge: ForgeKind; host: string; path: string }) => Forge;
}

/**
 * Checks a records repo remote as it is set. A remote on a forge host entail
 * knows is asked whether it is public through the owner's own CLI; one that
 * is public is refused, with the reason. A remote entail cannot check, such
 * as a plain git server, a host it does not know, or a repo the forge would
 * not describe, is accepted. A remote on this machine is accepted with a note.
 */
export async function checkRecordsRemote(remote: string, options: RemoteCheckOptions): Promise<RemoteCheck> {
  const location = remoteLocation(remote);
  if (location.kind === "local") return { kind: "local", note: LOCAL_REMOTE_NOTE };
  if (location.kind === "unknown") return { kind: "unchecked" };
  const forge = KNOWN_HOSTS[location.host] ?? options.forgeOfHost(location.host);
  if (forge === null) return { kind: "unchecked" };
  let isPublic: boolean;
  try {
    const adapter = (options.forgeFor ?? createForge)({ forge, host: location.host, path: location.path });
    isPublic = await adapter.isPublic();
  } catch {
    return { kind: "unchecked" };
  }
  if (!isPublic) return { kind: "not-public" };
  return {
    kind: "public",
    reason: `${location.host}/${location.path} is public, and your records hold your private notes and model outputs. Make it private, or choose another remote.`,
  };
}
