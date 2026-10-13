/**
 * Node half of the dsh-desktop-pet surface plugin.
 *
 * v0.4.0: the float window lives in its own Electron process. The desktop
 * backend host runs as an ELECTRON_RUN_AS_NODE child of the app (verified
 * live: no Electron module system, GUI APIs unreachable in-process), so the
 * window cannot be created here. Instead we spawn the standalone Electron
 * binary shipped under the profile's node_modules/electron with our own
 * mini app (lib/float-app). The float page is served from this backend
 * (same origin for it, no CORS), the GUI page relays whale state in via
 * POST /pet/float/publish, and the float page polls /pet/float/live,
 * queues prompts via POST /pet/float/prompt (drained by the GUI page),
 * and collapses via POST /pet/float/collapse. Toggle/show/hide ride a
 * newline-JSON stdin channel to the child. Web (non-Electron) hosts keep
 * the client-side Document-PiP path untouched.
 *
 * v0.2.0: GLM Coding Plan quota poller exposed at `/pet/quota` (the API key
 * never reaches the browser half).
 */
import { normalizeQuota, quotaRequest } from "./quota.js";
import { readFileSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

/** Plugin identity for cordis.yml rows. */
const name = "@zengleiyixiao/dsh-desktop-pet";

/** Services required before mounting: the host webserver. */
const inject = ["webServer"];

const DEFAULT_INTERVAL_SECONDS = 300;
const FETCH_TIMEOUT_MS = 15000;

/* ────────────────────────── quota (v0.2.0) ────────────────────────── */

/**
 * Read a credential from the DSH-managed credential file
 * (`~/.dsh/.credentials.yaml`, 0600, refs: NAME → secret). The same source the
 * LLM provider rows resolve `apiKeyEnv` from, so a key configured once in the
 * UI works here without re-entry.
 * @param {string} refName
 * @returns {string}
 */
function readDshCredential(refName) {
  try {
    const file = join(process.env.DSH_HOME || join(homedir(), ".dsh"), ".credentials.yaml");
    const text = readFileSync(file, "utf8");
    const m = text.match(new RegExp(`^\\s{2}${refName}:\\s*(\\S+)\\s*$`, "m"));
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

/**
 * Resolve the effective quota config from the plugin row config + env.
 * Priority for the API key: row config `quota.apiKey` → env ZAI_CODING_CN_API_KEY
 * (zai-coding-cn) / ZAI_API_KEY (zai) → DSH credential store.
 * @param {Record<string, unknown>=} config
 */
function resolveQuotaConfig(config) {
  const quota = (config && typeof config.quota === "object" && config.quota) || {};
  const provider = typeof quota.provider === "string" && quota.provider ? quota.provider : "zai-coding-cn";
  let apiKey = typeof quota.apiKey === "string" ? quota.apiKey.trim() : "";
  const envName = provider === "zai" ? "ZAI_API_KEY" : "ZAI_CODING_CN_API_KEY";
  if (!apiKey) apiKey = (process.env[envName] || "").trim();
  if (!apiKey) apiKey = readDshCredential(envName);
  const intervalSeconds = Math.max(30, Number(quota.intervalSeconds) || DEFAULT_INTERVAL_SECONDS);
  return {
    enabled: quota.enabled !== false,
    provider,
    apiKey,
    organization: typeof quota.organization === "string" ? quota.organization.trim() : "",
    project: typeof quota.project === "string" ? quota.project.trim() : "",
    type: quota.type ?? 2,
    intervalSeconds,
  };
}

/**
 * One outbound quota fetch → normalized snapshot, or a thrown Error with a
 * user-presentable message.
 */
async function fetchQuotaSnapshot(cfg) {
  const req = quotaRequest(cfg);
  const headers = { ...req.headers };
  headers.authorization = (req.bearer ? "Bearer " : "") + cfg.apiKey;
  const res = await fetch(req.url, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body handled below */
  }
  if (!res.ok) {
    const msg = (body && typeof body.msg === "string" && body.msg) || `HTTP ${res.status}`;
    const err = new Error(`额度接口 ${res.status}: ${msg}`);
    err.code = res.status;
    throw err;
  }
  const { windows, level } = normalizeQuota(body);
  if (windows.length === 0) {
    // bigmodel 空数据的最常见原因：缺 org/project 头（Bearer 方言）或缺 type。
    throw new Error(cfg.provider === "zai"
      ? "额度接口返回空数据（检查 API Key 是否为 Coding Plan 套餐 Key）"
      : "额度接口返回空数据：先确认 type 匹配你的套餐（1=个人 2=团队）；个人套餐常见为 1。仍为空才需补 organization/project（见 README）");
  }
  return { windows, level, fetchedAt: Date.now() };
}

/* ─────────────────── Electron float window (v0.4.0) ─────────────────── */

let floatChild = null; // spawned Electron app { proc, visible, binary } | null
let hostCtx = null;    // cordis ctx captured in apply() for logging

/** Float state relay: what the GUI page last published + prompt mailbox. */
let clientLoadedAt = 0; // v0.6.4 诊断：GUI client 半加载时间（/pet/client-loaded 上报）
const floatStore = {
  state: null,         // last /pet/float/publish payload
  imgHash: "",         // sha1(imgSrc).slice(0,12) — lets the float page skip refetching art
  pendingPrompts: [],  // { text, sessionId } queued by the float page, drained by the GUI page
  pendingOpens: [],    // { sessionId } jump-to-session requests from the float page, drained by the GUI page
  collapseFlag: false, // float page asked to collapse; the GUI page consumes it
};

let electronBinaryPromise = null;

/**
 * Resolve a runnable Electron binary path. In the desktop backend host
 * (ELECTRON_RUN_AS_NODE child) `import("electron")` resolves to the
 * profile's npm shim whose default export is exactly the standalone
 * Electron binary path. Null when nothing runnable is found (web hosts).
 * @returns {Promise<string | null>}
 */
function resolveElectronBinary() {
  if (!electronBinaryPromise) {
    electronBinaryPromise = (async () => {
      // 1) npm "electron" shim: resolves to the binary path string when the
      //    host's module graph can see the profile's node_modules.
      try {
        const ns = await import("electron");
        const p = typeof (ns && ns.default) === "string" ? ns.default : typeof ns === "string" ? ns : null;
        if (p) { try { accessSync(p, constants.X_OK); return p; } catch { /* not runnable */ } }
      } catch { /* not resolvable from here */ }
      // 2) The pnpm-linked source dir resolves "electron" from its REAL path,
      //    not the profile — so probe the profile(s) directly. The backend
      //    host is launched with the profile dir on argv; DSH_HOME overrides
      //    the default ~/.dsh.
      const roots = new Set();
      for (const a of process.argv) {
        const m = String(a).match(/^(.*\/profiles\/[^/]+)/);
        if (m) roots.add(m[1]);
      }
      const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
      for (const prof of ["desktop", "web"]) roots.add(join(dshHome, "profiles", prof));
      for (const root of roots) {
        const pkg = join(root, "node_modules", "electron");
        for (const p of [join(pkg, "path.txt"), "path.txt"]) {
          try {
            const rel = readFileSync(join(pkg, p), "utf8").trim();
            if (rel) {
              const bin = join(pkg, "dist", rel);
              try { accessSync(bin, constants.X_OK); return bin; } catch { /* keep looking */ }
            }
          } catch { /* no path.txt here */ }
        }
      }
      return null;
    })();
  }
  return electronBinaryPromise;
}

/**
 * The float page. Served from this backend, so its own fetches are
 * same-origin; the GUI page relays state in and prompts out. Kept as a
 * real .html file (no escaping games) and loaded once at module init.
 */
const FLOAT_HTML = readFileSync(new URL("./float.html", import.meta.url), "utf8");

/** Directory of the spawned float app (own package.json + main.js). */
const FLOAT_APP_DIR = fileURLToPath(new URL("./float-app/", import.meta.url));

/** Send one newline-delimited JSON command to the float child's stdin. */
function floatSend(child, cmd) {
  try { child.proc.stdin.write(JSON.stringify(cmd) + "\n"); } catch { /* stdin closed */ }
}

/** Read a request body with a size cap. @returns {Promise<string>} */
function readBody(req, capBytes = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > capBytes) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Toggle the float window: spawn the Electron float app on first call
 * (it shows itself on ready-to-show), then show/hide over stdin.
 * Returns the resulting visibility for the client half to mirror.
 * @param {import("node:http").IncomingMessage} req
 */
async function toggleFloat(req, action = "toggle") {
  if (action === "show" && floatChild && floatChild.visible) return true;   // 已显示则幂等
  if (action === "hide" && (!floatChild || !floatChild.visible)) return false; // 已隐藏则幂等
  if (!floatChild) {
    const binary = await resolveElectronBinary();
    if (!binary) {
      const err = new Error("no runnable Electron binary (expected the profile's node_modules/electron dist)");
      err.code = "NO_ELECTRON_BINARY";
      throw err;
    }
    const backend = `http://${req.headers.host || "127.0.0.1:19387"}`;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE; // the float app must be a real GUI process
    const proc = spawn(binary, [FLOAT_APP_DIR, `--backend=${backend}`], { env, stdio: ["pipe", "pipe", "pipe"] });
    floatChild = { proc, visible: true, binary };
    let logged = 0;
    proc.stderr.setEncoding("utf8").on("data", (d) => {
      if (logged++ < 20) hostCtx?.logger?.warn?.(`[float] ${d.trim()}`);
    });
    proc.stdout.setEncoding("utf8").on("data", (d) => {
      if (d.includes('"event":"ready"')) hostCtx?.logger?.info?.("[float] window ready");
    });
    proc.on("exit", (code) => {
      if (floatChild && floatChild.proc === proc) floatChild = null;
      hostCtx?.logger?.info?.(`[float] exited (${code})`);
    });
    return true;
  }
  if (action === "hide" || floatChild.visible) {
    floatChild.visible = false;
    floatSend(floatChild, { cmd: "hide" });
    return false;
  }
  floatChild.visible = true;
  floatSend(floatChild, { cmd: "show" });
  return true;
}

/* ──────────────────────────── mounting ──────────────────────────── */

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {Record<string, unknown>=} config row config (cordis passes it via
 *        ctx.config when the plugin is mounted from a patch.yml row).
 */
function apply(ctx, config) {
  hostCtx = ctx;
  const cfg = resolveQuotaConfig(config && typeof config === "object" ? config : ctx.config);

  const writeJson = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(body);
  };

  /* Float window subtree: page + relay + control. Mounted even without a
   * quota key — the whale is independent of quota. */
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: "/pet/float",
    handler: (req, res) => {
      const u = new URL(req.url || "/", "http://localhost");
      const route = u.pathname;
      // NOTE: do NOT use a ".html" suffix here — the host's static layer
      // intercepts *.html paths (dsh-web-frontend dist) before plugin prefix
      // routes and answers 404 with an empty body, which loads as a blank
      // transparent page inside the float window.
      if (route === "/pet/float/page" || route === "/pet/float") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(FLOAT_HTML);
        return;
      }
      if (route === "/pet/float/toggle") {
        if (req.method !== "POST") { writeJson(res, 405, { ok: false, error: "POST only" }); return; }
        readBody(req)
          .then((body) => {
            let j = null;
            try { j = JSON.parse(body); } catch {}
            return toggleFloat(req, j && (j.action === "show" || j.action === "hide") ? j.action : "toggle");
          })
          .then((visible) => writeJson(res, 200, { ok: true, visible }))
          .catch((e) => writeJson(res, 503, { ok: false, error: String(e && e.message ? e.message : e) }));
        return;
      }
      if (route === "/pet/float/sync") {
        if (req.method !== "POST") { writeJson(res, 405, { ok: false, error: "POST only" }); return; }
        readBody(req)
          .then((body) => {
            let j = null;
            try { j = JSON.parse(body); } catch {}
            if (floatChild) floatChild.visible = !!(j && j.visible);
            writeJson(res, 200, { ok: true, visible: !!(floatChild && floatChild.visible) });
          })
          .catch((e) => writeJson(res, 400, { ok: false, error: String(e && e.message ? e.message : e) }));
        return;
      }
      if (route === "/pet/float/publish") {
        if (req.method !== "POST") { writeJson(res, 405, { ok: false, error: "POST only" }); return; }
        readBody(req)
          .then((body) => {
            let j;
            try { j = JSON.parse(body); } catch { j = null; }
            if (!j || typeof j !== "object") { writeJson(res, 400, { ok: false, error: "bad json" }); return; }
            const prev = floatStore.state || {};
            const st = { ...prev };
            for (const k of ["status", "imgSrc", "line", "activityText", "badgeText", "quota", "sessionId", "panel"]) {
              if (j[k] !== undefined) st[k] = j[k];
            }
            floatStore.state = st;
            if (typeof st.imgSrc === "string" && st.imgSrc) {
              floatStore.imgHash = createHash("sha1").update(st.imgSrc).digest("hex").slice(0, 12);
            }
            writeJson(res, 200, { ok: true });
          })
          .catch((e) => writeJson(res, 400, { ok: false, error: String(e && e.message ? e.message : e) }));
        return;
      }
      if (route === "/pet/float/live") {
        // Same-origin for the spawned float page; include the art only when
        // the client's held hash differs, to keep polling cheap.
        const st = floatStore.state || {};
        const out = {
          ok: true,
          status: st.status, line: st.line, activityText: st.activityText,
          badgeText: st.badgeText, quota: st.quota, sessionId: st.sessionId,
          panel: st.panel || null,
          imgHash: floatStore.imgHash,
        };
        if (u.searchParams.get("img") !== floatStore.imgHash && typeof st.imgSrc === "string" && st.imgSrc) {
          out.imgSrc = st.imgSrc;
        }
        writeJson(res, 200, out);
        return;
      }
      if (route === "/pet/float/prompt") {
        if (req.method === "POST") {
          readBody(req)
            .then((body) => {
              let j;
              try { j = JSON.parse(body); } catch { j = null; }
              const text = j && typeof j.text === "string" ? j.text.trim().slice(0, 2000) : "";
              if (!text) { writeJson(res, 400, { ok: false, error: "empty text" }); return; }
              const st = floatStore.state || {};
              floatStore.pendingPrompts.push({ text, sessionId: (j && j.sessionId) || st.sessionId || null });
              if (floatStore.pendingPrompts.length > 20) floatStore.pendingPrompts.shift();
              writeJson(res, 200, { ok: true });
            })
            .catch((e) => writeJson(res, 400, { ok: false, error: String(e && e.message ? e.message : e) }));
          return;
        }
        // GET: the GUI page drains queued prompts + session jumps + the collapse flag.
        const collapse = floatStore.collapseFlag;
        floatStore.collapseFlag = false;
        writeJson(res, 200, { ok: true, prompts: floatStore.pendingPrompts.splice(0), opens: floatStore.pendingOpens.splice(0), collapse });
        return;
      }
      if (route === "/pet/float/open") {
        // The float page clicked a session row → ask the GUI to jump there.
        if (req.method !== "POST") { writeJson(res, 405, { ok: false, error: "POST only" }); return; }
        readBody(req)
          .then((body) => {
            let j;
            try { j = JSON.parse(body); } catch { j = null; }
            const sessionId = j && typeof j.sessionId === "string" ? j.sessionId : "";
            if (!sessionId) { writeJson(res, 400, { ok: false, error: "missing sessionId" }); return; }
            floatStore.pendingOpens.push({ sessionId });
            if (floatStore.pendingOpens.length > 20) floatStore.pendingOpens.shift();
            writeJson(res, 200, { ok: true });
          })
          .catch((e) => writeJson(res, 400, { ok: false, error: String(e && e.message ? e.message : e) }));
        return;
      }
      if (route === "/pet/float/collapse") {
        if (req.method !== "POST") { writeJson(res, 405, { ok: false, error: "POST only" }); return; }
        floatStore.collapseFlag = true;
        if (floatChild && floatChild.visible) {
          floatChild.visible = false;
          floatSend(floatChild, { cmd: "hide" });
        }
        writeJson(res, 200, { ok: true });
        return;
      }
      if (route === "/pet/float/state") {
        resolveElectronBinary().then((binary) => {
          writeJson(res, 200, {
            ok: true,
            electron: !!floatChild, // spawned app alive == float-capable
            binary: floatChild ? floatChild.binary : binary,
            visible: !!(floatChild && floatChild.visible),
            clientLoadedAt,
          });
        });
        return;
      }
      writeJson(res, 404, { ok: false, error: `unknown route ${route}` });
    },
  }), `${name}: /pet/float routes`);

  // Only mount the quota route when a key is resolvable; without a key the
  // client half shows setup guidance instead of polling a failing endpoint.
  if (!cfg.enabled || !cfg.apiKey) {
    ctx.logger?.warn?.("quota disabled: no API key (set quota.apiKey in the cordis.patch.yml row or export ZAI_CODING_CN_API_KEY)");
    return;
  }

  let snapshot = null;   // { windows, level, fetchedAt }
  let error = null;      // last fetch error { message, at }
  let inflight = null;

  const refresh = () => {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        snapshot = await fetchQuotaSnapshot(cfg);
        error = null;
      } catch (e) {
        error = { message: String(e && e.message ? e.message : e), at: Date.now() };
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };

  const payload = () => ({
    ok: !error,
    provider: cfg.provider,
    intervalSeconds: cfg.intervalSeconds,
    ...(snapshot ? { snapshot } : {}),
    ...(error ? { error: error.message } : {}),
  });

  // Initial fetch + background poll (disposed with the fiber).
  ctx.effect(() => {
    refresh();
    const timer = setInterval(refresh, cfg.intervalSeconds * 1000);
    return () => clearInterval(timer);
  }, `${name}: quota poller`);

  // Same-origin read endpoint for the browser half. Never echoes the key.
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: "/pet/quota",
    handler: (req, res) => {
      if (!snapshot && !error) {
        // First request before the initial fetch settles: answer once it
        // does (bounded by FETCH_TIMEOUT_MS) so the panel's first paint has
        // real data instead of an immediate "loading" round-trip.
        refresh().then(() => writeJson(res, 200, payload()));
        return;
      }
      if (snapshot && Date.now() - snapshot.fetchedAt > cfg.intervalSeconds * 1000) refresh();
      writeJson(res, 200, payload());
    },
  }), `${name}: /pet/quota route`);
}

export { apply, inject };
// test-only: drive the float show/hide state machine without spawning Electron
// (fake child captures stdin commands; toggle/sync idempotency under test).
export const __testFloat = {
  setFloatChild(sends) {
    floatChild = { proc: { stdin: { write(s) { sends.push(s); } }, on() {}, stdout: { on() {} }, stderr: { on() {} } }, visible: true, binary: "fake" };
    return floatChild;
  },
  reset() { floatChild = null; },
  floatChild: () => floatChild,
};
