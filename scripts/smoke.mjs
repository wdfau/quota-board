import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "quota-board-ui-"));
const errors = [];
const env = { ...process.env };
env.QUOTA_BOARD_TEST_DATA_DIR = directory;
delete env.ELECTRON_RUN_AS_NODE;
let application;
async function launch() {
  application = await electron.launch({
    args: [resolve("."), "--dashboard", "--user-data-dir=" + directory],
    env,
  });
  const userData = await application.evaluate(({ app }) =>
    app.getPath("userData"),
  );
  if (resolve(userData) !== resolve(directory))
    throw new Error("Test data directory was not isolated");
  const page = await application.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector("#add");
  return page;
}
try {
  let page = await launch();
  await expect(page.locator(".empty")).toBeVisible();
  await page.locator("#demo").click();
  await expect(page.locator(".account")).toHaveCount(5);
  await page
    .getByRole("button", { name: "Cursor", exact: false })
    .first()
    .click();
  await expect(page.locator(".account")).toHaveCount(1);
  await page.locator("#demo").click();
  await page.locator("#add").click();
  await page.locator("#provider").selectOption("cursor");
  await page.locator("[name=label]").fill("UI test account");
  await page.locator("#profile-form [type=submit]").click();
  await expect(page.locator("#record-dialog")).toBeVisible();
  await page.locator("[name=remaining]").fill("37");
  await page.locator("#record-form [type=submit]").click();
  await expect(page.locator(".ring-value")).toContainText("37%");
  await expect(page.locator(".card-footer")).toContainText("上次记录");
  await application.close();
  page = await launch();
  await expect(page.locator(".account")).toHaveCount(1);
  await expect(page.locator(".ring-value")).toContainText("37%");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "移除 UI test account" }).click();
  await expect(page.locator(".empty")).toBeVisible();
  await page.locator("#demo").click();
  await page.getByRole("button", { name: "全部账号" }).click();
  await page.setViewportSize({ width: 1440, height: 1200 });
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/demo.png", fullPage: true });
  expect(errors).toEqual([]);
  console.log(
    "UI smoke passed: demo, filters, add, record, restart, remove; no page errors.",
  );
} finally {
  await application?.close();
  await rm(directory, { recursive: true, force: true });
}
