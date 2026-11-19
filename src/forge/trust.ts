import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ForgeCli } from "./transport.ts";

/**
 * Helping an owner whose forge host has a certificate signed by a private
 * certificate authority. The forge CLIs refuse such a host until they are told
 * which CA certificate file to trust for it, and that is a setting of the CLI,
 * not of git: a host git already trusts through its own settings is still
 * refused by `glab`.
 */

/** The per-host setting `glab` reads the CA certificate file from, and the CLI that has one; `gh` has none. */
export const TRUST_CLI: ForgeCli = "glab";

/** The command that makes `glab` trust `file` for `host`. */
export function trustCommand(host: string, file: string): string {
  return `glab config set ca_cert ${quoted(file)} --host ${host}`;
}

function quoted(value: string): string {
  return /^[\w./:@%+=,-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * What the owner is told when `cli` does not trust the certificate of `host`,
 * in plain words and with the steps that make it trust the host. `file` is the
 * CA certificate file to name in the steps, or null to show a placeholder.
 */
export function untrustedCertificateMessage(host: string, cli: ForgeCli, detail: string, file: string | null = null): string {
  const head = `${cli} does not trust the certificate of ${host}, which is signed by an authority ${cli} does not know (${detail}). This is usual for a host with a private certificate authority, and ${cli}'s trust is its own: git trusting the host does not carry over.`;
  if (cli === "glab") {
    return `${head} Tell glab which CA certificate file to trust for that host, then try again: ${trustCommand(host, file ?? "/path/to/ca.pem")}`;
  }
  return `${head} gh reads the system's trusted certificates and the file named by SSL_CERT_FILE: add the authority's certificate to the system's, or run entail with SSL_CERT_FILE=${file ?? "/path/to/ca.pem"} set, then try again.`;
}

/** Runs git with `args` and answers its trimmed output, or null when it failed or printed nothing. */
export type GitReader = (args: string[]) => Promise<string | null>;

const realGit: GitReader = (args) =>
  new Promise((resolve) => {
    execFile("git", args, { encoding: "utf8", timeout: 10_000 }, (error, stdout) => resolve(error ? null : stdout.trim() || null));
  });

/**
 * The CA certificate file git is set to trust for `host`, from its
 * `http.<url>.sslCAInfo` or `http.sslCAInfo` setting (or `GIT_SSL_CAINFO`),
 * as an absolute path, or null when git names none or the file is not there.
 * It only reads: nothing is changed.
 */
export async function gitCaCertificate(host: string, git: GitReader = realGit, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const configured = (await git(["config", "--get-urlmatch", "http.sslCAInfo", `https://${host}/`])) ?? env.GIT_SSL_CAINFO ?? null;
  if (configured === null || configured === "") return null;
  const path = configured === "~" ? homedir() : configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured;
  return isAbsolute(path) && isCertificateFile(path) ? path : null;
}

/** Whether `path` is a regular file holding at least one PEM certificate. */
export function isCertificateFile(path: string): boolean {
  try {
    return statSync(path).isFile() && readFileSync(path, "utf8").includes("-----BEGIN CERTIFICATE-----");
  } catch {
    return false;
  }
}

export interface TrustOptions {
  /** The `glab` executable; `glab` on PATH by default. */
  executable?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Sets `glab` to trust the CA certificate in `file` for `host`, with
 * `glab config set ca_cert <file> --host <host>`. This writes the owner's
 * `glab` configuration, so callers do it only after the owner has confirmed
 * this host and this file.
 *
 * @throws {Error} when the file is not a certificate or `glab` refuses.
 */
export function trustCertificate(host: string, file: string, options: TrustOptions = {}): Promise<void> {
  if (!isAbsolute(file) || !isCertificateFile(file)) {
    return Promise.reject(new Error(`${file} is not a certificate file: give the absolute path of the PEM file of the host's certificate authority`));
  }
  return new Promise((resolve, reject) => {
    execFile(
      options.executable ?? TRUST_CLI,
      ["config", "set", "ca_cert", file, "--host", host],
      { encoding: "utf8", timeout: 30_000, env: { ...(options.env ?? process.env), GLAB_NO_PROMPT: "1", GLAB_CHECK_UPDATE: "false", NO_COLOR: "1" } },
      (error, _stdout, stderr) => {
        if (error) reject(new Error(`glab could not be set to trust ${file} for ${host}: ${stderr.trim() || error.message}`));
        else resolve();
      },
    );
  });
}
