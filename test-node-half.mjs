// Node-half integration test for the v0.2.0 quota route (fake webServer + fake fetch).
import { apply } from "./lib/index.js";

const realFetch = globalThis.fetch;
let calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url, headers: init.headers });
  return {
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: {
        level: "PRO",
        limits: [
          { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 100, currentValue: 40, remaining: 60, percentage: 40, nextResetTime: Date.now() + 3600e3 },
          { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 500, currentValue: 250, remaining: 250, percentage: 50, nextResetTime: Date.now() + 86400e3 },
        ],
      },
    }),
  };
};

let registered = null;
const effects = [];
const fakeCtx = {
  effect: (fn) => { effects.push(fn); },
  logger: { warn: (m) => console.log("[warn]", m) },
  webServer: { register: (r) => { registered = r; return () => {}; } },
};

apply(fakeCtx, { quota: { provider: "zai-coding-cn", apiKey: "test-key", organization: "org-1", project: "proj-1", type: 2 } });
// run deferred effects (real cordis runs them synchronously; fake stores them)
effects.forEach((fn) => fn());
if (!registered || registered.path !== "/pet/quota") throw new Error("route not registered: " + JSON.stringify(registered));

await new Promise((r) => setTimeout(r, 50));
if (calls.length !== 1) throw new Error("expected 1 fetch, got " + calls.length);
if (calls[0].headers.authorization !== "test-key") throw new Error("raw key expected, got " + calls[0].headers.authorization);
if (!String(calls[0].url).includes("type=2")) throw new Error("type param missing: " + calls[0].url);
if (calls[0].headers["bigmodel-organization"] !== "org-1") throw new Error("org header missing");

const res = { code: 0, body: "", writeHead(c) { this.code = c; }, end(b) { this.body = b; } };
registered.handler({}, res);
await new Promise((r) => setTimeout(r, 20));
const payload = JSON.parse(res.body);
console.log("route payload:", res.body);
if (payload.ok !== true || payload.provider !== "zai-coding-cn") throw new Error("payload shape wrong");
if (!payload.snapshot || payload.snapshot.windows.length !== 2) throw new Error("windows missing");
if (typeof payload.snapshot.windows[0].resetAt !== "number") throw new Error("resetAt missing");
if (JSON.stringify(payload).includes("test-key")) throw new Error("API KEY LEAKED in response");

// no-key config: nothing registers, no throw
const effects2 = [];
apply(
  { effect: (f) => effects2.push(f), logger: { warn: () => {} }, webServer: { register: () => { throw new Error("should not register"); } } },
  {}
);
console.log("no-key case: no route registered ✓");

// ── v0.7: float toggle action semantics + /pet/float/sync (fake child) ──
import { Readable } from "node:stream";
import { __testFloat } from "./lib/index.js";

// re-register the /pet/float prefix route against a capturing fake webServer
let floatRoute = null;
const effects3 = [];
apply({ effect: (f) => effects3.push(f), logger: { warn: () => {}, info: () => {} }, webServer: { register: (r) => { if (r.path === "/pet/float") floatRoute = r; return () => {}; } } }, { quota: { apiKey: "k" } });
effects3.forEach((f) => f());
if (!floatRoute) throw new Error("/pet/float route not registered");

const sends = [];
__testFloat.setFloatChild(sends);
const mkRes = () => ({ code: 0, body: "", writeHead(c) { this.code = c; }, end(b) { this.body = b; } });
const doReq = async (obj) => {
  const res = mkRes();
  const req = Readable.from([Buffer.from(JSON.stringify(obj))]);
  req.method = "POST"; req.url = "/pet/float/toggle"; req.headers = { host: "127.0.0.1:19387" };
  await floatRoute.handler(req, res);
  await new Promise((r) => setTimeout(r, 10));
  return JSON.parse(res.body);
};
// 1) show while visible → idempotent true, no stdin command
let r = await doReq({ action: "show" });
if (r.visible !== true || sends.length !== 0) throw new Error("show-on-visible should be idempotent: " + JSON.stringify(r) + JSON.stringify(sends));
// 2) hide → stdin {cmd:hide}, visible false
r = await doReq({ action: "hide" });
if (r.visible !== false || !String(sends[0]).includes('"hide"')) throw new Error("hide failed: " + JSON.stringify(r) + JSON.stringify(sends));
// 3) hide again → idempotent false, no extra command
const n = sends.length;
r = await doReq({ action: "hide" });
if (r.visible !== false || sends.length !== n) throw new Error("hide-on-hidden should be idempotent");
// 4) default toggle flips back to visible
r = await doReq({});
if (r.visible !== true || !String(sends[sends.length - 1]).includes('"show"')) throw new Error("toggle back to show failed: " + JSON.stringify(r));
// 5) /pet/float/sync records external visibility flips (global shortcut path)
const sync = async (visible) => {
  const res = mkRes();
  const req = Readable.from([Buffer.from(JSON.stringify({ visible }))]);
  req.method = "POST"; req.url = "/pet/float/sync"; req.headers = { host: "127.0.0.1:19387" };
  await floatRoute.handler(req, res);
  await new Promise((r) => setTimeout(r, 10));
  return JSON.parse(res.body);
};
r = await sync(false);
if (r.ok !== true || r.visible !== false) throw new Error("sync(false) failed: " + JSON.stringify(r));
r = await doReq({ action: "hide" }); // backend now believes hidden → idempotent
if (r.visible !== false) throw new Error("after sync(false), hide should be idempotent");
r = await sync(true);
if (r.visible !== true) throw new Error("sync(true) failed");
console.log("v0.7 float toggle/sync state machine: ✓ (show/hide/toggle idempotent + sync records external flips)");
__testFloat.reset();
console.log("NODE HALF TEST PASSED");
globalThis.fetch = realFetch;
process.exit(0); // quota poller interval keeps the loop alive; tests are done
