const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { dayRange, aggregateUsage, readOpenCodeUsage } = require('../electron/usage.cjs');

test('按完成时间跨会话统计，包含零点，排除次日、未完成和用户消息', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT)');
    const insert = db.prepare('INSERT INTO message VALUES(?,?,?)');
    const now = new Date(2026, 9, 8, 12);
    const { start, end } = dayRange(now);
    const samples = [
      ['a', 'old-session', { role: 'assistant', time: { created: start - 5000, completed: start }, tokens: { total: 100, input: 20, output: 10, reasoning: 5, cache: { read: 65, write: 0 } } }],
      ['b', 'subagent-session', { role: 'assistant', time: { completed: end - 1 }, tokens: { input: 2, output: 3, reasoning: 1, cache: { read: 4, write: 0 } } }],
      ['c', 'old-session', { role: 'assistant', time: { completed: end }, tokens: { total: 999 } }],
      ['d', 'old-session', { role: 'assistant', time: { created: start }, tokens: { total: 999 } }],
      ['e', 'old-session', { role: 'user', time: { completed: start }, tokens: { total: 999 } }],
      ['f', 'old-session', { role: 'assistant', time: { completed: start - 1 }, tokens: { total: 999 } }],
    ];
    for (const [id, session, data] of samples) insert.run(id, session, JSON.stringify(data));
    const result = aggregateUsage(db, now);
    assert.equal(result.tokens, 110);
    assert.equal(result.sessions, 2);
    assert.equal(result.messages, 2);
    assert.equal(result.cacheRead, 69);
    assert.equal(result.fallback, 1);
    assert.equal(aggregateUsage(db, new Date(2026, 9, 9, 12)).tokens, 999);
  } finally { db.close(); }
});

test('零调用返回零，缺失用量标记部分统计，不伪造已知总数', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE message(session_id TEXT, data TEXT)');
    const now = new Date();
    assert.equal(aggregateUsage(db, now).tokens, 0);
    db.prepare('INSERT INTO message VALUES(?,?)').run('s', JSON.stringify({ role: 'assistant', time: { completed: +now }, tokens: { input: 2 } }));
    const result = aggregateUsage(db, now);
    assert.equal(result.missing, 1);
    assert.equal(result.tokens, 0);
    assert.equal(result.messages, 1);
  } finally { db.close(); }
});

test('系统日历区间正确处理夏令时，不固定加二十四小时', () => {
  const original = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    const spring = dayRange(new Date(2026, 2, 8, 12));
    const autumn = dayRange(new Date(2026, 10, 1, 12));
    assert.equal(spring.end - spring.start, 23 * 3600000);
    assert.equal(autumn.end - autumn.start, 25 * 3600000);
  } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
});

test('数据库路径不存在时返回错误，不创建数据库或误报零消耗', () => {
  const result = readOpenCodeUsage(new Date(), 'Z:/missing-codex-pulse-test/opencode.db');
  assert.equal(result.tokens, null);
  assert.match(result.error, /无法读取 OpenCode/);
});
