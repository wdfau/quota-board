import assert from "node:assert/strict";
import { test } from "node:test";
import { codexSnapshot, claudeSnapshot, copilotSnapshot } from "../core/model.js";
import { shortest } from "../core/services.js";

test("overview picks the shortest window regardless of bucket order", () => {
  const { windows } = codexSnapshot({ rateLimitsByLimitId: {
    week: { primary: { windowDurationMins: 10080, usedPercent: 80 } },
    short: { primary: { windowDurationMins: 300, usedPercent: 12 } },
  } });
  assert.equal(windows.length, 2);
  assert.equal(shortest(windows).label, "5 Hours");
  assert.equal(shortest(windows).remaining, 88);
});

test("missing provider quota is not displayed as a full or empty allowance", () => {
  assert.deepEqual(codexSnapshot({}).windows, []);
  assert.deepEqual(claudeSnapshot({}).windows, []);
  assert.deepEqual(copilotSnapshot({ quotaSnapshots: { chat: { isUnlimitedEntitlement: true, remainingPercentage: 100 } } }).windows, []);
});
