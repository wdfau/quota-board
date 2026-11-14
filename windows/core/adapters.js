import spawn from "cross-spawn";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import which from "which";
import { homedir } from "node:os";
import { codexSnapshot, copilotSnapshot, validateSnapshot } from "./model.js";

export async function queryCodex(profile, identityOnly = false) {
  const child = spawn(
    profile.cliPath || "codex",
    ["app-server", "--listen", "stdio://"],
    {
      env: {
        ...process.env,
        ...(profile.home ? { CODEX_HOME: profile.home } : {}),
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  const lines = createInterface({ input: child.stdout });
  let nextId = 0;
  const pending = new Map();
  const fail = () => {
    for (const request of pending.values())
      request.reject(new Error("Codex CLI 已退出，请检查安装、登录和配置目录"));
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", fail);
  child.stdin.on("error", fail);
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error)
      request.reject(
        new Error("Codex 查询失败，请在对应配置目录完成官方登录后重试"),
      );
    else request.resolve(message.result);
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  const timer = setTimeout(() => {
    fail();
    child.kill();
  }, 25_000);
  try {
    await request("initialize", {
      clientInfo: {
        name: "quota_board",
        title: "Quota Board",
        version: "0.1.0",
      },
      capabilities: {},
    });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const identity = await request("account/read", { refreshToken: false });
    if (!identity?.account || identity.account.type !== "chatgpt")
      throw new Error("请先使用 Codex 官方 CLI 登录订阅账号");
    const account = identity.account;
    const identityKey = account.id || account.email;
    if (!identityKey) throw new Error("服务未返回可核对的账号身份");
    const identityData = { identityKey, email: account.email || "", label: account.email?.split("@")[0] || "Codex", source: "Codex 官方 CLI" };
    if (identityOnly) return identityData;
    const snapshot = codexSnapshot(
      await request("account/rateLimits/read", {}),
    );
    const verified = (await request("account/read", { refreshToken: false }))
      ?.account;
    if ((verified?.id || verified?.email) !== identityKey)
      throw new Error("账号在读取时发生变化，请重新刷新");
    return { ...snapshot, ...identityData };
  } finally {
    clearTimeout(timer);
    lines.close();
    child.kill();
  }
}

export async function queryCopilot(profile, identityOnly = false) {
  const { CopilotClient, RuntimeConnection } = await import(
    "@github/copilot-sdk"
  );
  const cliPath = profile.cliPath || which.sync("copilot");
  if (/\.(cmd|bat)$/i.test(cliPath))
    throw new Error("Windows 请在 CLI 路径中选择 Copilot 原生 .exe 程序");
  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio({ path: cliPath }),
    ...(profile.home ? { baseDirectory: profile.home } : {}),
    workingDirectory: homedir(),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      ...(profile.home ? { COPILOT_HOME: profile.home } : {}),
      COPILOT_GITHUB_TOKEN: "",
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
    },
    logLevel: "none",
  });
  let timer;
  try {
    return await Promise.race([
      (async () => {
        await client.start();
        const auth = await client.getAuthStatus();
        if (!auth.isAuthenticated || !auth.login)
          throw new Error("请先在 Copilot 官方 CLI 登录");
        const identity = { identityKey: auth.login.toLowerCase(), label: auth.login, source: "GitHub Copilot SDK" };
        if (identityOnly) return identity;
        const result = await client.rpc.account.getQuota({});
        const verified = await client.getAuthStatus();
        if (verified.login !== auth.login)
          throw new Error("账号在读取时发生变化，请重新刷新");
        return {
          ...copilotSnapshot(result),
          ...identity,
        };
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Copilot 查询超时")), 25_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    const cleanup = setTimeout(() => {
      void client.forceStop();
    }, 3000);
    try {
      await client.stop();
    } finally {
      clearTimeout(cleanup);
    }
  }
}

export async function queryClaude(profile, identityOnly = false) {
  const status = await new Promise((resolve, reject) => {
    const child = spawn("claude", ["auth", "status"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    const timer = setTimeout(() => child.kill(), 8000);
    child.on("error", reject);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 65536) child.kill();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error("请先通过 Claude Code 登录"));
      try { resolve(JSON.parse(output)); } catch { reject(new Error("无法读取 Claude 登录身份")); }
    });
  });
  if (!status.loggedIn || !status.email) throw new Error("请先通过 Claude Code 登录");
  const identity = { identityKey: status.email.toLowerCase(), email: status.email, label: status.email.split("@")[0], source: "Claude Code" };
  if (identityOnly || !profile.snapshotPath) return identity;
  const raw = await readFile(profile.snapshotPath, "utf8");
  if (raw.length > 65536) throw new Error("额度记录文件过大");
  return { ...validateSnapshot(JSON.parse(raw)), ...identity };
}

export const queries = { codex: queryCodex, copilot: queryCopilot, claude: queryClaude };
