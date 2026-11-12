const time = Date.now();
export const demoAccounts = [
  ["codex", "工作号", "codex", [8, 62]],
  ["codex", "个人号", "codex", [84, 91]],
  ["claude", "日常创作", "claude", [46, 73]],
  ["cursor", "个人工作区", "manual", [68]],
  ["copilot", "开源项目", "copilot", [92]],
].map(([provider, label, mode, remaining], index) => ({
  id: "demo-" + index,
  provider,
  label,
  mode,
  source: "虚拟演示数据",
  snapshot: {
    observedAt: new Date(
      time - (index === 2 ? 42 * 60_000 : 30_000),
    ).toISOString(),
    windows: remaining.map((value, position) => ({
      label:
        remaining.length === 1
          ? "每月订阅额度"
          : position === 0
            ? "5 小时"
            : "每周",
      remaining: value,
      resetsAt: new Date(
        time + (position === 0 ? 42 * 60_000 : 3 * 86400_000),
      ).toISOString(),
    })),
  },
}));
