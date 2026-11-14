const { contextBridge, ipcRenderer } = require("electron");
const actions = ["state", "initial", "panel-size", "hide", "settings", "scan", "login", "site", "candidate", "import", "visible", "rename", "switch", "record", "snapshot", "refresh", "power"];
contextBridge.exposeInMainWorld("boardAPI", {
  invoke: (action, ...params) => {
    if (!actions.includes(action)) throw new Error("未知操作");
    return ipcRenderer.invoke(action, ...params);
  },
  onState: (callback) => ipcRenderer.on("board-state", (_event, state) => callback(state)),
  onNavigate: (callback) => ipcRenderer.on("navigate", (_event, route) => callback(route)),
});
