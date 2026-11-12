const { contextBridge, ipcRenderer } = require("electron");
const call = async (name, ...args) => {
  const result = await ipcRenderer.invoke(name, ...args);
  if (result.error) throw new Error(result.error);
  return result.data;
};
contextBridge.exposeInMainWorld("quota", {
  list: () => call("list"),
  add: (input) => call("add", input),
  remove: (id) => call("remove", id),
  record: (id, input) => call("record", id, input),
  refresh: (id) => call("refresh", id),
  openProvider: (provider) => call("open-provider", provider),
  choose: (kind) => call("choose", kind),
  floatingPreference: () => call("floating-preference"),
  selectFloating: (accountId, windowLabel) =>
    call("select-floating", accountId, windowLabel),
  toggleFloating: () => call("toggle-floating"),
  dragFloating: (phase, point) => call("drag-floating", phase, point),
  manage: () => call("manage"),
  onPreferences: (callback) =>
    ipcRenderer.on("preferences", (_event, value) => callback(value)),
  onState: (callback) =>
    ipcRenderer.on("state", (_event, state) => callback(state)),
});
