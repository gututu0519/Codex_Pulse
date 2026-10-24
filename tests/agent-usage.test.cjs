const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { normalizeTokens, readLogUsage } = require('../electron/agent-usage.cjs');

/** 创建独立日志目录，测试后清理，不接触真实会话。 */
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** 写入模拟会话事件，保持日志的逐行结构。 */
function writeLines(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}

test('各来源缓存及推理包含关系不重复计数，未知分类拒绝伪造', () => {
  const codex = normalizeTokens('codex', { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 });
  assert.deepEqual(codex, { input: 40, output: 15, reasoning: 5, cacheRead: 60, cacheWrite: 0, tool: 0, tokens: 120 });
  assert.equal(normalizeTokens('claude', { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 }).tokens, 100);
  const gemini = normalizeTokens('gemini', { input: 100, output: 20, cached: 60, thoughts: 5, tool: 2, total: 127 });
  assert.equal(gemini.tokens, 127);
  assert.equal(gemini.input, 40);
  assert.equal(normalizeTokens('claude', { input_tokens: 2 }), null);
  assert.equal(normalizeTokens('codex', { input_tokens: 1, output_tokens: 2, cached_input_tokens: 4 }), null);
});

test('Codex 跨日按累计差值统计，重复事件、归档副本不重复计数', async t => {
  const root = fixture(t), now = new Date(), start = new Date(now).setHours(0, 0, 0, 0);
  /** 构造带累计值和单次值的 Codex 用量事件。 */
  function event(at, input, output, lastInput, lastOutput) {
    return { type: 'event_msg', timestamp: new Date(at).toISOString(), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output, total_tokens: input + output }, last_token_usage: { input_tokens: lastInput, output_tokens: lastOutput, total_tokens: lastInput + lastOutput } } } };
  }
  const rows = [{ type: 'session_meta', payload: { id: 'same-session' } }, event(start - 1, 100, 10, 100, 10), event(start, 150, 15, 50, 5), event(start + 1, 150, 15, 50, 5), event(start + 2, 170, 17, 20, 2)];
  writeLines(path.join(root, 'sessions', 'a.jsonl'), rows);
  writeLines(path.join(root, 'archived_sessions', 'a.jsonl'), rows);
  const result = await readLogUsage('codex', [root], now);
  assert.equal(result.tokens, 77);
  assert.equal(result.messages, 2);
  assert.equal(result.sessions, 1);
  assert.equal(result.status, 'ok');
});

test('Claude 流式重复消息取最后有效用量，包含子会话，排除其他日期', async t => {
  const root = fixture(t), now = new Date();
  const row = { type: 'assistant', timestamp: now.toISOString(), sessionId: 'parent', requestId: 'r', message: { id: 'm', role: 'assistant', usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 20 } } };
  const final = { ...row, message: { ...row.message, usage: { ...row.message.usage, output_tokens: 5 } } };
  writeLines(path.join(root, 'project', 's.jsonl'), [row, final, { ...final, timestamp: '2000-01-01T00:00:00Z', message: { ...final.message, id: 'old' } }]);
  writeLines(path.join(root, 'project', 'subagents', 'agent.jsonl'), [{ ...row, sessionId: 'child', message: { ...row.message, id: 'child' } }]);
  const result = await readLogUsage('claude', [root], now);
  assert.equal(result.tokens, 66);
  assert.equal(result.sessions, 2);
  assert.equal(result.messages, 2);
});

test('Gemini 兼容 JSON 和 JSONL，迁移及更新不重复统计，回退不抹去已消耗用量', async t => {
  const root = fixture(t), now = new Date(), dir = path.join(root, 'project', 'chats');
  const message = { id: 'm', type: 'gemini', timestamp: now.toISOString(), tokens: { input: 100, output: 20, cached: 60, thoughts: 5, total: 125 } };
  const record = { sessionId: 's', messages: [message] };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(record));
  writeLines(path.join(dir, 'session.jsonl'), [{ sessionId: 's', projectHash: 'p' }, { ...message, tokens: null }, message, message, { $rewindTo: 'm' }]);
  const result = await readLogUsage('gemini', [root], now);
  assert.equal(result.tokens, 125);
  assert.equal(result.messages, 1);
  assert.equal(result.cacheRead, 60);
});

test('来源不存在、今日零调用、日志损坏和用量缺失分别标记', async t => {
  const root = fixture(t), now = new Date();
  assert.equal((await readLogUsage('claude', [path.join(root, 'missing')], now)).status, 'unavailable');
  assert.equal((await readLogUsage('claude', [root], now)).tokens, 0);
  writeLines(path.join(root, 'bad.jsonl'), [{ type: 'assistant', timestamp: now.toISOString(), message: { id: 'm', role: 'assistant' } }]);
  fs.appendFileSync(path.join(root, 'bad.jsonl'), '{broken');
  const result = await readLogUsage('claude', [root], now);
  assert.equal(result.status, 'partial');
  assert.equal(result.missing, 2);
});
