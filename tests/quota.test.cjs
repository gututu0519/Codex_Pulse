const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeWindow, normalizeQuota, normalizeResetCredits, collectAlerts } = require('../electron/quota.cjs');

test('重置卡区分未知与零张，并使用官方数量而不是截断后的明细条数', () => {
  assert.equal(normalizeResetCredits(undefined), null);
  assert.equal(normalizeResetCredits({ availableCount: -1 }), null);
  assert.deepEqual(normalizeResetCredits({ availableCount: 0, credits: [] }), { availableCount: 0, credits: [] });
  assert.deepEqual(normalizeResetCredits({ availableCount: 2, credits: null }), { availableCount: 2, credits: null });
  const quota = normalizeQuota({ rateLimits: {}, rateLimitResetCredits: { availableCount: 3, credits: [{ status: 'available', expiresAt: 123 }] } });
  assert.equal(quota.resetCredits.availableCount, 3);
  assert.equal(quota.resetCredits.credits.length, 1);
  assert.equal(quota.resetCredits.credits[0].expiresAt, 123);
  assert.deepEqual(collectAlerts(quota, 'credits-only', new Set()), []);
});

test('仅有周额度的账号不生成第二窗口，提醒使用真实周期', () => {
  const quota = normalizeQuota({ rateLimits: { primary: { usedPercent: 92, windowDurationMins: 10080 }, secondary: null } });
  assert.equal(quota.secondary, null);
  assert.deepEqual(collectAlerts(quota, 'weekly-account', new Set()), ['每周额度仅剩 8%']);
});

test('官方已用比例转换为剩余比例，未知额度不伪装为零', () => {
  assert.equal(normalizeWindow({ usedPercent: 28 }).remaining, 72);
  assert.equal(normalizeWindow({ usedPercent: 104 }).remaining, 0);
  assert.equal(normalizeWindow({ usedPercent: -4 }).remaining, 100);
  assert.equal(normalizeWindow({ usedPercent: null }), null);
  assert.equal(normalizeWindow({ usedPercent: NaN }), null);
  assert.equal(normalizeWindow(null), null);
});

test('优先 Codex 桶，兼容旧接口并保留实际窗口和重置时间', () => {
  const response = { rateLimits: { primary: { usedPercent: 90 } }, rateLimitsByLimitId: { codex: { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 123 }, secondary: null } } };
  assert.deepEqual(normalizeQuota(response).primary, { remaining: 80, minutes: 300, resetsAt: 123 });
  assert.equal(normalizeQuota({ rateLimits: response.rateLimits }).primary.remaining, 10);
  assert.throws(() => normalizeQuota({}), /未返回/);
});

test('低额度提醒按账号、重置窗口和阈值去重', () => {
  const seen = new Set();
  const quota = { primary: { remaining: 19, resetsAt: 123 } };
  assert.equal(collectAlerts(quota, 'a', seen).length, 1);
  assert.equal(collectAlerts(quota, 'a', seen).length, 0);
  quota.primary.remaining = 9;
  assert.equal(collectAlerts(quota, 'a', seen).length, 1);
  quota.primary.remaining = 15;
  assert.equal(collectAlerts(quota, 'a', seen).length, 0);
  quota.primary.resetsAt = 456;
  assert.equal(collectAlerts(quota, 'a', seen).length, 1);
  assert.equal(collectAlerts(quota, 'b', seen).length, 1);
});
