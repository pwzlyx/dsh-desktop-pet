// Headless integration test for the v0.4.0 Node half (no real Electron).
// Fake webServer collects registrations; we then drive the handlers directly.
process.env.DSH_HOME = "/tmp/dsh-test-none"; // keep the binary probe away from the real profile
import { apply } from "./lib/index.js";

const registrations = [];
const fakeCtx = {
  logger: { warn: (m) => console.log("[warn]", m) },
  effect: (fn, label) => {
    registrations.push({ label });
    const r = fn();
    return typeof r === "function" ? r : () => {};
  },
  webServer: {
    register: ({ kind, path, handler }) => {
      registrations.push({ kind, path, handler });
      return () => {};
    },
  },
};

apply(fakeCtx, { quota: { apiKey: "test-key", type: 1 } });

const routes = registrations.filter((r) => r.path);
console.log("routes registered:", routes.map((r) => r.path).join(", "));

const floatRoute = routes.find((r) => r.path === "/pet/float");
const quotaRoute = routes.find((r) => r.path === "/pet/quota");

function fakeRes() {
  const r = { status: 0, headers: null, body: "", ended: false };
  r.writeHead = (status, headers) => { r.status = status; r.headers = headers; };
  r.end = (chunk) => { if (chunk) r.body += chunk; r.ended = true; };
  return r;
}

// 1. float.html serves the polling page (no BroadcastChannel anymore)
{
  const res = fakeRes();
  floatRoute.handler({ url: "/pet/float/page", method: "GET", headers: {} }, res);
  const page = res.body;
  // regression guards for the v0.4.1/v0.4.2/v0.5 bugs:
  //  - ✕ + panel must be in the no-drag rule (drag regions swallow clicks on macOS)
  //  - full parity panel must exist (sessions/tools/goal/todos sections + open route)
  //  - v0.6.5: card is transparent, content sits on the .dpet-sheet glass card
  const noDrag = (/[^{}]+\{\s*-webkit-app-region:no-drag\s*\}/.exec(page) || [""])[0];
  const ok = res.status === 200 && page.includes("/pet/float/live") && page.includes("/pet/float/prompt") && page.includes("/pet/float/open") && !page.includes("BroadcastChannel")
    && noDrag.includes(".dpet-x") && noDrag.includes(".dpet-panel") && page.includes(".dpet-panel")
    && page.includes(".dpet-sheet") && page.includes("rgba(24,29,42,.88)") && !page.includes("#1e2433");
  console.log("float page (non-.html path) serves v0.5+ page:", ok ? "PASS" : "FAIL", `(${res.status}, ${page.length} bytes)`);
  // v0.6: target select must exist AND sit in the no-drag rule; hover-detail pop markup present
  const ok06 = noDrag.includes(".dpet-target") && page.includes('id="target"') && page.includes("dpet-tlabel")
    && page.includes("dp-txt") && page.includes("mouseover");
  console.log("v0.6 target select + hover-detail pop present:", ok06 ? "PASS" : "FAIL");
}

// 2. toggle rejects gracefully with no Electron binary available
{
  const res = fakeRes();
  floatRoute.handler({ url: "/pet/float/toggle", method: "POST", headers: { host: "127.0.0.1:19387" } }, res);
  await new Promise((r) => setTimeout(r, 50));
  const j = JSON.parse(res.body);
  const ok = res.status === 503 && j.ok === false && /Electron binary/.test(j.error);
  console.log("toggle without binary:", ok ? "PASS" : "FAIL", JSON.stringify(j));
}

// 3. toggle requires POST
{
  const res = fakeRes();
  floatRoute.handler({ url: "/pet/float/toggle", method: "GET", headers: {} }, res);
  const ok = res.status === 405;
  console.log("toggle POST-only:", ok ? "PASS" : "FAIL", `(${res.status})`);
}

// 4. publish + live relay: state persists; img included only on hash mismatch
{
  const payload = { status: "working", imgSrc: "data:image/png;base64,AAAA", line: "hi", quota: { windows: [{ label: "5h", pct: 42 }] }, sessionId: "s1", panel: { tools: [{ name: "bash", summary: "ls" }], running: [{ id: "s1", label: "主会话" }], waiting: [], completed: [], jobCount: 1, todos: { done: 1, total: 3, now: "写文档" }, current: "s1", details: { s1: { prompt: "帮我修 bug", output: "正在改…", live: true } } } };
  const fakeReq = { url: "/pet/float/publish", method: "POST", headers: {}, on: (ev, fn) => { if (ev === "data") fn(Buffer.from(JSON.stringify(payload))); else if (ev === "end") fn(); } };
  const res1 = fakeRes();
  floatRoute.handler(fakeReq, res1);
  await new Promise((r) => setTimeout(r, 20));
  const ok1 = res1.status === 200 && JSON.parse(res1.body).ok === true;
  console.log("publish accepts state:", ok1 ? "PASS" : "FAIL", res1.body);

  const { createHash } = await import("node:crypto");
  const hash = createHash("sha1").update("data:image/png;base64,AAAA").digest("hex").slice(0, 12);
  // live with stale hash → includes imgSrc + the full panel projection
  const res2 = fakeRes();
  floatRoute.handler({ url: `/pet/float/live?img=stale`, method: "GET", headers: {} }, res2);
  const j2 = JSON.parse(res2.body);
  const ok2 = j2.ok && j2.line === "hi" && j2.imgSrc === payload.imgSrc && j2.imgHash === hash
    && j2.panel && j2.panel.tools[0].name === "bash" && j2.panel.running[0].id === "s1" && j2.panel.jobCount === 1 && j2.panel.todos.total === 3;
  console.log("live includes art + panel on stale hash:", ok2 ? "PASS" : "FAIL", JSON.stringify(j2).slice(0, 80));
  const ok06b = j2.panel && j2.panel.current === "s1" && j2.panel.details && j2.panel.details.s1.prompt === "帮我修 bug" && j2.panel.details.s1.live === true;
  console.log("v0.6 panel carries current + hover details:", ok06b ? "PASS" : "FAIL");

  // live with current hash → no imgSrc
  const res3 = fakeRes();
  floatRoute.handler({ url: `/pet/float/live?img=${hash}`, method: "GET", headers: {} }, res3);
  const j3 = JSON.parse(res3.body);
  const ok3 = j3.ok && j3.imgSrc === undefined && j3.status === "working";
  console.log("live omits art on fresh hash:", ok3 ? "PASS" : "FAIL");
}

// 4b. session jump: float page POSTs /pet/float/open; the GUI drains it via GET /pet/float/prompt
{
  const fakeReq = (body) => ({ url: "/pet/float/open", method: "POST", headers: {}, on: (ev, fn) => { if (ev === "data") fn(Buffer.from(body)); else if (ev === "end") fn(); } });
  const ro = fakeRes();
  floatRoute.handler(fakeReq(JSON.stringify({ sessionId: "s9" })), ro);
  await new Promise((r) => setTimeout(r, 20));
  const oko = ro.status === 200 && JSON.parse(ro.body).ok === true;
  console.log("open enqueued:", oko ? "PASS" : "FAIL", ro.body);

  const rd = fakeRes();
  floatRoute.handler({ url: "/pet/float/prompt", method: "GET", headers: {} }, rd);
  const jd = JSON.parse(rd.body);
  const okd = jd.ok && Array.isArray(jd.opens) && jd.opens.length === 1 && jd.opens[0].sessionId === "s9";
  console.log("open drained by GUI:", okd ? "PASS" : "FAIL", JSON.stringify(jd));

  const re = fakeRes();
  floatRoute.handler(fakeReq(JSON.stringify({})), re);
  await new Promise((r) => setTimeout(r, 20));
  const oke = re.status === 400;
  console.log("open without sessionId rejected:", oke ? "PASS" : "FAIL", `(${re.status})`);
}

// 5. prompt queue: POST then drained by GET; collapse flag consumed once
{
  const fakeReq = (body) => ({ url: "/pet/float/prompt", method: "POST", headers: {}, on: (ev, fn) => { if (ev === "data") fn(Buffer.from(body)); else if (ev === "end") fn(); } });
  const rp = fakeRes();
  floatRoute.handler(fakeReq(JSON.stringify({ text: "你好", sessionId: "s1" })), rp);
  await new Promise((r) => setTimeout(r, 20));
  const okp = rp.status === 200 && JSON.parse(rp.body).ok === true;
  console.log("prompt enqueued:", okp ? "PASS" : "FAIL", rp.body);

  const rd = fakeRes();
  floatRoute.handler({ url: "/pet/float/prompt", method: "GET", headers: {} }, rd);
  const jd = JSON.parse(rd.body);
  const okd = jd.ok && jd.prompts.length === 1 && jd.prompts[0].text === "你好" && jd.prompts[0].sessionId === "s1" && jd.collapse === false;
  console.log("prompt drained by GUI:", okd ? "PASS" : "FAIL", JSON.stringify(jd));

  // collapse: POST sets flag; GET consumes it once
  const rc = fakeRes();
  floatRoute.handler({ url: "/pet/float/collapse", method: "POST", headers: {} }, rc);
  await new Promise((r) => setTimeout(r, 10));
  const okc = rc.status === 200;
  const rd2 = fakeRes();
  floatRoute.handler({ url: "/pet/float/prompt", method: "GET", headers: {} }, rd2);
  const jd2 = JSON.parse(rd2.body);
  const okc2 = jd2.collapse === true && jd2.prompts.length === 0;
  const rd3 = fakeRes();
  floatRoute.handler({ url: "/pet/float/prompt", method: "GET", headers: {} }, rd3);
  const jd3 = JSON.parse(rd3.body);
  const okc3 = jd3.collapse === false;
  console.log("collapse flag one-shot:", okc && okc2 && okc3 ? "PASS" : "FAIL");
}

// 6. state endpoint (no binary, no child)
{
  const res = fakeRes();
  floatRoute.handler({ url: "/pet/float/state", method: "GET", headers: {} }, res);
  await new Promise((r) => setTimeout(r, 50));
  const j = JSON.parse(res.body);
  const ok = res.status === 200 && j.ok === true && j.electron === false && j.visible === false;
  console.log("state endpoint:", ok ? "PASS" : "FAIL", JSON.stringify(j));
}

// 7. unknown subroute
{
  const res = fakeRes();
  floatRoute.handler({ url: "/pet/float/nope", method: "GET", headers: {} }, res);
  const ok = res.status === 404;
  console.log("unknown subroute 404:", ok ? "PASS" : "FAIL");
}

// 8. quota route exists (regression)
{
  const ok = !!quotaRoute;
  console.log("quota route still registered:", ok ? "PASS" : "FAIL");
}

console.log("DONE");
process.exit(0);
