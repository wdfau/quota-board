import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { floatingSelection, constrainPosition } from "../core/floating.js";
import { Store } from "../core/store.js";

test("floating selection pins an account and period and handles removed windows", () => {
  const accounts = [
    {
      id: "a",
      snapshot: {
        windows: [
          { label: "5 小时", remaining: 80 },
          { label: "每周", remaining: 62 },
        ],
      },
    },
    { id: "b", snapshot: null },
  ];
  assert.equal(
    floatingSelection(accounts, { accountId: "a", windowLabel: "每周" }).quota
      .remaining,
    62,
  );
  assert.equal(
    floatingSelection(accounts, { accountId: "a", windowLabel: "old" }).quota
      .label,
    "5 小时",
  );
  assert.equal(
    floatingSelection(accounts, { accountId: "b" }).quota,
    undefined,
  );
  assert.equal(
    floatingSelection(accounts, { accountId: "deleted" }).account.id,
    "a",
  );
  assert.deepEqual(floatingSelection([]), {
    account: undefined,
    quota: undefined,
  });
});
test("floating position remains reachable on negative-coordinate monitors", () => {
  const area = { x: -1920, y: -120, width: 1920, height: 1080 };
  assert.deepEqual(
    constrainPosition({ x: -2500, y: 1800 }, area, { width: 104, height: 104 }),
    { x: -1920, y: 856 },
  );
});
test("primary selection and position survive restart with existing v1 data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quota-float-test-"));
  try {
    const store = new Store(directory);
    const account = await store.add({
      provider: "cursor",
      mode: "manual",
      label: "Test",
    });
    await store.record(account.id, {
      observedAt: new Date().toISOString(),
      windows: [{ label: "每月", remaining: 62 }],
    });
    await store.selectFloating(account.id, "每月");
    await store.saveFloatingPosition({ x: 120, y: 150 });
    const restored = new Store(directory);
    await restored.load();
    assert.equal(
      floatingSelection(restored.accounts, restored.preferences.floating)
        .account.id,
      account.id,
    );
    assert.deepEqual(restored.preferences.floatingPosition, { x: 120, y: 150 });
    await assert.rejects(store.selectFloating(account.id, "missing"));
    await store.remove(account.id);
    assert.equal(
      floatingSelection(store.accounts, store.preferences.floating).account,
      undefined,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
