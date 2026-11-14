import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog, shell, screen } from "electron";
import { mkdir, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { queries } from "../core/adapters.js";
import { validateSnapshot } from "../core/model.js";
import { serviceIds, services } from "../core/services.js";
import { Store } from "../core/store.js";

const directory = fileURLToPath(new URL(".", import.meta.url));
app.setName("Quota Board");
const test = !app.isPackaged && process.env.QUOTA_BOARD_TEST_DATA_DIR;
if (test) app.setPath("userData", test);
const store = new Store(app.getPath("userData"));
const profileRoot = join(store.directory, "profiles");
let board, settings, tray, refreshing;
const accountById = (id) => store.state.accounts.find((account) => account.id === id);
const activeAccount = (provider) => accountById(store.state.active[provider]) ||
  store.state.accounts.find((account) => account.provider === provider);
const checkedService = (provider) => {
  if (!serviceIds.includes(provider)) throw new Error("无效的平台");
  return services[provider];
};

function makeWindow(options, surface) {
  const window = new BrowserWindow({
    show: false, autoHideMenuBar: true, backgroundColor: "#f9fafc",
    ...options,
    webPreferences: { preload: join(directory, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.loadFile(join(directory, "index.html"), { query: { surface } });
  return window;
}

function placeBoard(width, height) {
  if (!board || board.isDestroyed()) return;
  const anchor = tray?.getBounds();
  const display = anchor?.width ? screen.getDisplayMatching(anchor) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const work = display.workArea;
  const w = Math.min(width, work.width - 16);
  const h = Math.min(height, work.height - 16);
  const right = anchor?.width ? anchor.x + anchor.width / 2 + w / 2 : work.x + work.width;
  const x = Math.round(Math.max(work.x + 8, Math.min(right - w, work.x + work.width - w - 8)));
  const below = anchor?.width && anchor.y < work.y + work.height / 2;
  const y = below ? Math.max(work.y + 8, anchor.y + anchor.height + 6) : work.y + work.height - h - 8;
  board.setBounds({ x, y, width: w, height: h });
}

function openBoard() {
  if (!store.state.configured) return openSettings({ mode: "setup" });
  if (!board) {
    board = makeWindow({ width: 450, height: 260, frame: false, skipTaskbar: true, resizable: false, alwaysOnTop: true, roundedCorners: true, fullscreenable: false }, "board");
    board.on("blur", () => { if (!test) board?.hide(); });
    board.on("closed", () => { board = undefined; });
    board.once("ready-to-show", () => { board?.show(); });
    placeBoard(450, 260);
  } else {
    board.show();
  }
}

function openSettings(initial = {}) {
  if (!settings) {
    settings = makeWindow({ width: 840, height: 540, minWidth: 650, minHeight: 440, title: "额度看板 · 设置", icon: join(directory, "tray.ico") }, "settings");
    settings.initial = initial;
    settings.once("ready-to-show", () => settings?.show());
    settings.on("closed", () => { settings = undefined; });
  } else {
    settings.webContents.send("navigate", initial);
    settings.show();
  }
}

function publish() {
  for (const window of [board, settings]) window?.webContents.send("board-state", currentState());
}

function currentState() {
  const state = store.publicState();
  return { ...state, refreshing: Boolean(refreshing), active: Object.fromEntries(
    serviceIds.map((provider) => [provider, activeAccount(provider)?.id])
  ) };
}

async function candidates(providers) {
  if (!Array.isArray(providers)) throw new Error("请选择平台");
  const collections = await Promise.all(providers.filter((provider) => serviceIds.includes(provider)).map(async (provider) => {
    const added = store.state.accounts.filter((account) => account.provider === provider);
    const list = added.map((account) => ({ ...account, imported: true }));
    const query = queries[provider];
    if (!query || test) return list;
    const roots = [undefined];
    if (provider === "codex" || provider === "copilot") {
      const base = join(profileRoot, provider);
      for (const entry of await readdir(base, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name)) roots.push(join(base, entry.name));
      }
    }
    for (let offset = 0; offset < roots.length; offset += 3) {
      const found = await Promise.allSettled(roots.slice(offset, offset + 3).map(async (home) => ({
        ...(await query({ home }, true)), home, provider, mode: "cli", windows: [],
      })));
      for (const entry of found) {
        if (entry.status === "fulfilled" && !list.some((account) => account.identityKey === entry.value.identityKey)) list.push(entry.value);
      }
    }
    return list;
  }));
  return collections.flat();
}

const pending = new Map();
function issueCandidate(account) {
  if (!account.id) account.id = randomUUID();
  pending.set(account.id, account);
  const { home, snapshotPath, ...visible } = account;
  return visible;
}

function manualCandidate(provider, input) {
  checkedService(provider);
  const email = String(input?.email || "").trim().toLowerCase();
  if (!/^[^@\s]{1,150}@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) throw new Error("请输入完整邮箱");
  const alias = String(input?.alias || "").trim().slice(0, 60);
  return issueCandidate({ provider, email, alias, label: email.split("@")[0], identityKey: email, mode: "manual", windows: [] });
}

async function openLogin(provider, selected) {
  const service = checkedService(provider);
  if (!service.cli || process.platform !== "win32") return shell.openExternal(service.url);
  let profile = selected?.home;
  if (!selected && (provider === "codex" || provider === "copilot")) {
    profile = join(profileRoot, provider, randomUUID());
    await mkdir(profile, { recursive: true });
  }
  const variable = provider === "codex" ? "CODEX_HOME" : "COPILOT_HOME";
  const quote = (argument) => "'" + argument.replaceAll("'", "''") + "'";
  const switchEnvironment = provider === "copilot" ? "Remove-Item Env:GH_TOKEN,Env:GITHUB_TOKEN,Env:COPILOT_GITHUB_TOKEN -ErrorAction SilentlyContinue; " : "";
  const command = (profile ? `$env:${variable} = ${quote(profile)}; ` : "") + switchEnvironment +
    `& ${quote(service.cli)}${selected ? "" : provider === "codex" ? " login --device-auth" : " login"}`;
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  await new Promise((resolve, reject) => {
    const child = execFile(executable, ["-NoLogo", "-NoProfile", "-NoExit", "-EncodedCommand", encoded], { windowsHide: false });
    child.on("error", reject);
    child.on("spawn", resolve);
  });
}

function refreshAll() {
  if (refreshing) return refreshing;
  const accounts = store.state.accounts.filter((account) => account.mode === "cli");
  if (!accounts.length) return;
  refreshing = (async () => {
    const results = [];
    for (let offset = 0; offset < accounts.length; offset += 4) {
      results.push(...await Promise.allSettled(accounts.slice(offset, offset + 4).map(async (account) => {
        const result = await queries[account.provider](account);
        if (result.identityKey !== account.identityKey) throw new Error("官方登录账号已变化");
        return result;
      })));
    }
    await store.change((state) => {
      for (const [i, account] of accounts.entries()) {
        const current = state.accounts.find((entry) => entry.id === account.id && entry.identityKey === account.identityKey && entry.snapshotPath === account.snapshotPath);
        if (!current) continue;
        const result = results[i];
        if (result.status === "fulfilled") {
          Object.assign(current, { windows: result.value.windows ?? [], observedAt: result.value.observedAt, error: null });
          if (result.value.email) current.email = result.value.email;
        } else {
          current.error = "读取未完成";
        }
      }
    });
  })().finally(() => { refreshing = undefined; publish(); });
  publish();
  return refreshing;
}

function startRefresh() { void refreshAll()?.catch(() => {}); }
async function update(edit) { await store.change(edit); publish(); return currentState(); }

function register() {
  const handle = (name, fn) => ipcMain.handle(name, (event, ...args) => {
    const from = event.sender;
    if ((from !== board?.webContents && from !== settings?.webContents) || event.senderFrame !== from.mainFrame) throw new Error("未知窗口");
    return fn(...args);
  });
  handle("state", () => currentState());
  handle("initial", () => settings?.initial || {});
  handle("panel-size", (width, height) => {
    if (Number.isFinite(width) && Number.isFinite(height)) placeBoard(Math.max(310, Math.min(1100, width)), Math.max(150, Math.min(780, height)));
  });
  handle("hide", () => board?.hide());
  handle("settings", (provider) => openSettings({ provider }));
  handle("scan", async (providers) => (await candidates(providers)).map(issueCandidate));
  handle("login", async (provider) => { await openLogin(provider); return true; });
  handle("site", (provider) => shell.openExternal(checkedService(provider).url));
  handle("candidate", manualCandidate);
  handle("import", async (selection, firstRun) => {
    if (!Array.isArray(selection) || selection.length > 100) throw new Error("无法导入选中的账号");
    await update((state) => {
      for (const { id, email } of selection) {
        const account = pending.get(id);
        if (!account) continue;
        const entered = String(email || account.email || "").trim();
        if (!/^[^@\s]{1,150}@[^@\s]+\.[^@\s]+$/.test(entered) || entered.length > 254) throw new Error("请填写有效邮箱以核对账号");
        if (state.accounts.some((entry) => entry.provider === account.provider && (entry.identityKey === account.identityKey || entry.email?.toLowerCase() === entered.toLowerCase()))) continue;
        const { imported, ...newAccount } = account;
        state.accounts.push({ ...newAccount, email: entered });
      }
      if (firstRun) state.configured = true;
    });
    for (const { id } of selection) pending.delete(id);
    startRefresh();
    if (firstRun) { settings?.close(); openBoard(); }
    return currentState();
  });
  handle("visible", (provider, visible) => update((state) => {
    checkedService(provider);
    if (!activeAccount(provider)) return;
    state.hidden = state.hidden.filter((id) => id !== provider);
    if (!visible) state.hidden.push(provider);
  }));
  handle("rename", (id, alias) => update((state) => {
    const account = state.accounts.find((entry) => entry.id === id);
    if (account) account.alias = String(alias || "").trim().slice(0, 60);
  }));
  handle("switch", async (id) => {
    const account = accountById(id);
    if (!account || activeAccount(account.provider)?.id === id) return currentState();
    if (account.mode === "cli" && account.home && (account.provider === "codex" || account.provider === "copilot")) {
      const verified = await queries[account.provider](account, true);
      if (verified.identityKey !== account.identityKey) throw new Error("登录身份已变更，请重新添加账号");
      await openLogin(account.provider, account);
    }
    return update((state) => { state.active[account.provider] = id; });
  });
  handle("record", (id, windows) => update((state) => {
    const account = state.accounts.find((entry) => entry.id === id);
    if (!account || account.mode !== "manual") throw new Error("找不到手动记录账号");
    Object.assign(account, validateSnapshot({ windows, observedAt: new Date().toISOString() }));
  }));
  handle("snapshot", async (id) => {
    if (accountById(id)?.provider !== "claude") return currentState();
    const result = await dialog.showOpenDialog(settings, { properties: ["openFile"], filters: [{ name: "JSON", extensions: ["json"] }] });
    if (result.canceled) return currentState();
    await update((state) => {
      const account = state.accounts.find((entry) => entry.id === id);
      if (account) account.snapshotPath = result.filePaths[0];
    });
    startRefresh();
    return currentState();
  });
  handle("refresh", async () => { await refreshAll(); return currentState(); });
  handle("power", (action) => {
    if (action === "restart") app.relaunch();
    if (action === "restart" || action === "quit") app.quit();
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(async () => {
  try { await store.load(); }
  catch { dialog.showErrorBox("额度看板", "无法读取本机配置，请检查后重试。"); app.quit(); return; }
  Menu.setApplicationMenu(null);
  register();
  tray = new Tray(nativeImage.createFromPath(join(directory, process.platform === "win32" ? "tray.ico" : "tray.png")));
  tray.setToolTip("额度看板");
  tray.on("click", () => { if (board?.isVisible()) board.hide(); else openBoard(); });
  tray.on("right-click", () => tray.popUpContextMenu(Menu.buildFromTemplate([
    { label: "额度总览", click: openBoard },
    { label: "设置", click: () => openSettings(store.state.configured ? {} : { mode: "setup" }) },
    { type: "separator" }, { label: "退出额度看板", click: () => app.quit() },
  ])));
  openBoard();
  startRefresh();
  setInterval(startRefresh, 300_000).unref();
});
app.on("second-instance", () => { if (tray) openBoard(); });
app.on("window-all-closed", () => {});
