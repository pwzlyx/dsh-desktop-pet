// Standalone Electron app hosting the dsh-desktop-pet float window.
//
// Spawned by the plugin's Node half (lib/index.js → toggleFloat) because the
// desktop backend host runs with ELECTRON_RUN_AS_NODE=1 and cannot create
// windows in-process. This process is a real GUI Electron app:
//   - frameless, transparent, always-on-top, all-workspaces window
//   - loads the float page from the backend (same origin for the page)
//   - controlled over stdin with newline-delimited JSON {cmd:"show"|"hide"|"quit"}
//   - reports {event:"ready"} on stdout once the window is up
const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const backend = (() => {
  const a = process.argv.find((x) => x.startsWith("--backend="));
  return a ? a.slice("--backend=".length) : "http://127.0.0.1:19387";
})();

// --diag: log window geometry + capture the page so a bash-side observer can
// see what the float window actually renders.
const DIAG = process.argv.includes("--diag");
function diag(obj) {
  if (!DIAG) return;
  try {
    process.stdout.write(JSON.stringify(Object.assign({ event: "diag" }, obj)) + "\n");
  } catch { /* stdout closed */ }
}
function diagWindow(tag) {
  if (!DIAG || !win) return;
  const b = win.getBounds();
  const d = screen.getDisplayMatching(b);
  diag({
    tag,
    bounds: b,
    visible: win.isVisible(),
    minimized: win.isMinimized(),
    alwaysOnTop: win.isAlwaysOnTop(),
    display: { id: d.id, bounds: d.bounds, primary: screen.getPrimaryDisplay().id === d.id },
    screenX: win.getPosition(),
  });
  if (win.isVisible()) {
    win.webContents.capturePage().then((img) => {
      try { fs.writeFileSync(`/tmp/floatdiag-${tag}.png`, img.toPNG()); diag({ tag, capture: "written" }); }
      catch (e) { diag({ tag, capture: String(e && e.message) }); }
    }).catch((e) => diag({ tag, capture: String(e && e.message) }));
  }
}

let win = null;

app.whenReady().then(() => {
  try { if (app.dock && typeof app.dock.hide === "function") app.dock.hide(); } catch { /* non-mac */ }
  win = new BrowserWindow({
    width: 320,
    height: 640,
    minWidth: 240,
    minHeight: 300,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setAlwaysOnTop(true, "screen-saver");
  win.once("ready-to-show", () => {
    win.show();
    process.stdout.write(JSON.stringify({ event: "ready" }) + "\n");
    diagWindow("t0");
    setTimeout(() => diagWindow("t2s"), 2000);
    setTimeout(() => diagWindow("t5s"), 5000);
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    process.stderr.write(`did-fail-load ${code} ${desc} ${url}\n`);
  });
  win.on("closed", () => { win = null; app.quit(); });
  ipcMain.on("pet-float:hide", () => { if (win) { win.hide(); syncVisible(false); } });
  // v0.7：本进程隐藏浮窗（Esc）后告知后端，保持 /pet/float/state 的 visible 真实，
  // 否则后端 toggle 会拿到过期状态、二次点击不翻转。
  function syncVisible(v) {
    try {
      fetch(`${backend}/pet/float/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visible: !!v }),
      }).catch(() => {});
    } catch { /* fetch unavailable? ignore */ }
  }
  // v0.7：系统级快捷键 Alt+Shift+W——任何应用在前台都能唤起/隐藏鲸鱼娘。
  // 与 App 内快捷键、🐳 按钮同效；本地翻转后同样回写后端。
  try {
    const ok = globalShortcut.register("Alt+Shift+W", () => {
      if (!win) return;
      if (win.isVisible()) win.hide();
      else win.show();
      syncVisible(win.isVisible());
    });
    if (!ok) process.stderr.write("globalShortcut Alt+Shift+W registration failed\n");
  } catch (e) {
    process.stderr.write(`globalShortcut error: ${e && e.message}\n`);
  }
  app.on("will-quit", () => { try { globalShortcut.unregisterAll(); } catch { /* noop */ } });
  // "/pet/float/page" (not .html): the host static layer owns *.html paths.
  win.loadURL(`${backend}/pet/float/page`).catch((e) => {
    process.stderr.write(`loadURL failed: ${e && e.message}\n`);
    app.quit();
  });
});

// stdin control channel: newline-delimited JSON commands from the backend.
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let cmd;
    try { cmd = JSON.parse(line); } catch { continue; }
    if (!win) continue;
    if (cmd.cmd === "show") win.show();
    else if (cmd.cmd === "hide") win.hide();
    else if (cmd.cmd === "quit") app.quit();
  }
});
process.stdin.on("end", () => app.quit());
process.on("uncaughtException", (e) => {
  process.stderr.write(`uncaught: ${e && e.stack}\n`);
  app.quit();
});
