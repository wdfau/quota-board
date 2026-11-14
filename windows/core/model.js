export function validateSnapshot(input) {
  if (
    !input ||
    !Array.isArray(input.windows) ||
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
    const minutes = Number.isFinite(window.minutes) && window.minutes > 0 ? window.minutes : undefined;
    return { label, remaining, resetsAt, minutes, detail: String(window.detail || "").slice(0, 80) };
  });
  return { windows, observedAt: observedAt.toISOString() };
}

export function codexSnapshot(result) {
  const buckets =
    result?.rateLimitsByLimitId ||
    (result?.rateLimits ? { codex: result.rateLimits } : {});
  const windows = [];
  for (const [key, bucket] of Object.entries(buckets)) {
    for (const field of ["primary", "secondary"]) {
      const window = bucket[field];
      if (!window || typeof window.usedPercent !== "number") continue;
      const minutes = window.windowDurationMins;
      const period =
        minutes === 300
          ? "5 Hours"
          : minutes === 10080
            ? "Weekly"
            : minutes
              ? `${minutes} min`
              : field;
      windows.push({
        label: period,
        minutes,
        detail: Object.keys(buckets).length > 1 ? bucket.limitName || key : "",
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
    ["five_hour", "5 Hours"],
    ["seven_day", "Weekly"],
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
      label: "Monthly",
      detail: key,
      minutes: 43200,
      remaining: value.remainingPercentage,
      resetsAt: value.resetDate || null,
    });
  }
  return validateSnapshot({ windows, observedAt: new Date().toISOString() });
}
