// Expose a minimal, audited bridge: the float page's ✕ button hides the
// window instantly (IPC), then syncs GUI-side state via POST /pet/float/collapse.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("__petFloat", {
  hide: () => ipcRenderer.send("pet-float:hide"),
});
