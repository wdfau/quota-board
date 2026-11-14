import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = await mkdtemp(join(tmpdir(), "quota-board-test-"));
const electronApp = await electron.launch({
  args: [fileURLToPath(new URL("../", import.meta.url))],
  env: { ...process.env, QUOTA_BOARD_TEST_DATA_DIR: dir },
  timeout: 30000,
});

try {
  const setup = await electronApp.firstWindow();
  const dashboard = electronApp.waitForEvent("window", { predicate: (page) => page.url().includes("surface=board"), timeout: 15000 });
  await expect(setup.getByRole("heading", { name: "选择平台" })).toBeVisible();
  await setup.getByRole("button", { name: "下一步" }).click();
  await expect(setup.getByRole("heading", { name: "选择要导入的账号" })).toBeVisible();
  const add = async (provider, email, alias) => {
    await setup.locator(`[data-add-service="${provider}"]`).click();
    await setup.getByRole("textbox", { name: "邮箱" }).fill(email);
    await setup.getByRole("textbox", { name: "显示名称" }).fill(alias);
    await setup.getByRole("dialog").getByRole("button", { name: "添加账号" }).click();
  };
  await add("codex", "first@example.com", "工作");
  await add("codex", "second@example.com", "个人");
  await add("cursor", "cursor@example.com", "工作区");
  await setup.getByRole("button", { name: "下一步" }).click();
  await expect(setup.getByText("second@example.com")).toBeVisible();
  await setup.getByRole("button", { name: "导入并打开总览" }).click();

  const panel = await dashboard;
  await expect(panel.getByRole("heading", { name: "额度总览" })).toBeVisible();
  await expect(panel.locator(".tile")).toHaveCount(2);
  const preferences = electronApp.waitForEvent("window", { predicate: (page) => page.url().includes("surface=settings"), timeout: 15000 });
  await panel.getByRole("button", { name: "设置" }).click();
  const settings = await preferences;
  await settings.getByRole("button", { name: "GitHub Copilot" }).click();
  await expect(settings.getByRole("switch")).toBeDisabled();
  await expect(settings.getByRole("switch")).not.toBeChecked();
  await settings.getByRole("button", { name: "Codex" }).click();
  await settings.getByRole("button", { name: "记录额度" }).first().click();
  await settings.getByLabel("5 Hours").fill("84");
  await settings.getByLabel("Weekly").fill("42");
  await settings.getByRole("button", { name: "保存额度" }).click();
  await expect(panel.getByText("84%")).toBeVisible();
  await expect(panel.getByText("42%")).toHaveCount(0);
  await settings.getByRole("button", { name: "编辑显示名称" }).first().click();
  await expect(settings.getByRole("dialog").getByText("first@example.com")).toBeVisible();
  await settings.getByRole("textbox", { name: "显示名称" }).fill("工作账号");
  await settings.getByRole("button", { name: "保存" }).click();
  await expect(panel.getByText("工作账号")).toBeVisible();

  await panel.locator('[data-detail="codex"]').click();
  await expect(panel.getByText("42%")).toBeVisible();
  await expect(panel.getByText("总览账号")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "切换", exact: true })).toHaveCount(0);
  await panel.locator(".switchable").dblclick();
  await expect(panel.getByRole("dialog").getByText("second@example.com")).toBeVisible();
  await panel.getByRole("button", { name: "取消" }).click();
  await expect(panel.locator(".account.active")).toContainText("工作账号");
  await panel.locator(".switchable").dblclick();
  await panel.getByRole("button", { name: "确认切换" }).click();
  await expect(panel.locator(".account.active")).toContainText("个人");

  await panel.getByRole("button", { name: "返回总览" }).click();
  await expect(panel.locator(".tile").getByText("个人", { exact: true })).toBeVisible();
  const fullWidth = await panel.evaluate(() => innerWidth);
  await settings.getByRole("button", { name: "Cursor" }).click();
  await settings.getByRole("switch").uncheck();
  await expect(panel.locator(".tile")).toHaveCount(1);
  await expect.poll(() => panel.evaluate(() => innerWidth)).toBeLessThan(fullWidth);

  await settings.getByRole("button", { name: "退出或重启额度看板" }).click();
  await expect(settings.getByRole("button", { name: "退出", exact: true })).toBeVisible();
  await expect(settings.getByRole("button", { name: "重启" })).toBeVisible();
  await settings.getByRole("button", { name: "取消" }).click();
  console.log("Windows application flow passed");
} finally {
  await electronApp.close();
  await rm(dir, { recursive: true, force: true });
}
