import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { cmdArgument, cmdArguments, windowsCommand } from "../src/windows.ts";

function temporary(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "entail-windows-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("cmd.exe runs a command line as given: /s drops only the outer quotes", () => {
  assert.deepEqual(cmdArguments('notify "a b"'), ["/d", "/s", "/c", '"notify "a b""']);
});

test("an argument through cmd.exe is quoted for the program and escaped for cmd.exe, twice for a batch file", () => {
  assert.equal(cmdArgument("plain", false), '^"plain^"');
  assert.equal(cmdArgument('a "b" & c', false), '^"a^ \\^"b\\^"^ ^&^ c^"');
  assert.equal(cmdArgument("C:\\dir\\", false), '^"C:\\dir\\\\^"');
  assert.equal(cmdArgument("", true), '^^^"^^^"');
  assert.equal(cmdArgument("50%", true), '^^^"50^^^%^^^"');
});

test("on Windows an .exe on the PATH is run directly and a batch file through cmd.exe", (t) => {
  const exe = temporary(t);
  const batch = temporary(t);
  writeFileSync(join(exe, "tool.exe"), "");
  writeFileSync(join(batch, "claude.cmd"), "");
  const env = { Path: `${exe};${batch}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };

  // Found as an .exe: spawned by its path, its arguments untouched.
  assert.deepEqual(windowsCommand("tool", ["-p", '{"a":1}'], env), { file: join(exe, "tool.exe"), args: ["-p", '{"a":1}'], verbatim: false });

  // Found only as a batch file: run through cmd.exe, every argument escaped twice.
  const run = windowsCommand("claude", ["-p", ""], env);
  assert.equal(run.file, "cmd.exe");
  assert.equal(run.verbatim, true);
  assert.deepEqual(run.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(run.args[3], `"${join(batch, "claude.cmd").replace(/([()\][%!^"`<>&|;, *?])/gu, "^$1")} ^^^"-p^^^" ^^^"^^^""`);

  // Not found: left to spawn, which reports it.
  assert.deepEqual(windowsCommand("missing", [], env), { file: "missing", args: [], verbatim: false });
});

test("on Windows every argument reaches a batch file's program exactly, through cmd.exe", { skip: process.platform !== "win32" && "needs cmd.exe" }, (t) => {
  const dir = temporary(t);
  const echo = join(dir, "echo-args.cjs");
  writeFileSync(echo, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  writeFileSync(join(dir, "fake-claude.cmd"), `@"${process.execPath}" "${echo}" %*\r\n`);
  const args = ["-p", "", '{"type":"object","properties":{"a b":{"pattern":"^x|y&z$"}}}', "100%", "%PATH%", "back\\slash\\", "!bang!", "(paren)"];
  // Windows names the variable Path; a second key spelled PATH would be ignored.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PATH"));
  const run = windowsCommand("fake-claude", args, { ...env, PATH: `${dir};${process.env.PATH ?? ""}` });
  const result = spawnSync(run.file, run.args, { encoding: "utf8", windowsVerbatimArguments: run.verbatim, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
});
