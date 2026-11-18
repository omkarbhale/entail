// Retakes the board screenshots in docs/screenshots/ from a real `entail run`
// against demo data (see README.md here). Needs a built checkout
// (`npm run build`) and Chromium or Chrome; adds no dependency. From
// entail's checkout:
//   node docs/screenshots/take.mjs
// CHROME=<path> picks the browser, PORT=<n> the board's port (default 4391).
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { lookup } from "node:dns/promises";

const out = dirname(fileURLToPath(import.meta.url));
const root = join(out, "..", "..");
const port = Number(process.env.PORT ?? 4391);
const board = `http://127.0.0.1:${port}/`;
const call = "https://github.com/omkarbhale/entail/issues/203#issuecomment-6971185621";
const browser = process.env.CHROME ?? findBrowser();
// Under $HOME, not /tmp: a snap-packaged Chromium cannot read or write there.
const work = mkdtempSync(join(homedir(), "entail-screenshots-"));
const children = [];
// Stop entail and the browser, wait for them to exit so the browser is done
// writing its profile, then remove the temporary directory.
const stop = async (code) => {
  await Promise.all(children.map((child) => child.exitCode === null && new Promise((done) => child.once("exit", done).kill())));
  rmSync(work, { recursive: true, force: true, maxRetries: 5 });
  process.exit(code);
};
process.on("SIGINT", () => stop(130));
for (const event of ["uncaughtException", "unhandledRejection"]) {
  process.on(event, (error) => {
    console.error(error);
    stop(1);
  });
}

function findBrowser() {
  for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    try {
      return execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
    } catch {}
  }
  throw new Error("no Chromium or Chrome found; set CHROME=<path>");
}

// Stand-ins for gh, glab and claude: entail reaches no forge and runs no
// model, so the run posts nothing and the demo data is all the board shows.
// They wait out the screenshots rather than fail, so the board shows a pass
// under way instead of a failing repo.
const bin = join(work, "bin");
const data = join(work, "data");
mkdirSync(bin, { recursive: true });
for (const tool of ["gh", "glab", "claude"]) {
  writeFileSync(join(bin, tool), "#!/bin/sh\nexec sleep 60\n");
  chmodSync(join(bin, tool), 0o755);
}
execFileSync(process.execPath, [join(out, "demo-data.mjs"), join(data, "entail")]);

const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_DATA_HOME: data };
children.push(spawn(process.execPath, [join(root, "dist", "cli.js"), "run", "--port", String(port), "--interval", "3600"], { env, stdio: "ignore" }));
await until(async () => (await fetch(`${board}api/status`)).ok, "entail run to answer");

// Resolve GitHub's hosts here and hand them to the browser: a sandboxed
// Chromium (snap, WSL) cannot always resolve names itself.
const hosts = ["github.com", "github.githubassets.com", "avatars.githubusercontent.com"];
const rules = (await Promise.all(hosts.map((host) => lookup(host, { family: 4 }).then(({ address }) => `MAP ${host} ${address}`, () => null)))).filter(Boolean).join(",");
const profile = join(work, "profile");
children.push(
  spawn(browser, ["--headless", "--disable-gpu", `--host-resolver-rules=${rules}`, "--hide-scrollbars", "--no-first-run", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], {
    stdio: "ignore",
  }),
);
const portFile = join(profile, "DevToolsActivePort");
await until(() => existsSync(portFile) && readFileSync(portFile, "utf8").includes("\n"), "the browser to start");
const [debugPort] = readFileSync(portFile, "utf8").split("\n");
const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })).json();
const cdp = await connect(target.webSocketDebuggerUrl);

await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
await cdp("Page.enable");
await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem("entail.theme", "light")` });
for (const page of ["waiting", "log", "repos"]) {
  await cdp("Page.navigate", { url: `${board}#/${page}` });
  await sleep(2500);
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  const { result: size } = await cdp("Runtime.evaluate", { returnByValue: true, expression: "Math.ceil(document.documentElement.scrollHeight)" });
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: Math.max(800, size.value), deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  const { data: png } = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(out, `${page}.png`), Buffer.from(png, "base64"));
  console.log(`wrote ${join(out, `${page}.png`)}`);
}

// One posted call: entail's go on the public issue #203, as a signed-out
// reader sees it on GitHub, cropped to the comment.
await cdp("Page.navigate", { url: call });
await sleep(12000);
const { result } = await cdp("Runtime.evaluate", {
  returnByValue: true,
  expression: `(() => {
    const id = ${JSON.stringify(call.split("#")[1])};
    const anchor = document.getElementById(id);
    if (!anchor) return { missing: document.title + ": " + document.body.innerText.slice(0, 200) };
    // The id marks the comment's header; its comment is the nearest ancestor holding the body too.
    let comment = anchor;
    while (comment.parentElement && comment.getBoundingClientRect().height < anchor.getBoundingClientRect().height + 60) comment = comment.parentElement;
    const box = comment.getBoundingClientRect();
    return { x: box.left + scrollX, y: box.top + scrollY, width: box.width, height: box.height };
  })()`,
});
const clip = result.value;
if (!clip?.width) throw new Error(`no comment to crop on ${call}: ${JSON.stringify(clip)}`);
const { data: callPng } = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...clip, x: clip.x - 8, y: clip.y - 8, width: clip.width + 16, height: clip.height + 16, scale: 1 } });
writeFileSync(join(out, "call.png"), Buffer.from(callPng, "base64"));
console.log(`wrote ${join(out, "call.png")}`);
await stop(0);

async function until(ready, what) {
  for (let i = 0; i < 100; i++) {
    try {
      if (await ready()) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
    else waiter.resolve(message.result);
  };
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { method, resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
}
