// Simulate the web-GUI renderer loading lib/client.js: ModuleLoader + fake
// React (stateful hooks keyed per component fn) + browser-global stubs.
// v0.7 semantics: PetOverlay is a HEADLESS controller (renders null), the
// in-app UI is the 🐳 dock button from EnrichBridge, panel data leaves via
// POST /pet/float/publish, and Alt+Shift+W / button both hit /pet/float/toggle.
import { readFileSync } from "node:fs";

const code = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");

const errors = [];

// ── fake React with per-component hook store ───────────────────────────
const hookStore = new Map(); // component fn -> [values]
const setHookStore = () => { hookStore.clear(); };
let currentComp = null;
let compIdx = 0;
const enterComp = (fn) => { currentComp = fn; compIdx = 0; };
const React = {
  useState(v) {
    const fn = currentComp;
    if (!hookStore.has(fn)) hookStore.set(fn, []);
    const arr = hookStore.get(fn);
    if (compIdx >= arr.length) arr[compIdx] = typeof v === "function" ? v() : v;
    const i = compIdx++;
    const set = (nv) => { arr[i] = typeof nv === "function" ? nv(arr[i]) : nv; };
    return [arr[i], set];
  },
  useRef(v) { return { current: v }; },
  useEffect(fn) {
    try { const r = fn(); if (typeof r === "function") r(); }
    catch (e) { errors.push("useEffect: " + (e && e.stack || e)); }
  },
  useCallback(fn) { return fn; },
  useMemo(fn) { return fn(); },
  useSyncExternalStore(subscribe, getSnapshot) {
    try { if (typeof subscribe === "function") { const stop = subscribe(() => {}); if (typeof stop === "function") stop(); } }
    catch (e) { errors.push("useSyncExternalStore.subscribe: " + (e && e.stack || e)); }
    return getSnapshot();
  },
};
const jsx = (t, p) => ({ type: t, props: p });
const jsxs = jsx;
const require = (name) => {
  if (name === "react") return React;
  if (name === "react/jsx-runtime") return { jsx, jsxs };
  throw new Error("unexpected require: " + name);
};

// ── browser-global stubs (fetch capture + keydown capture) ─────────────
const storage = new Map();
const localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};
const keydownHandlers = [];
const document = {
  querySelector: () => null,
  addEventListener: (ev, fn) => { if (ev === "keydown") keydownHandlers.push(fn); },
  createElement: () => ({ dataset: {}, set textContent(v) {}, style: {}, getContext: () => ({ clearRect() {}, drawImage() {}, beginPath() {}, arc() {}, fill() {} }) }),
  head: { appendChild() {} },
  title: "",
};
const navigator = { userAgent: "Mozilla/5.0 (Macintosh) DSH/Electron/44.0.0 Chrome/134 Safari/537.36" };

const fetchLog = []; // {url, body}
const fakeFetch = async (url, opts) => {
  const body = opts && opts.body ? String(opts.body) : null;
  fetchLog.push({ url: String(url), body });
  let json;
  if (String(url).includes("/pet/float/toggle")) json = { ok: true, visible: true };
  else if (String(url).includes("/pet/float/")) json = { ok: true };
  else json = { ok: true, provider: "zai-coding-cn", intervalSeconds: 300, snapshot: { windows: [], level: "pro", fetchedAt: 1 } };
  return { status: 200, json: async () => json };
};
class Notification {
  static permission = "denied";
  static requestPermission() { return Promise.resolve("denied"); }
}
class Audio { play() { return Promise.resolve(); } pause() {} }

// ── ModuleLoader stub ───────────────────────────────────────────────────
const factories = {};
const window = {
  __ModuleLoader__: { load: ({ id, factory }) => { factories[id] = factory; } },
};

// ── run the module body ─────────────────────────────────────────────────
const fn = new Function("window", "document", "navigator", "localStorage", "fetch", "Notification", "Audio", code);
try { fn(window, document, navigator, localStorage, fakeFetch, Notification, Audio); }
catch (e) { console.log("MODULE BODY THREW:\n", e && e.stack || e); process.exit(1); }
console.log("module body: OK; registered:", Object.keys(factories).join(", "));

// ── materialize (run the factory) ───────────────────────────────────────
const factory = factories["@zengleiyixiao/dsh-desktop-pet"];
let exports_;
try { exports_ = factory(require); }
catch (e) { console.log("FACTORY THREW:\n", e && e.stack || e); process.exit(1); }
console.log("factory: OK; inject =", JSON.stringify(exports_.inject));

// ── apply(ctx) ──────────────────────────────────────────────────────────
const registered = [];
const comps = {};
const fakeCtx = {
  slots: {
    inject: (slot, cb) => { registered.push(slot); cb(); },
    register: (opts, comp) => { comps[opts.id] = comp; registered.push("  -> " + opts.id); return { opts, comp }; },
  },
  sessions: { open() {}, binding() { return { session: { prompt() {}, command() {} } }; } },
  uiConversation: {
    binding(id) {
      if (id !== "s1") return null;
      const snap = {
        order: ["n1", "n2", "n3"],
        nodes: {
          get(k) {
            if (k === "n1") return { kind: "user", data: { content: [{ type: "text", text: "chat 源的最近提示词" }] } };
            if (k === "n2") return { kind: "assistant-step", data: { blocks: [{ kind: "reasoning", text: "思考…" }, { kind: "text", text: "chat 源的当前输出" }] } };
            return { kind: "turn-tail" };
          },
        },
      };
      return { target(t) { return { getSnapshot: () => snap, subscribe() { return () => {}; } }; } };
    },
  },
};
try { exports_.apply(fakeCtx); }
catch (e) { console.log("APPLY THREW:\n", e && e.stack || e); process.exit(1); }
console.log("apply: OK; registered slots:", registered.join(" | "));
if (keydownHandlers.length < 1) { console.log("FAIL: apply() did not register a document keydown handler"); process.exit(1); }

const PetOverlay = comps["desktop-pet"];
const EnrichBridge = comps["desktop-pet-bridge"];
if (typeof PetOverlay !== "function" || typeof EnrichBridge !== "function") { console.log("components not found"); process.exit(1); }

function mount(props) {
  enterComp(PetOverlay);
  const tree = PetOverlay(props);
  return tree;
}
const tick = () => new Promise((r) => setTimeout(r, 20));

// ── 1. headless render: PetOverlay returns null, no DOM ────────────────
setHookStore();
const props1 = {
  useSessions: (sel) => sel({ ids: ["s1"], byId: { s1: { running: false, title: "测试会话" } }, jobsBySession: {} }),
  onOpen() {}, onSend() {},
};
try {
  const tree = mount(props1);
  if (tree !== null) { console.log("FAIL: PetOverlay should render null in v0.7, got:", JSON.stringify(tree && tree.type)); process.exit(1); }
  await tick();
  console.log("v0.7 headless PetOverlay: PASS (renders null, effects clean)");
} catch (e) { console.log("PETOVERLAY RENDER THREW:\n", e && e.stack || e); process.exit(1); }

// ── 2. EnrichBridge: publishes details AND renders the 🐳 button ───────
let bridgeNode;
try {
  enterComp(EnrichBridge);
  bridgeNode = EnrichBridge({
    useSession: (sel) => sel({
      running: true,
      runningCalls: [],
      partial: { blocks: [{ kind: "text", text: "正在修复测试" }], turn: 2, step: 1 },
      nodes: [
        { kind: "user", content: [{ type: "text", text: "帮我修登录 bug" }] },
        { kind: "assistant", blocks: [{ kind: "text", text: "先看下日志" }] },
        { kind: "turn-error", turn: 1, message: "旧错误" },
      ],
    }),
    useProjection: (k) => (k === "todos" ? [] : null),
    sessionId: "s1",
  });
  const det = exports_.__testDetails && exports_.__testDetails()["s1"];
  if (!det || det.prompt !== "chat 源的最近提示词" || det.output !== "chat 源的当前输出") {
    console.log("CHAT-SOURCE EXTRACTION FAILED:", JSON.stringify(det)); process.exit(1);
  }
  if (!bridgeNode || bridgeNode.type !== "button" || bridgeNode.props.children !== "🐳") {
    console.log("FAIL: EnrichBridge should render the 🐳 button, got:", JSON.stringify(bridgeNode && bridgeNode.type)); process.exit(1);
  }
  console.log("EnrichBridge: PASS (chat-source details + 🐳 dock button)");
} catch (e) { console.log("ENRICHBRIDGE THREW:\n", e && e.stack || e); process.exit(1); }

// ── 3. publish pipeline: auto-open → panel payload via /pet/float/publish
setHookStore();
const props2 = {
  useSessions: (sel) => sel({ ids: ["s1", "s2", "s3", "s4", "s5"], byId: {
    s1: { id: "s1", running: true, title: "甲", retainedBy: { mainView: 1 } },
    s2: { id: "s2", running: true, title: "乙" },
    s3: { id: "s3", running: false, title: "丙" },
    s4: { id: "s4", blank: true },
    s5: { id: "s5", origin: "subagent", title: "子代理" },
  } }),
  useSessionStatus: (sel) => sel(new Map([["s1", { running: true, pendingInteraction: { kind: "approval" }, completionUnread: false }], ["s2", { running: true }]])),
  useWorkspaces: (sel) => sel({ items: [{ workspaceId: "w1", title: "项目A", sessionIds: ["s1", "s2"] }], archivedSessionIds: [] }),
  onOpen() {}, onSend() {},
};
{
  mount(props2);                    // initial render: pipOpen=false, auto-open fires
  await tick();                     // auto-open resolves → setPipOpen(true)
  mount(props2);                    // re-render with pipOpen=true → publish fires
  await tick();
  const pub = fetchLog.filter((c) => c.url.includes("/pet/float/publish")).pop();
  if (!pub) { console.log("FAIL: no /pet/float/publish after auto-open\n", JSON.stringify(fetchLog)); process.exit(1); }
  const payload = JSON.parse(pub.body);
  const det = payload.panel && payload.panel.details && payload.panel.details["s1"];
  if (!det || !String(det.prompt).includes("chat 源的最近提示词") || !String(det.output).includes("chat 源的当前输出") || !det.live) {
    console.log("FAIL: panel.details[s1] missing chat-source hover title:", JSON.stringify(det)); process.exit(1);
  }
  const treeJson = JSON.stringify(payload.panel.tree || []);
  const treeOk = treeJson.includes("项目A") && treeJson.includes("s1") && treeJson.includes("s2") && !treeJson.includes("子代理");
  if (!treeOk) { console.log("FAIL: panel.tree grouping wrong:", treeJson.slice(0, 400)); process.exit(1); }
  if (payload.status !== "waiting" || !payload.imgSrc) { console.log("FAIL: payload status/imgSrc wrong:", JSON.stringify({ status: payload.status })); process.exit(1); }
  const autoOpen = fetchLog.find((c) => c.url.includes("/pet/float/toggle") && c.body && c.body.includes('"show"'));
  if (!autoOpen) { console.log("FAIL: mount did not auto-open float (no {action:show} POST)"); process.exit(1); }
  console.log("v0.7 publish pipeline: PASS (auto-open show → panel details/tree/status over /pet/float/publish)");
}

// ── 4. 🐳 button + Alt+Shift+W both toggle the float ───────────────────
{
  fetchLog.length = 0;
  bridgeNode.props.onClick();
  await tick();
  const byButton = fetchLog.filter((c) => c.url.includes("/pet/float/toggle"));
  if (byButton.length !== 1) { console.log("FAIL: 🐳 click did not POST /pet/float/toggle exactly once:", JSON.stringify(fetchLog)); process.exit(1); }

  fetchLog.length = 0;
  keydownHandlers.forEach((h) => h({ altKey: true, shiftKey: true, key: "w", preventDefault() {} }));
  keydownHandlers.forEach((h) => h({ altKey: true, shiftKey: true, key: "W", preventDefault() {} }));
  await tick();
  const byKey = fetchLog.filter((c) => c.url.includes("/pet/float/toggle"));
  if (byKey.length !== 2) { console.log("FAIL: Alt+Shift+W (w and W) did not POST toggle once each:", JSON.stringify(fetchLog)); process.exit(1); }
  console.log("v0.7 toggle entrances: PASS (🐳 button + Alt+Shift+W → /pet/float/toggle)");
}

// ── report collected errors ─────────────────────────────────────────────
await new Promise((r) => setTimeout(r, 100));
if (errors.length) { console.log("EFFECT ERRORS:\n" + errors.join("\n---\n")); process.exit(1); }
console.log("ALL OK — client.js is runtime-clean in v0.7 simulation");
process.exit(0);
