import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveDataDirectory, UnsupportedPlatformError } from "../src/data-directory.ts";
import { LOCK_FILE, type LockHolder } from "../src/lock.ts";
import {
  installService,
  launchdPlist,
  machineServiceSystem,
  serviceDefinition,
  ServiceError,
  serviceEnvironment,
  serviceStatus,
  systemdUnit,
  uninstallService,
  type CommandResult,
  type ServiceInputs,
  type ServiceSystem,
} from "../src/service.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function tempHome(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "entail-service-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function inputs(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}): ServiceInputs {
  return {
    platform,
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", ...env },
    home,
    uid: 501,
    node: "/opt/node/bin/node",
    cli: "/opt/entail/dist/cli.js",
  };
}

interface FakeSystem extends ServiceSystem {
  calls: string[];
}

/** A service manager that records each command and answers from `results`. */
function fakeSystem(
  options: {
    results?: Record<string, CommandResult>;
    running?: () => LockHolder | null;
    kernel?: string;
  } = {},
): FakeSystem {
  const calls: string[] = [];
  return {
    calls,
    exec(file, args) {
      const call = [file, ...args].join(" ");
      calls.push(call);
      return options.results?.[call] ?? { status: 0, output: "" };
    },
    runningCopy: options.running ?? (() => null),
    sleep: async () => {},
    kernelRelease: () => options.kernel ?? "6.8.0-generic",
  };
}

test("on Linux and WSL the service is a systemd user unit that runs entail run, restarts after a crash and starts at login", (t) => {
  const home = tempHome(t);
  const definition = serviceDefinition(inputs(home, "linux"));
  assert.equal(definition.manager, "systemd");
  assert.equal(definition.path, join(home, ".config", "systemd", "user", "entail.service"));
  const lines = definition.content.split("\n");
  for (const line of [
    "[Service]",
    'ExecStart="/opt/node/bin/node" "/opt/entail/dist/cli.js" run',
    'Environment="PATH=/usr/local/bin:/usr/bin:/bin"',
    "Restart=on-failure",
    "RestartSec=10",
    "[Install]",
    "WantedBy=default.target",
  ]) {
    assert.ok(lines.includes(line), `the unit has ${line}`);
  }
});

test("the systemd unit goes under an absolute XDG_CONFIG_HOME, and a relative one is ignored", (t) => {
  const home = tempHome(t);
  assert.equal(
    serviceDefinition(inputs(home, "linux", { XDG_CONFIG_HOME: "/cfg" })).path,
    join("/cfg", "systemd", "user", "entail.service"),
  );
  assert.equal(
    serviceDefinition(inputs(home, "linux", { XDG_CONFIG_HOME: "cfg" })).path,
    join(home, ".config", "systemd", "user", "entail.service"),
  );
});

test("the service keeps the installing shell's data and config directories, so it shares the lock of entail run by hand and gh's login", () => {
  assert.deepEqual(serviceEnvironment("linux", { PATH: "/bin", XDG_DATA_HOME: "/data", XDG_CONFIG_HOME: "/cfg", GH_TOKEN: "secret" }), {
    PATH: "/bin",
    XDG_DATA_HOME: "/data",
    XDG_CONFIG_HOME: "/cfg",
  });
  assert.deepEqual(serviceEnvironment("linux", { PATH: "/bin", XDG_DATA_HOME: "relative" }), { PATH: "/bin" });
  // On macOS the data directory depends only on the home directory.
  assert.deepEqual(serviceEnvironment("darwin", { PATH: "/bin", XDG_DATA_HOME: "/data" }), { PATH: "/bin" });
  assert.ok(systemdUnit({ node: "/n", cli: "/c", environment: { XDG_DATA_HOME: "/data" } }).includes('Environment="XDG_DATA_HOME=/data"'));
});

test("the systemd unit quotes paths with spaces, quotes, specifiers and dollars", () => {
  const unit = systemdUnit({
    node: "/home/a b/node",
    cli: '/x/50%"$HOME"\\cli.js',
    environment: { PATH: "/p 1:/100%:$X" },
  });
  assert.ok(unit.includes('ExecStart="/home/a b/node" "/x/50%%\\"$$HOME\\"\\\\cli.js" run'), unit);
  assert.ok(unit.includes('Environment="PATH=/p 1:/100%%:$X"'), unit);
  assert.throws(() => systemdUnit({ node: "/n\n", cli: "/c", environment: {} }), ServiceError);
});

test("on macOS the service is a launchd agent that runs entail run, starts at load and restarts after a crash", (t) => {
  const home = tempHome(t);
  const definition = serviceDefinition(inputs(home, "darwin"));
  assert.equal(definition.manager, "launchd");
  assert.equal(definition.path, join(home, "Library", "LaunchAgents", "entail.plist"));
  const plist = definition.content.replace(/\s+/g, "");
  for (const fragment of [
    "<key>Label</key><string>entail</string>",
    "<key>ProgramArguments</key><array><string>/opt/node/bin/node</string><string>/opt/entail/dist/cli.js</string><string>run</string></array>",
    "<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/local/bin:/usr/bin:/bin</string></dict>",
    "<key>RunAtLoad</key><true/>",
    "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
    "<key>ThrottleInterval</key><integer>10</integer>",
    "<key>ExitTimeOut</key><integer>30</integer>",
  ]) {
    assert.ok(plist.includes(fragment), `the plist has ${fragment}`);
  }
});

test("the launchd plist escapes XML", () => {
  const plist = launchdPlist({ node: "/a&b/<node>", cli: "/c's\"", environment: {} });
  assert.ok(plist.includes("<string>/a&amp;b/&lt;node&gt;</string>"));
  assert.ok(plist.includes("<string>/c&apos;s&quot;</string>"));
  assert.ok(!plist.includes("EnvironmentVariables"), "no empty environment dict");
});

test("the service definitions are valid to the platform's own checker, when it is present", (t) => {
  if (process.platform === "linux") {
    const analyze = spawnSync("systemd-analyze", ["--version"], { encoding: "utf8" });
    if (analyze.error || analyze.status !== 0) return t.skip("systemd-analyze is not installed");
    const dir = tempHome(t);
    const path = join(dir, "entail.service");
    writeFileSync(path, systemdUnit({ node: process.execPath, cli: CLI, environment: { PATH: process.env.PATH ?? "/usr/bin" } }));
    const result = spawnSync("systemd-analyze", ["--user", "verify", path], { encoding: "utf8" });
    const complaints = `${result.stdout}${result.stderr}`
      .split("\n")
      .filter((line) => line.includes("entail.service"));
    assert.deepEqual(complaints, [], "systemd-analyze has no complaint about the unit");
  } else if (process.platform === "darwin") {
    const dir = tempHome(t);
    const path = join(dir, "entail.plist");
    writeFileSync(path, launchdPlist({ node: process.execPath, cli: CLI, environment: { PATH: "/usr/bin" } }));
    const result = spawnSync("plutil", ["-lint", path], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } else {
    t.skip(`no service checker on ${process.platform}`);
  }
});

test("native Windows has no service", (t) => {
  assert.throws(() => serviceDefinition(inputs(tempHome(t), "win32")), UnsupportedPlatformError);
});

test("installing on Linux writes the unit, reloads systemd, then enables and starts it", async (t) => {
  const home = tempHome(t);
  const system = fakeSystem();
  const { definition, replaced } = await installService(inputs(home, "linux"), system);
  assert.equal(replaced, false);
  assert.equal(readFileSync(definition.path, "utf8"), definition.content);
  assert.deepEqual(system.calls, ["systemctl --user daemon-reload", "systemctl --user enable --now entail.service"]);
});

test("installing again on Linux stops the running service and replaces its unit", async (t) => {
  const home = tempHome(t);
  const first = await installService(inputs(home, "linux"), fakeSystem());
  writeFileSync(first.definition.path, "old");
  // The stopped service holds the lock until it has stopped.
  let holderChecks = 0;
  const system = fakeSystem({
    running: () => (holderChecks++ < 2 ? { pid: 4242, startedAt: "2026-11-08T00:00:00.000Z" } : null),
  });
  const { definition, replaced } = await installService(inputs(home, "linux"), system);
  assert.equal(replaced, true);
  assert.equal(readFileSync(definition.path, "utf8"), definition.content);
  assert.deepEqual(system.calls, [
    "systemctl --user stop entail.service",
    "systemctl --user daemon-reload",
    "systemctl --user enable --now entail.service",
  ]);
});

test("installing refuses while a foreground entail run holds the lock, and writes nothing", async (t) => {
  const home = tempHome(t);
  const system = fakeSystem({ running: () => ({ pid: 4242, startedAt: "2026-11-08T00:00:00.000Z" }) });
  await assert.rejects(installService(inputs(home, "linux"), system), (error: Error) => {
    assert.ok(error instanceof ServiceError);
    assert.match(error.message, /already running \(pid 4242,/);
    return true;
  });
  assert.ok(!existsSync(serviceDefinition(inputs(home, "linux")).path));
  assert.deepEqual(system.calls, [], "nothing was asked of systemd");
});

test("installing refuses while the real lock is held by a live copy", async (t) => {
  const home = tempHome(t);
  const env = { XDG_DATA_HOME: join(home, "data") };
  const machineInputs = inputs(home, "linux", env);
  const dataDirectory = resolveDataDirectory({ platform: "linux", env, home });
  mkdirSync(dataDirectory, { recursive: true });
  writeFileSync(join(dataDirectory, LOCK_FILE), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const system: ServiceSystem = { ...machineServiceSystem(machineInputs), exec: fakeSystem().exec };
  await assert.rejects(installService(machineInputs, system), new RegExp(`already running \\(pid ${process.pid},`));
});

test("a failed systemctl removes the unit again, and on WSL says how to enable systemd", async (t) => {
  const home = tempHome(t);
  const system = fakeSystem({
    kernel: "6.6.87.2-microsoft-standard-WSL2",
    results: { "systemctl --user daemon-reload": { status: 1, output: "Failed to connect to bus" } },
  });
  await assert.rejects(installService(inputs(home, "linux"), system), (error: Error) => {
    assert.ok(error instanceof ServiceError);
    assert.match(error.message, /systemctl --user daemon-reload failed: Failed to connect to bus/);
    assert.match(error.message, /systemd=true under \[boot\] in \/etc\/wsl\.conf/);
    return true;
  });
  assert.ok(!existsSync(serviceDefinition(inputs(home, "linux")).path));
});

test("uninstalling on Linux stops and disables the unit, then removes it", async (t) => {
  const home = tempHome(t);
  await installService(inputs(home, "linux"), fakeSystem());
  const system = fakeSystem();
  const { definition, removed } = uninstallService(inputs(home, "linux"), system);
  assert.equal(removed, true);
  assert.ok(!existsSync(definition.path));
  assert.deepEqual(system.calls, ["systemctl --user disable --now entail.service", "systemctl --user daemon-reload"]);
});

test("uninstalling on Linux when nothing is installed does nothing", (t) => {
  const system = fakeSystem();
  assert.equal(uninstallService(inputs(tempHome(t), "linux"), system).removed, false);
  assert.deepEqual(system.calls, []);
});

test("a failed disable keeps the unit, so uninstalling can be tried again", async (t) => {
  const home = tempHome(t);
  await installService(inputs(home, "linux"), fakeSystem());
  const system = fakeSystem({
    results: { "systemctl --user disable --now entail.service": { status: 1, output: "Access denied" } },
  });
  assert.throws(() => uninstallService(inputs(home, "linux"), system), /disable --now entail\.service failed: Access denied/);
  assert.ok(existsSync(serviceDefinition(inputs(home, "linux")).path));
});

test("installing on macOS writes the agent, then enables and bootstraps it in the user's GUI domain", async (t) => {
  const home = tempHome(t);
  // Nothing was loaded before, so bootout fails and is ignored.
  const system = fakeSystem({ results: { "launchctl bootout gui/501/entail": { status: 3, output: "No such process" } } });
  const { definition } = await installService(inputs(home, "darwin"), system);
  assert.equal(readFileSync(definition.path, "utf8"), definition.content);
  assert.deepEqual(system.calls, [
    "launchctl bootout gui/501/entail",
    "launchctl enable gui/501/entail",
    `launchctl bootstrap gui/501 ${definition.path}`,
  ]);
});

test("a failed bootstrap on macOS removes the agent again", async (t) => {
  const home = tempHome(t);
  const definition = serviceDefinition(inputs(home, "darwin"));
  const system = fakeSystem({
    results: { [`launchctl bootstrap gui/501 ${definition.path}`]: { status: 5, output: "Input/output error" } },
  });
  await assert.rejects(installService(inputs(home, "darwin"), system), /bootstrap gui\/501 .* failed: Input\/output error/);
  assert.ok(!existsSync(definition.path));
});

test("uninstalling on macOS boots the agent out and removes it", async (t) => {
  const home = tempHome(t);
  await installService(inputs(home, "darwin"), fakeSystem());
  const system = fakeSystem();
  const { definition, removed } = uninstallService(inputs(home, "darwin"), system);
  assert.equal(removed, true);
  assert.ok(!existsSync(definition.path));
  assert.deepEqual(system.calls, ["launchctl bootout gui/501/entail"]);
});

/** A bin directory whose `systemctl` and `launchctl` log their arguments and succeed. */
function fakeServiceManagers(dir: string): { bin: string; log: string } {
  const bin = join(dir, "bin");
  const log = join(dir, "calls.log");
  mkdirSync(bin);
  for (const name of ["systemctl", "launchctl"]) {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> "${log}"\n`);
    chmodSync(path, 0o755);
  }
  return { bin, log };
}

test("entail service install and uninstall drive this platform's service manager", (t) => {
  if (process.platform !== "linux" && process.platform !== "darwin") return t.skip("unsupported platform");
  const dir = tempHome(t);
  const { bin, log } = fakeServiceManagers(dir);
  const home = join(dir, "home");
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_DATA_HOME: join(dir, "data"),
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
  };
  const definition = serviceDefinition({
    platform: process.platform,
    env,
    home,
    uid: process.getuid?.() ?? 0,
    node: process.execPath,
    cli: CLI,
  });

  const install = spawnSync(process.execPath, [CLI, "service", "install"], { env, encoding: "utf8" });
  assert.equal(install.status, 0, install.stderr);
  assert.match(install.stdout, /Installed the entail service/);
  assert.equal(readFileSync(definition.path, "utf8"), definition.content);
  if (definition.manager === "systemd") {
    assert.ok(definition.content.includes(`Environment="XDG_DATA_HOME=${join(dir, "data")}"`));
  }

  const status = spawnSync(process.execPath, [CLI, "service", "status"], { env, encoding: "utf8" });
  assert.equal(status.status, 0, status.stderr);
  if (definition.manager === "systemd") assert.match(status.stdout, /The entail service is installed \(systemd, .*\), starts at login, and is running\./u);

  const uninstall = spawnSync(process.execPath, [CLI, "service", "uninstall"], { env, encoding: "utf8" });
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.match(uninstall.stdout, /Stopped and removed the entail service/);
  assert.ok(!existsSync(definition.path));

  const again = spawnSync(process.execPath, [CLI, "service", "uninstall"], { env, encoding: "utf8" });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /not installed/);

  const calls = readFileSync(log, "utf8");
  assert.match(calls, definition.manager === "systemd" ? /systemctl --user enable --now entail\.service/ : /launchctl bootstrap gui\//);
});

test("entail service with an unknown action exits non-zero with usage", () => {
  const result = spawnSync(process.execPath, [CLI, "service", "restart"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /service takes install, uninstall or status/);
});

test("status on Linux reads whether the unit is installed, enabled and active, and who holds the lock", async (t) => {
  const home = tempHome(t);
  assert.deepEqual(
    (({ installed, active, enabled, running }) => ({ installed, active, enabled, running }))(serviceStatus(inputs(home, "linux"), fakeSystem())),
    { installed: false, active: false, enabled: false, running: null },
    "nothing is asked of systemd when no unit is installed",
  );
  await installService(inputs(home, "linux"), fakeSystem());
  const holder = { pid: 4242, startedAt: "2026-11-13T09:00:00.000Z" };
  const up = fakeSystem({ running: () => holder });
  const status = serviceStatus(inputs(home, "linux"), up);
  assert.deepEqual([status.installed, status.active, status.enabled, status.running], [true, true, true, holder]);
  assert.deepEqual(up.calls, ["systemctl --user is-active --quiet entail.service", "systemctl --user is-enabled --quiet entail.service"]);
  const down = serviceStatus(inputs(home, "linux"), fakeSystem({ results: { "systemctl --user is-active --quiet entail.service": { status: 3, output: "" } } }));
  assert.deepEqual([down.installed, down.active, down.enabled], [true, false, true]);
});

test("status on macOS reads the agent's state from launchctl", async (t) => {
  const home = tempHome(t);
  await installService(inputs(home, "darwin"), fakeSystem());
  const running = serviceStatus(inputs(home, "darwin"), fakeSystem({ results: { "launchctl print gui/501/entail": { status: 0, output: "gui/501/entail = {\n\tstate = running\n\tpid = 77\n}" } } }));
  assert.deepEqual([running.installed, running.active, running.enabled], [true, true, true]);
  const unloaded = serviceStatus(inputs(home, "darwin"), fakeSystem({ results: { "launchctl print gui/501/entail": { status: 113, output: "Could not find service" } } }));
  assert.deepEqual([unloaded.installed, unloaded.active, unloaded.enabled], [true, false, false]);
});
