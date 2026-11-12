export const providers = {
  codex: {
    name: "Codex",
    color: "#32756a",
    url: "https://chatgpt.com/codex/settings/usage",
    modes: ["codex", "manual"],
  },
  claude: {
    name: "Claude",
    color: "#ad663f",
    url: "https://claude.ai/settings/usage",
    modes: ["claude", "manual"],
  },
  cursor: {
    name: "Cursor",
    color: "#526bd3",
    url: "https://cursor.com/settings",
    modes: ["manual"],
  },
  copilot: {
    name: "GitHub Copilot",
    color: "#8559b6",
    url: "https://github.com/settings/copilot",
    modes: ["copilot", "manual"],
  },
};

export function validateProfile(input) {
  if (!input || !providers[input.provider]) throw new Error("请选择支持的服务");
  if (!providers[input.provider].modes.includes(input.mode))
    throw new Error("该服务暂不支持这种数据来源");
  const label = String(input.label || "").trim();
  if (!label || label.length > 60) throw new Error("账号名称需为 1–60 个字符");
  const profile = { provider: input.provider, mode: input.mode, label };
  for (const key of ["home", "cliPath", "snapshotPath"]) {
    profile[key] = String(input[key] || "").trim();
    if (profile[key].length > 2048 || /[\r\n\0]/.test(profile[key]))
      throw new Error("路径格式无效");
  }
  if (profile.mode === "claude" && !profile.snapshotPath)
    throw new Error("请选择 Claude 额度记录文件");
  return profile;
}

export function validateSnapshot(input) {
  if (
    !input ||
    !Array.isArray(input.windows) ||
    input.windows.length === 0 ||
    input.windows.length > 16
  ) {
    throw new Error("需要 1–16 个有效的额度窗口");
  }
  const observedAt = new Date(input.observedAt);
  if (
    !Number.isFinite(observedAt.getTime()) ||
    observedAt.getTime() > Date.now() + 60_000
  ) {
    throw new Error("采集时间无效");
  }
  const windows = input.windows.map((window) => {
    const label = String(window.label || "").trim();
    const remaining = window.remaining;
    if (
      !label ||
      label.length > 80 ||
      typeof remaining !== "number" ||
      !Number.isFinite(remaining) ||
      remaining < 0 ||
      remaining > 100
    ) {
      throw new Error("额度名称或剩余百分比无效");
    }
    const resetsAt = window.resetsAt
      ? new Date(window.resetsAt).toISOString()
      : null;
    return { label, remaining, resetsAt };
  });
  return { windows, observedAt: observedAt.toISOString() };
}

export function codexSnapshot(result) {
  const buckets =
    result.rateLimitsByLimitId ||
    (result.rateLimits ? { codex: result.rateLimits } : {});
  const windows = [];
  for (const [key, bucket] of Object.entries(buckets)) {
    for (const field of ["primary", "secondary"]) {
      const window = bucket[field];
      if (!window || typeof window.usedPercent !== "number") continue;
      const minutes = window.windowDurationMins;
      const period =
        minutes === 300
          ? "5 小时"
          : minutes === 10080
            ? "每周"
            : minutes
              ? `${minutes} 分钟`
              : field;
      windows.push({
        label:
          Object.keys(buckets).length > 1
            ? `${bucket.limitName || key} · ${period}`
            : period,
        remaining: 100 - window.usedPercent,
        resetsAt: window.resetsAt
          ? new Date(window.resetsAt * 1000).toISOString()
          : null,
      });
    }
  }
  return validateSnapshot({ windows, observedAt: new Date().toISOString() });
}

export function claudeSnapshot(input) {
  const windows = [];
  for (const [key, label] of [
    ["five_hour", "5 小时"],
    ["seven_day", "每周"],
  ]) {
    const window = input.rate_limits?.[key];
    if (typeof window?.used_percentage !== "number") continue;
    windows.push({
      label,
      remaining: 100 - window.used_percentage,
      resetsAt: window.resets_at
        ? new Date(window.resets_at * 1000).toISOString()
        : null,
    });
  }
  return validateSnapshot({
    windows,
    observedAt: input.observedAt || new Date().toISOString(),
  });
}

export function copilotSnapshot(result) {
  const windows = [];
  for (const [key, value] of Object.entries(result.quotaSnapshots || {})) {
    if (
      !value ||
      value.isUnlimitedEntitlement ||
      value.entitlementRequests === -1 ||
      typeof value.remainingPercentage !== "number"
    )
      continue;
    windows.push({
      label: key,
      remaining: value.remainingPercentage,
      resetsAt: value.resetDate || null,
    });
  }
  return validateSnapshot({ windows, observedAt: new Date().toISOString() });
}
