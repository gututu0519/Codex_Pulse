const { DatabaseSync } = require('node:sqlite');
const { isMainThread, parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');
const os = require('node:os');

/** 使用系统日历计算半开区间，兼容夏令时造成的非二十四小时日。 */
function dayRange(now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const date = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
  return { start: +start, end: +end, date };
}

/** 按消息完成时间汇总全部项目与模型，只读取用量元数据，避免重复叠加步骤和会话总数。 */
function aggregateUsage(db, now = new Date()) {
  const range = dayRange(now);
  const result = { date: range.date, tokens: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, messages: 0, sessions: 0, missing: 0, fallback: 0, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, updatedAt: +now, error: null };
  const sessions = new Set();
  const hasV2 = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_message'").get();
  const table = hasV2 ? 'session_message' : 'message';
  const role = hasV2 ? "type = 'assistant'" : "json_extract(data, '$.role') = 'assistant'";
  const rows = db.prepare(`SELECT session_id, json_extract(data, '$.tokens') AS tokens
    FROM ${table} WHERE json_valid(data) AND ${role}
    AND json_extract(data, '$.time.completed') >= ? AND json_extract(data, '$.time.completed') < ?`);
  for (const row of rows.iterate(range.start, range.end)) {
    const tokens = row.tokens ? JSON.parse(row.tokens) : null;
    result.messages++;
    sessions.add(row.session_id);
    if (!tokens || typeof tokens !== 'object') { result.missing++; continue; }
    const parts = { input: tokens.input, output: tokens.output, reasoning: tokens.reasoning, cacheRead: tokens.cache?.read, cacheWrite: tokens.cache?.write };
    for (const [key, value] of Object.entries(parts)) if (Number.isSafeInteger(value) && value >= 0) result[key] += value;
    if (Number.isSafeInteger(tokens.total) && tokens.total >= 0) result.tokens += tokens.total;
    else if (Object.values(parts).every(value => Number.isSafeInteger(value) && value >= 0)) {
      result.tokens += Object.values(parts).reduce((sum, value) => sum + value, 0);
      result.fallback++;
    } else result.missing++;
  }
  result.sessions = sessions.size;
  return result;
}

/** 短连接只读打开 OpenCode 数据库，支持默认 XDG 路径和显式路径覆盖。 */
function readOpenCodeUsage(now = new Date(), filename = process.env.OPENCODE_DB_PATH || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'opencode.db')) {
  let db;
  try {
    db = new DatabaseSync(filename, { readOnly: true });
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1500;');
    return aggregateUsage(db, now);
  } catch (error) {
    return { date: dayRange(now).date, tokens: null, updatedAt: +now, error: `无法读取 OpenCode 用量，请检查数据库路径或版本：${error.message}` };
  } finally { db?.close(); }
}

if (!isMainThread) parentPort.postMessage(readOpenCodeUsage(new Date(workerData.now)));
module.exports = { dayRange, aggregateUsage, readOpenCodeUsage };
