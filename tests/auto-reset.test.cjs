const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AutoReset, plannedTime, isWorking, nextWorkTime, hasLowQuota } = require('../electron/auto-reset.cjs');

/** 创建独立临时记录及模拟官方接口，测试永不调用真实兑换服务。 */
function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-reset-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = { now: Date.parse('2026-10-08T08:00:00-04:00'), enabled: true, calls: [], notifications: [], reads: 0 };
  const snapshot = { accountKey: 'test-account', credits: { availableCount: 1, credits: [{ id: 'card-a', resetType: 'codexRateLimits', status: 'available', expiresAt: Date.parse('2026-10-08T15:00:00-04:00') / 1000 }] } };
  const config = {
    filePath: path.join(dir, 'auto-reset.json'), clock: () => state.now, enabled: () => state.enabled,
    readSnapshot: async () => { state.reads++; return structuredClone(snapshot); },
    consume: async params => { state.calls.push(params); return { outcome: 'reset' }; },
    notify: message => state.notifications.push(message), ...options,
  };
  return { state, snapshot, config, engine: new AutoReset(config) };
}

test('纽约工作时段计划：白天、非工作时间、凌晨到期均提前一小时', () => {
  for (const [expiry, expected] of [
    ['2026-10-08T06:00:00-04:00', '2026-10-08T05:00:00-04:00'],
    ['2026-10-08T09:00:00-04:00', '2026-10-08T08:00:00-04:00'],
    ['2026-10-08T15:00:00-04:00', '2026-10-08T08:00:00-04:00'],
    ['2026-10-09T00:30:00-04:00', '2026-10-08T08:00:00-04:00'],
    ['2026-10-09T01:30:00-04:00', '2026-10-08T08:00:00-04:00'],
  ]) assert.equal(plannedTime(Date.parse(expiry)), Date.parse(expected));
  assert.equal(isWorking(Date.parse('2026-10-08T01:00:00-04:00')), true);
  assert.equal(isWorking(Date.parse('2026-10-08T09:00:00-04:00')), false);
  assert.equal(nextWorkTime(Date.parse('2026-10-08T23:00:00-04:00')), Date.parse('2026-10-09T01:00:00-04:00'));
});

test('夏令时跳时和重复一小时按真实时刻排程，不依赖系统时区', () => {
  assert.equal(plannedTime(Date.parse('2026-03-08T03:30:00-04:00')), Date.parse('2026-03-08T01:30:00-05:00'));
  assert.equal(plannedTime(Date.parse('2026-11-01T01:30:00-05:00')), Date.parse('2026-11-01T01:30:00-04:00'));
  assert.equal(plannedTime(Date.parse('2026-11-01T01:30:00-04:00')), Date.parse('2026-10-31T08:00:00-04:00'));
});

test('到点前不消费，消费前落盘，成功后重启不会重复使用', async t => {
  const { state, config, engine } = setup(t);
  state.now -= 1000;
  assert.equal((await engine.tick()).status, 'planned');
  assert.equal(state.calls.length, 0);
  state.now += 1000;
  engine.consume = async params => {
    const saved = JSON.parse(fs.readFileSync(config.filePath, 'utf8'));
    assert.equal(Object.values(saved.entries)[0].idempotencyKey, params.idempotencyKey);
    assert.equal(Object.values(saved.entries)[0].outcome, 'pending');
    state.calls.push(params);
    return { outcome: 'reset' };
  };
  assert.equal((await engine.tick()).status, 'success');
  assert.equal(state.reads, 4); // 首次计划读取、兑换前两次复核、兑换后刷新。
  await new AutoReset(config).tick();
  assert.equal(state.calls.length, 1);
});

test('关闭、非工作时段和已过期均不自动消费', async t => {
  const { state, engine } = setup(t);
  state.enabled = false;
  await engine.tick();
  assert.equal(state.reads, 0);
  state.enabled = true;
  state.now = Date.parse('2026-10-08T09:00:00-04:00');
  assert.match((await engine.tick()).message, /错过/);
  state.now = Date.parse('2026-10-08T15:00:00-04:00');
  await engine.tick();
  assert.equal(state.calls.length, 0);
});

test('工作时间内错过计划可立即尝试，但不使用无期限或不支持的卡', async t => {
  const { state, snapshot, engine } = setup(t);
  state.now = Date.parse('2026-10-08T08:55:00-04:00');
  snapshot.credits.credits.unshift({ id: 'unknown', status: 'available', resetType: 'codexRateLimits', expiresAt: null });
  snapshot.credits.credits.unshift({ id: 'other', status: 'available', resetType: 'other', expiresAt: state.now / 1000 + 100 });
  await engine.tick();
  assert.equal(state.calls[0].creditId, 'card-a');
});

test('请求超时后重启复用幂等键，并将 alreadyRedeemed 视为成功', async t => {
  const { state, config, engine } = setup(t);
  engine.consume = async params => { state.calls.push(params); throw new Error('超时'); };
  assert.equal((await engine.tick()).status, 'error');
  state.now += 5 * 60000;
  const restarted = new AutoReset({ ...config, consume: async params => { state.calls.push(params); return { outcome: 'alreadyRedeemed' }; } });
  assert.equal((await restarted.tick()).status, 'success');
  assert.equal(state.calls[0].idempotencyKey, state.calls[1].idempotencyKey);
});

test('nothingToReset 五分钟后才作为新操作重试，noCredit 不再重试该卡', async t => {
  const { state, config, engine } = setup(t);
  engine.consume = async params => { state.calls.push(params); return { outcome: 'nothingToReset' }; };
  await engine.tick();
  state.now += 4 * 60000;
  await engine.tick();
  assert.equal(state.calls.length, 1);
  state.now += 60000;
  engine.consume = async params => { state.calls.push(params); return { outcome: 'noCredit' }; };
  await engine.tick();
  assert.notEqual(state.calls[0].idempotencyKey, state.calls[1].idempotencyKey);
  await new AutoReset(config).tick();
  assert.equal(state.calls.length, 2);
});

test('兑换前复核发现账号变化或离开工作时段时停止', async t => {
  const { state, snapshot, engine } = setup(t);
  let count = 0;
  engine.readSnapshot = async () => ({ ...snapshot, accountKey: ++count === 1 ? 'a' : 'b' });
  await engine.tick();
  assert.equal(state.calls.length, 0);
  count = 0;
  engine.readSnapshot = async () => { if (++count === 2) state.now = Date.parse('2026-10-08T09:00:00-04:00'); return snapshot; };
  await engine.tick();
  assert.equal(state.calls.length, 0);
});

test('多张卡按最早到期串行使用，并发检查不会重复发送', async t => {
  const { state, snapshot, engine } = setup(t);
  snapshot.credits.credits.push({ ...snapshot.credits.credits[0], id: 'earlier', expiresAt: Date.parse('2026-10-08T10:00:00-04:00') / 1000 });
  await Promise.all([engine.tick(), engine.tick(), engine.tick()]);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].creditId, 'earlier');
  await engine.tick();
  assert.equal(state.calls[1].creditId, 'card-a');
});

test('记录损坏或无法写入时不发送兑换，保护重启后的幂等状态', async t => {
  const { state, config } = setup(t);
  fs.writeFileSync(config.filePath, 'broken');
  assert.equal((await new AutoReset(config).tick()).status, 'error');
  const bad = new AutoReset({ ...config, filePath: path.join(path.dirname(config.filePath), 'no-parent', 'journal.json') });
  assert.equal((await bad.tick()).status, 'error');
  assert.equal(state.calls.length, 0);
});

test('低额度使用原始严格小于 1% 阈值，未知、负数和 1% 不触发', () => {
  for (const remaining of [0, 0.5, 0.99, 0.9999]) assert.equal(hasLowQuota({ primary: { remaining } }), true);
  for (const remaining of [1, 1.01, 100, null, undefined, NaN, -1]) assert.equal(hasLowQuota({ primary: { remaining } }), false);
  assert.equal(hasLowQuota({ primary: { remaining: 80 }, secondary: { remaining: 0.1 } }), true);
  assert.equal(hasLowQuota(null), false);
});

test('低于 1% 在纽约夜间也可使用未临期卡，额度恢复后停止继续使用', async t => {
  const { state, snapshot, engine } = setup(t, { lowEnabled: () => true, expiryEnabled: () => false });
  state.now = Date.parse('2026-10-08T22:00:00-04:00');
  snapshot.quota = { primary: { remaining: 0.99 } };
  snapshot.credits.credits[0].expiresAt = Date.parse('2026-10-22T15:00:00-04:00') / 1000;
  snapshot.credits.credits.push({ ...snapshot.credits.credits[0], id: 'card-b', expiresAt: snapshot.credits.credits[0].expiresAt + 86400 });
  engine.consume = async params => { state.calls.push(params); snapshot.quota.primary.remaining = 100; return { outcome: 'reset' }; };
  await Promise.all([engine.tick(), engine.tick()]);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].creditId, 'card-a');
  await engine.tick();
  assert.equal(state.calls.length, 1);
});

test('全天规则关闭或兑换前余量恢复至 1% 时不使用', async t => {
  const { state, snapshot, engine } = setup(t, { lowEnabled: () => true, expiryEnabled: () => false });
  state.now = Date.parse('2026-10-08T22:00:00-04:00');
  snapshot.quota = { primary: { remaining: 0 } };
  snapshot.credits.credits[0].expiresAt += 86400;
  let reads = 0;
  engine.readSnapshot = async () => { if (++reads === 2) snapshot.quota.primary.remaining = 1; return structuredClone(snapshot); };
  await engine.tick();
  assert.equal(state.calls.length, 0);
  snapshot.quota.primary.remaining = 0;
  engine.lowEnabled = () => false;
  await engine.tick();
  assert.equal(state.calls.length, 0);
});

test('全天低额度超时重启继续复用原幂等键，已过期卡不参与', async t => {
  const { state, snapshot, config, engine } = setup(t, { lowEnabled: () => true, expiryEnabled: () => false });
  state.now = Date.parse('2026-10-08T22:00:00-04:00');
  snapshot.quota = { primary: { remaining: 0 } };
  snapshot.credits.credits.push({ ...snapshot.credits.credits[0], id: 'valid', expiresAt: snapshot.credits.credits[0].expiresAt + 86400 });
  engine.consume = async params => { state.calls.push(params); throw new Error('超时'); };
  await engine.tick();
  assert.equal(state.calls[0].creditId, 'valid');
  state.now += 5 * 60000;
  await new AutoReset(config).tick();
  assert.equal(state.calls.length, 2);
  assert.equal(state.calls[0].idempotencyKey, state.calls[1].idempotencyKey);
});

test('无到期时间的可用卡可用于低额度恢复，且排在已知期限卡之后', async t => {
  const { state, snapshot, engine } = setup(t, { lowEnabled: () => true, expiryEnabled: () => false });
  snapshot.quota = { secondary: { remaining: 0.1 } };
  snapshot.credits.credits.unshift({ id: 'undated', status: 'available', resetType: 'codexRateLimits', expiresAt: null });
  await engine.tick();
  assert.equal(state.calls[0].creditId, 'card-a');
  await engine.tick();
  assert.equal(state.calls[1].creditId, 'undated');
});
