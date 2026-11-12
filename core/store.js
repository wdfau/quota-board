import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { validateProfile, validateSnapshot } from "./model.js";

export class Store {
  constructor(directory) {
    this.directory = directory;
    this.path = join(directory, "state.json");
    this.accounts = [];
    this.preferences = {};
    this.writeQueue = Promise.resolve();
  }

  async load() {
    try {
      const state = JSON.parse(await readFile(this.path, "utf8"));
      if (state.version !== 1 || !Array.isArray(state.accounts))
        throw new Error("不支持的本地数据格式");
      this.accounts = state.accounts.map((account) => ({
        ...validateProfile(account),
        id: account.id,
        snapshot: account.snapshot ? validateSnapshot(account.snapshot) : null,
        identityKey: account.identityKey,
        source: account.source,
        error: null,
      }));
      this.preferences = state.preferences || {};
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new Error(
          "无法读取本地数据，请备份应用数据目录后检查 state.json",
        );
    }
  }

  save() {
    const data = JSON.stringify(
      { version: 1, accounts: this.accounts, preferences: this.preferences },
      null,
      2,
    );
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(async () => {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const temporary = this.path + ".tmp";
        await writeFile(temporary, data, { mode: 0o600 });
        await rename(temporary, this.path);
      });
    return this.writeQueue;
  }

  async add(input) {
    const profile = validateProfile(input);
    const account = {
      ...profile,
      id: randomUUID(),
      snapshot: null,
      error: null,
    };
    this.accounts.push(account);
    await this.save();
    return account;
  }

  async remove(id) {
    this.accounts = this.accounts.filter((account) => account.id !== id);
    await this.save();
  }

  async selectFloating(accountId, windowLabel) {
    const account = this.accounts.find((item) => item.id === accountId);
    if (!account) throw new Error("账号已移除");
    if (
      windowLabel &&
      !account.snapshot?.windows.some((item) => item.label === windowLabel)
    ) {
      throw new Error("额度窗口已变化，请重新选择");
    }
    this.preferences.floating = { accountId, windowLabel: windowLabel || null };
    await this.save();
  }

  async saveFloatingPosition(position) {
    this.preferences.floatingPosition = position;
    await this.save();
  }

  async record(id, input) {
    const account = this.accounts.find((account) => account.id === id);
    if (!account || account.mode !== "manual")
      throw new Error("该账号不支持手动记录");
    account.snapshot = validateSnapshot(input);
    account.source = "手动记录";
    account.error = null;
    await this.save();
  }

  async refresh(id, reader) {
    const account = this.accounts.find((account) => account.id === id);
    if (!account || account.mode === "manual") return;
    try {
      const result = await reader(account);
      if (!this.accounts.includes(account)) return;
      if (account.identityKey && result.identityKey !== account.identityKey) {
        account.snapshot = null;
        throw new Error(
          "登录账号发生变化，请移除此配置后重新添加，防止混用数据",
        );
      }
      account.snapshot = validateSnapshot(result);
      account.identityKey = result.identityKey;
      account.source = result.source;
      account.error = null;
    } catch (error) {
      if (!this.accounts.includes(account)) return;
      // Provider and subprocess errors may include local paths or server content.
      account.error =
        error.code === "ENOENT"
          ? "未找到程序或记录文件，请检查路径"
          : error.message?.startsWith("登录账号发生变化")
            ? error.message
            : "读取失败，请检查官方登录、文件路径及网络后重试";
    }
    await this.save();
  }
}
