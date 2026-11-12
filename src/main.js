import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  ipcMain,
  dialog,
  shell,
} from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFile } from "node:fs/promises";
import { Store } from "../core/store.js";
import { providers } from "../core/model.js";
import { readQuota } from "../core/adapters.js";
import { FloatingWindows } from "./floating-window.js";
import { demoAccounts } from "./demo.js";

const directory = dirname(fileURLToPath(import.meta.url));
app.setName("Quota Board");
if (!app.isPackaged && process.env.QUOTA_BOARD_TEST_DATA_DIR) {
  app.setPath("userData", process.env.QUOTA_BOARD_TEST_DATA_DIR);
}
if (process.argv.includes("--screenshot"))
  app.setPath(
    "userData",
    join(app.getPath("temp"), "quota-board-preview-data"),
  );
let window;
let tray;
let store;
const running = new Map();
let quitting = false;
let floatingWindows;
const useFloating =
  (process.platform === "win32" || process.argv.includes("--floating")) &&
  !process.argv.includes("--dashboard");
const isDemo = process.argv.includes("--demo");
let demoPreference = { accountId: "demo-0", windowLabel: "每周" };

if (!app.requestSingleInstanceLock()) app.quit();
else
  app.whenReady().then(async () => {
    app.on("second-instance", () => {
      if (floatingWindows) floatingWindows.ball.show();
      else {
        window?.show();
        window?.focus();
      }
    });
    store = new Store(app.getPath("userData"));
    try {
      await store.load();
    } catch (error) {
      dialog.showErrorBox("本地数据需要检查", error.message);
      quitting = true;
      app.quit();
    }
    if (!quitting) {
      createWindow();
      if (useFloating)
        floatingWindows = new FloatingWindows({
          preferences: store.preferences,
          demo: isDemo,
          savePosition: (position) => store.saveFloatingPosition(position),
        });
    }
  });

function createWindow() {
  window = new BrowserWindow({
    width: process.argv.includes("--screenshot") ? 1440 : 1160,
    height: process.argv.includes("--screenshot") ? 1100 : 820,
    minWidth: 720,
    minHeight: 580,
    backgroundColor: "#f6f8fb",
    title: "Quota Board",
    show: !useFloating,
    webPreferences: {
      preload: join(directory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.loadFile(join(directory, "index.html"), {
    query: { demo: process.argv.includes("--demo") ? "1" : "0" },
  });
  window.on("close", (event) => {
    if (!quitting && tray) {
      event.preventDefault();
      window.hide();
    }
  });
  const bitmap = Buffer.alloc(32 * 32 * 4);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      if (Math.abs(Math.hypot(x - 15.5, y - 15.5) - 11) > 2.5) continue;
      const offset = (y * 32 + x) * 4;
      bitmap.set([106, 117, 50, 255], offset);
    }
  }
  tray = new Tray(
    nativeImage
      .createFromBitmap(bitmap, { width: 32, height: 32 })
      .resize({ width: 20, height: 20 }),
  );
  tray.setToolTip("Quota Board · 订阅额度");
  tray.on("click", () => {
    if (floatingWindows) {
      floatingWindows.ball.show();
      floatingWindows.togglePanel();
    } else {
      window.show();
      window.focus();
    }
  });
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开额度看板", click: () => window.show() },
      ...(useFloating
        ? [
            {
              label: "显示悬浮球",
              click: () => floatingWindows?.ball.show(),
            },
          ]
        : []),
      { label: "刷新额度", click: () => refreshAll() },
      { type: "separator" },
      { label: "退出", click: () => app.quit() },
    ]),
  );
  Menu.setApplicationMenu(
    process.platform === "win32"
      ? null
      : Menu.buildFromTemplate([
          ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
          { role: "editMenu" },
          { role: "viewMenu" },
          { role: "windowMenu" },
        ]),
  );
  window.webContents.on("did-finish-load", async () => {
    if (!process.argv.includes("--screenshot")) return;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await writeFile(
      join(app.getPath("temp"), "quota-board-preview.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
    app.quit();
  });
  setInterval(refreshAll, 300_000).unref();
}

function publish() {
  for (const surface of [
    window,
    floatingWindows?.ball,
    floatingWindows?.panel,
  ]) {
    if (surface && !surface.isDestroyed()) {
      surface.webContents.send("state", store.accounts);
      surface.webContents.send(
        "preferences",
        isDemo ? demoPreference : store.preferences.floating || {},
      );
    }
  }
}

async function refresh(id) {
  if (running.has(id)) return running.get(id);
  const promise = store.refresh(id, readQuota).finally(() => {
    running.delete(id);
    publish();
  });
  running.set(id, promise);
  return promise;
}

async function refreshAll() {
  await Promise.allSettled(
    store.accounts
      .filter((account) => account.mode !== "manual")
      .map((account) => refresh(account.id)),
  );
}

function handle(name, callback) {
  ipcMain.handle(name, async (event, ...args) => {
    const surface = [
      window,
      floatingWindows?.ball,
      floatingWindows?.panel,
    ].find(
      (candidate) =>
        candidate &&
        !candidate.isDestroyed() &&
        candidate.webContents === event.sender,
    );
    if (!surface || event.senderFrame !== surface.webContents.mainFrame)
      return { error: "无效的窗口来源" };
    try {
      return { data: await callback(...args) };
    } catch {
      return { error: "操作未完成，请检查输入和本地文件权限" };
    }
  });
}

handle("list", () => store.accounts);
handle("floating-preference", () =>
  isDemo ? demoPreference : store.preferences.floating || {},
);
handle("select-floating", async (accountId, windowLabel) => {
  if (isDemo) {
    if (!demoAccounts.some((account) => account.id === accountId))
      throw new Error("无效演示账号");
    demoPreference = { accountId, windowLabel };
  } else await store.selectFloating(accountId, windowLabel);
  publish();
});
handle("toggle-floating", () => floatingWindows?.togglePanel());
handle("drag-floating", (phase, point) => floatingWindows?.drag(phase, point));
handle("manage", () => {
  window.show();
  window.focus();
});
handle("add", async (input) => {
  const account = await store.add(input);
  publish();
  return account;
});
handle("remove", async (id) => {
  await store.remove(id);
  publish();
});
handle("record", async (id, input) => {
  await store.record(id, input);
  publish();
});
handle("refresh", async (id) => {
  if (id) await refresh(id);
  else await refreshAll();
});
handle("open-provider", (provider) => {
  if (!providers[provider]) throw new Error("无效服务");
  return shell.openExternal(providers[provider].url);
});
handle("choose", async (kind) => {
  const result = await dialog.showOpenDialog(window, {
    properties: kind === "directory" ? ["openDirectory"] : ["openFile"],
  });
  return result.canceled ? null : result.filePaths[0];
});
app.on("before-quit", () => {
  quitting = true;
});
app.on("activate", () => window?.show());
app.on("window-all-closed", () => {
  if (!tray) app.quit();
});
