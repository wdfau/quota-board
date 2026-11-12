import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateSnapshot,
  codexSnapshot,
  claudeSnapshot,
  copilotSnapshot,
} from "../core/model.js";
import { Store } from "../core/store.js";

const snapshot = () => ({
  observedAt: new Date().toISOString(),
  windows: [{ label: "5 小时", remaining: 0, resetsAt: null }],
});

test("zero is valid, missing/non-finite/negative quota is unknown", () => {
  assert.equal(validateSnapshot(snapshot()).windows[0].remaining, 0);
  for (const value of [null, undefined, NaN, -1, 101, "50"]) {
    const input = snapshot();
    input.windows[0].remaining = value;
    assert.throws(() => validateSnapshot(input));
  }
  assert.throws(() =>
    validateSnapshot({ ...snapshot(), observedAt: "invalid" }),
  );
});
test("Codex keeps independent buckets and uses reported windows", () => {
  const result = codexSnapshot({
    rateLimitsByLimitId: {
      codex: {
        primary: {
          usedPercent: 92,
          windowDurationMins: 300,
          resetsAt: 1900000000,
        },
      },
      review: { secondary: { usedPercent: 0, windowDurationMins: 10080 } },
    },
  });
  assert.equal(result.windows.length, 2);
  assert.equal(result.windows[0].remaining, 8);
  assert.match(result.windows[1].label, /review/);
  assert.throws(() => codexSnapshot({}));
});
test("Claude missing window remains absent and zero usage gives 100%", () => {
  assert.equal(
    claudeSnapshot({ rate_limits: { five_hour: { used_percentage: 0 } } })
      .windows[0].remaining,
    100,
  );
  assert.throws(() => claudeSnapshot({ rate_limits: {} }));
});
test("Copilot omits unlimited and missing entitlements", () => {
  const result = copilotSnapshot({
    quotaSnapshots: {
      unlimited: { entitlementRequests: -1, remainingPercentage: 100 },
      absent: undefined,
      premium_interactions: {
        entitlementRequests: 300,
        remainingPercentage: 80,
      },
    },
  });
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].remaining, 80);
});

async function withStore(callback) {
  const directory = await mkdtemp(join(tmpdir(), "quota-board-test-"));
  try {
    await callback(new Store(directory), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test("failure retains the original snapshot timestamp and restart clears transient errors", async () => {
  await withStore(async (store, directory) => {
    const account = await store.add({
      provider: "codex",
      mode: "codex",
      label: "Test",
    });
    const good = { ...snapshot(), identityKey: "account-a", source: "test" };
    await store.refresh(account.id, async () => good);
    await store.refresh(account.id, async () => {
      throw new Error("server failure");
    });
    assert.equal(account.snapshot.observedAt, good.observedAt);
    assert.ok(account.error);
    const restored = new Store(directory);
    await restored.load();
    assert.equal(restored.accounts[0].snapshot.observedAt, good.observedAt);
    assert.equal(restored.accounts[0].error, null);
  });
});
test("changed account identity clears old data", async () => {
  await withStore(async (store) => {
    const account = await store.add({
      provider: "codex",
      mode: "codex",
      label: "Test",
    });
    await store.refresh(account.id, async () => ({
      ...snapshot(),
      identityKey: "a",
    }));
    await store.refresh(account.id, async () => ({
      ...snapshot(),
      identityKey: "b",
    }));
    assert.equal(account.snapshot, null);
    assert.equal(account.identityKey, "a");
    assert.match(account.error, /登录账号发生变化/);
  });
});
test("removing an account during a refresh cannot resurrect it", async () => {
  await withStore(async (store) => {
    const account = await store.add({
      provider: "codex",
      mode: "codex",
      label: "Test",
    });
    let finish;
    const pending = store.refresh(
      account.id,
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await store.remove(account.id);
    finish({ ...snapshot(), identityKey: "a" });
    await pending;
    assert.equal(store.accounts.length, 0);
  });
});
test("manual records persist independently and reject unsupported provider mode", async () => {
  await withStore(async (store, directory) => {
    await assert.rejects(
      store.add({ provider: "cursor", mode: "codex", label: "Test" }),
    );
    const a = await store.add({
      provider: "cursor",
      mode: "manual",
      label: "Work",
    });
    const b = await store.add({
      provider: "cursor",
      mode: "manual",
      label: "Personal",
    });
    await Promise.all([
      store.record(a.id, snapshot()),
      store.record(b.id, snapshot()),
    ]);
    const restored = new Store(directory);
    await restored.load();
    assert.equal(restored.accounts.length, 2);
    assert.ok(restored.accounts.every((account) => account.snapshot));
  });
});
