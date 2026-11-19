import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { gitCaCertificate, trustCertificate, trustCommand, untrustedCertificateMessage } from "../src/forge/trust.ts";

function temporary(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "entail-trust-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const CERTIFICATE = "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUdummy\n-----END CERTIFICATE-----\n";

test("the steps name the host and the file, quoted for a shell, and glab's own trust is said to be separate from git's", () => {
  assert.equal(trustCommand("git.example.org", "/etc/ca/team ca.pem"), "glab config set ca_cert '/etc/ca/team ca.pem' --host git.example.org");
  const glab = untrustedCertificateMessage("git.example.org", "glab", "x509: certificate signed by unknown authority", "/etc/ca/ca.pem");
  assert.match(glab, /glab does not trust the certificate of git\.example\.org/u);
  assert.match(glab, /git trusting the host does not carry over/u);
  assert.match(glab, /glab config set ca_cert \/etc\/ca\/ca\.pem --host git\.example\.org$/u);
  assert.match(untrustedCertificateMessage("git.example.org", "gh", "x", null), /SSL_CERT_FILE=\/path\/to\/ca\.pem/u);
});

test("the CA file git trusts for a host is read from git's settings and never changed", async (t) => {
  const dir = temporary(t);
  const file = join(dir, "ca.pem");
  writeFileSync(file, CERTIFICATE);
  const asked: string[][] = [];
  assert.equal(await gitCaCertificate("git.example.org", async (args) => (asked.push(args), file), {}), file);
  assert.deepEqual(asked, [["config", "--get-urlmatch", "http.sslCAInfo", "https://git.example.org/"]]);
  assert.equal(await gitCaCertificate("git.example.org", async () => null, { GIT_SSL_CAINFO: file }), file);
  assert.equal(await gitCaCertificate("git.example.org", async () => null, {}), null, "git names none");
  assert.equal(await gitCaCertificate("git.example.org", async () => join(dir, "gone.pem"), {}), null, "a file that is not there");
  writeFileSync(join(dir, "notes.txt"), "not a certificate");
  assert.equal(await gitCaCertificate("git.example.org", async () => join(dir, "notes.txt"), {}), null, "a file that holds no certificate");
});

test("trusting runs glab config set ca_cert for the host, and refuses a file that is not a certificate before running anything", async (t) => {
  const dir = temporary(t);
  const file = join(dir, "ca.pem");
  writeFileSync(file, CERTIFICATE);
  const fake = join(dir, "glab");
  writeFileSync(fake, `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg"; done > "${dir}/args"\n`);
  chmodSync(fake, 0o755);
  // A shell script cannot be the executable on Windows; the refusals below still run there.
  if (process.platform !== "win32") {
    await trustCertificate("git.example.org", file, { executable: fake });
    assert.deepEqual(readFileSync(join(dir, "args"), "utf8").trim().split("\n"), ["config", "set", "ca_cert", file, "--host", "git.example.org"]);
    rmSync(join(dir, "args"));
  }

  writeFileSync(join(dir, "notes.txt"), "no certificate here");
  await assert.rejects(trustCertificate("git.example.org", join(dir, "notes.txt"), { executable: fake }), /is not a certificate file/u);
  await assert.rejects(trustCertificate("git.example.org", "relative.pem", { executable: fake }), /is not a certificate file/u);
  assert.throws(() => readFileSync(join(dir, "args")), "glab was not run");
});

test("with the real glab, a self-signed test CA is written to a temporary glab configuration for that host only", async (t) => {
  const dir = temporary(t);
  try {
    execFileSync("glab", ["--version"], { stdio: "ignore" });
    execFileSync("openssl", ["version"], { stdio: "ignore" });
  } catch {
    t.skip("glab or openssl is not installed here");
    return;
  }
  const file = join(dir, "ca.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "ca.key"), "-out", file, "-days", "2", "-subj", "/CN=entail test CA"], { stdio: "ignore" });
  const config = join(dir, "glab-config");
  const env = { ...process.env, GLAB_CONFIG_DIR: config, HOME: dir, XDG_CONFIG_HOME: dir };
  await trustCertificate("git.example.org", file, { env });
  const stored = readFileSync(join(config, "config.yml"), "utf8");
  assert.match(stored, /git\.example\.org:/u);
  assert.ok(stored.includes(`ca_cert: ${file}`), stored);
  assert.equal(stored.match(/^\s*ca_cert: \S+/gmu)?.length, 1, "only that host got the setting");
  assert.match(stored, /git\.example\.org:\n\s+ca_cert: /u);
});
