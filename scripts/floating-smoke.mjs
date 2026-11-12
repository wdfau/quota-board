import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "quota-float-ui-"));
const env = { ...process.env, QUOTA_BOARD_TEST_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
let application;
const errors = [];
async function launch(demo) {
  application = await electron.launch({
    args: [resolve("."), "--floating", ...(demo ? ["--demo"] : [])],
    env,
  });
  await expect.poll(() => application.windows().length).toBe(3);
  const surfaces = application.windows();
  const ball = surfaces.find((page) => page.url().includes("floating-ball"));
  const panel = surfaces.find((page) => page.url().includes("floating-panel"));
  const dashboard = surfaces.find((page) => page.url().includes("index.html"));
  for (const surface of surfaces)
    surface.on("pageerror", (error) => errors.push(error.message));
  await ball.waitForSelector("#orb");
  return { ball, panel, dashboard };
}
try {
  let { ball, panel } = await launch(true);
  await expect(ball.locator("#orb-value")).toHaveText("38%");
  await ball.locator("#orb").click();
  await expect(panel.locator("#focus-value")).toHaveText("38");
  await panel.locator("#period").selectOption("5 小时");
  await expect(ball.locator("#orb-value")).toHaveText("92%");
  await panel.getByRole("button", { name: "固定 Claude 日常创作" }).click();
  await expect(ball.locator("#orb-value")).toHaveText("54%");
  await expect(panel.locator("#focus-status")).toContainText("会话记录");
  await panel.getByRole("button", { name: "固定 Codex 工作号" }).click();
  await panel.locator("#period").selectOption("每周");
  await expect(ball.locator("#orb-value")).toHaveText("38%");
  await mkdir("artifacts", { recursive: true });
  await ball.screenshot({
    path: "artifacts/floating-ball.png",
    omitBackground: true,
  });
  await panel.screenshot({
    path: "artifacts/floating-panel.png",
    omitBackground: true,
  });
  const getBallBounds = () => application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find(window =>
      window.webContents.getURL().includes("floating-ball.html")).getBounds()
  );
  const beforeDrag = await getBallBounds();
  await ball.mouse.move(52, 52);
  await ball.mouse.down();
  await ball.mouse.move(64, 60);
  await ball.mouse.up();
  await expect.poll(async () => (await getBallBounds()).x).not.toBe(beforeDrag.x);
  await application.close();

  let surfaces = await launch(false);
  await expect(surfaces.ball.locator("#orb-value")).toHaveText("—");
  await surfaces.ball.locator("#orb").click();
  await expect(surfaces.panel.locator("#floating-empty")).toBeVisible();
  await surfaces.panel.locator("#manage").click();
  await surfaces.dashboard.waitForSelector("#add");
  const id = await surfaces.dashboard.evaluate(async () => {
    const profile = await window.quota.add({
      provider: "cursor",
      mode: "manual",
      label: "Pinned test",
    });
    await window.quota.record(profile.id, {
      observedAt: new Date().toISOString(),
      windows: [{ label: "每月", remaining: 62 }],
    });
    return profile.id;
  });
  await surfaces.dashboard.evaluate(
    (id) => window.quota.selectFloating(id, "每月"),
    id,
  );
  await expect(surfaces.ball.locator("#orb-value")).toHaveText("38%");
  await application.close();
  surfaces = await launch(false);
  await expect(surfaces.ball.locator("#orb-value")).toHaveText("38%");
  expect(errors).toEqual([]);
  console.log(
    "Floating smoke passed: used ring, drag, expand, account/period selection, empty state, manage and persistent pin.",
  );
} finally {
  await application?.close();
  await rm(directory, { recursive: true, force: true });
}
