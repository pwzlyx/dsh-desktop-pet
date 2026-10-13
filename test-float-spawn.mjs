// End-to-end smoke test for the v0.4.0 spawned float window.
// Boots a stub backend serving /pet/float/page + /pet/float/live, spawns the
// REAL profile Electron binary on lib/float-app, and asserts:
//   ready event on stdout → page fetched the HTML → polls live → stdin
//   hide keeps it alive → quit terminates cleanly.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(os.homedir(), ".dsh/profiles/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const FLOAT_HTML = readFileSync(path.join(ROOT, "lib/float.html"), "utf8");

let liveHits = 0;
const server = createServer((req, res) => {
  const u = new URL(req.url || "/", "http://localhost");
  if (u.pathname === "/pet/float/page") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(FLOAT_HTML);
  } else if (u.pathname === "/pet/float/live") {
    liveHits++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, status: "idle", line: "冒烟测试", imgHash: "", quota: { level: "pro", windows: [{ label: "5h", pct: 10 }] } }));
  } else if (u.pathname === "/pet/float/prompt") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } else {
    res.writeHead(404); res.end("{}");
  }
});

const timer = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => { console.error("SPAWN TEST FAIL:", msg); process.exit(1); };

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
console.log("stub backend on", port);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // critical: the harness sets this for its own children
const child = spawn(BIN, [path.join(ROOT, "lib/float-app"), `--backend=http://127.0.0.1:${port}`], { env, stdio: ["pipe", "pipe", "pipe"] });

let outBuf = "", ready = false;
const t0 = Date.now();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (d) => {
  outBuf += d;
  for (const line of outBuf.split("\n")) {
    if (line.includes('"event":"ready"')) ready = true;
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => process.stderr.write("[float-stderr] " + d));

// wait up to 25s for ready
while (!ready && Date.now() - t0 < 25000) await timer(250);
if (!ready) fail(`no ready event in 25s (stdout=${JSON.stringify(outBuf.slice(0, 400))})`);
console.log("ready event: PASS");

// page should load HTML and start polling live
await timer(2500);
const htmlServed = liveHits > 0;
if (!htmlServed) fail("float page never polled /pet/float/live");
console.log(`live polls: PASS (${liveHits} hits)`);

// stdin control: hide keeps process alive
child.stdin.write(JSON.stringify({ cmd: "hide" }) + "\n");
await timer(1500);
if (child.exitCode !== null) fail(`died after hide (code ${child.exitCode})`);
console.log("stdin hide keeps alive: PASS");

// quit terminates
child.stdin.write(JSON.stringify({ cmd: "quit" }) + "\n");
const exited = await new Promise((resolve) => {
  const t = setTimeout(() => resolve(false), 8000);
  child.on("exit", (code) => { clearTimeout(t); resolve(true); console.log("exit code:", code); });
});
if (!exited) { child.kill("SIGKILL"); fail("did not exit after quit"); }
console.log("stdin quit: PASS");

server.close();
console.log("SPAWN TEST DONE");
process.exit(0);
