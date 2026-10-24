const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { parentPort, workerData, isMainThread } = require('node:worker_threads');
const { dayRange, readOpenCodeUsage } = require('./usage.cjs');

const AGENTS = ['opencode', 'codex', 'claude', 'gemini'];
const fields = ['tokens', 'input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'tool'];

/** 只接受非负整数用量，缺失字段保留未知状态。 */
function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }

/** 创建统一的本地当日统计结构。 */
function emptyUsage(now) {
  return { date: dayRange(now).date, tokens: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, tool: 0, messages: 0, sessions: 0, missing: 0, updatedAt: +now, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, error: null, status: 'ok' };
}

/** 将不同厂商字段转为互不重叠的分类；总数优先采用上游记录。 */
function normalizeTokens(agent, usage) {
  if (!usage || typeof usage !== 'object') return null;
  let input, output, reasoning, cacheRead, cacheWrite, tool = 0, total;
  if (agent === 'codex') {
    input = count(usage.input_tokens); output = count(usage.output_tokens);
    cacheRead = count(usage.cached_input_tokens ?? 0); cacheWrite = count(usage.cache_write_input_tokens ?? 0);
    reasoning = count(usage.reasoning_output_tokens ?? 0); total = count(usage.total_tokens);
    if (input !== null && cacheRead !== null && cacheWrite !== null) input -= cacheRead + cacheWrite;
    if (output !== null && reasoning !== null) output -= reasoning;
  } else if (agent === 'claude') {
    input = count(usage.input_tokens); output = count(usage.output_tokens);
    cacheRead = count(usage.cache_read_input_tokens ?? 0); cacheWrite = count(usage.cache_creation_input_tokens ?? 0);
    reasoning = 0; total = null;
  } else {
    input = count(usage.input); output = count(usage.output); reasoning = count(usage.thoughts ?? 0);
    cacheRead = count(usage.cached ?? 0); cacheWrite = 0; tool = count(usage.tool ?? 0); total = count(usage.total);
    if (input !== null && cacheRead !== null) input -= cacheRead;
  }
  const parts = { input, output, reasoning, cacheRead, cacheWrite, tool };
  if (Object.values(parts).some(value => value === null || value < 0)) return null;
  return { ...parts, tokens: total ?? Object.values(parts).reduce((a, b) => a + b, 0) };
}

/** 递归枚举会话文件，不跟随符号链接，不读取认证文件。 */
async function* sessionFiles(directory, agent) {
  for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* sessionFiles(file, agent);
    else if (entry.isFile() && (agent === 'gemini' ? /\.jsonl?$/.test(file) && file.split(path.sep).includes('chats') : file.endsWith('.jsonl'))) yield file;
  }
}

/** 流式读取日志，仅保留用于统计的元数据；损坏记录会标记部分统计。 */
async function readLogUsage(agent, roots, now = new Date()) {
  const result = emptyUsage(now), range = dayRange(now), records = new Map();
  let detected = false;
  for (const root of roots) {
    try { await fs.promises.access(root); } catch (error) {
      if (error.code === 'ENOENT') continue;
      result.missing++; result.error = `无法访问会话目录：${error.code}`; continue;
    }
    detected = true;
    try {
      for await (const file of sessionFiles(root, agent)) {
        try {
          if ((await fs.promises.stat(file)).mtimeMs < range.start) continue;
          let session = path.basename(file), previous = null;
          /** 处理单条会话元数据，按稳定消息标识去重并保留最终用量。 */
          function accept(row) {
            if (!row || typeof row !== 'object') return;
            if (agent === 'codex' && row.type === 'session_meta') { session = row.payload?.id || session; return; }
            if (agent === 'gemini' && row.sessionId) session = row.sessionId;
            let timestamp = row.timestamp, usage, key;
            if (agent === 'codex') {
              if (row.type !== 'event_msg' || row.payload?.type !== 'token_count' || !row.payload.info) return;
              const info = row.payload.info, total = info.total_token_usage;
              if (!total) { result.missing++; return; }
              usage = info.last_token_usage || total;
              if (previous && count(total.total_tokens) !== null && total.total_tokens >= previous.total_tokens) {
                if (total.total_tokens === previous.total_tokens) return;
                usage = Object.fromEntries(Object.keys(total).map(key => [key, total[key] - (previous[key] ?? 0)]));
              }
              previous = total;
              key = `${timestamp}:${JSON.stringify(total)}`;
            } else if (agent === 'claude') {
              if (row.type !== 'assistant' || row.message?.role !== 'assistant') return;
              session = row.sessionId || session;
              usage = row.message.usage;
              key = row.message.id ? `${row.message.id}:${row.requestId || ''}` : row.uuid;
            } else {
              if (Array.isArray(row.messages)) { for (const message of row.messages) accept(message); return; }
              if (row.$set?.messages) { for (const message of row.$set.messages) accept(message); return; }
              if (row.type !== 'gemini') return;
              usage = row.tokens; key = row.id ? `${session}:${row.id}` : null;
            }
            const at = Date.parse(timestamp);
            if (!Number.isFinite(at)) { result.missing++; return; }
            if (at < range.start || at >= range.end) return;
            if (!key) { result.missing++; return; }
            const tokens = normalizeTokens(agent, usage);
            const existing = records.get(key);
            if (!existing || tokens) records.set(key, { session, tokens });
          }
          if (agent === 'gemini' && file.endsWith('.json')) accept(JSON.parse(await fs.promises.readFile(file, 'utf8')));
          else {
            const stream = fs.createReadStream(file, { encoding: 'utf8' });
            const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
            try {
              for await (const line of lines) {
                if (!line.trim()) continue;
                try { accept(JSON.parse(line)); } catch { result.missing++; }
              }
            } finally { lines.close(); stream.destroy(); }
          }
        } catch (error) { result.missing++; result.error = `部分会话读取失败：${error.code || '日志格式异常'}`; }
      }
    } catch (error) { result.missing++; result.error = `会话目录读取失败：${error.code || '未知错误'}`; }
  }
  const sessions = new Set();
  let known = 0;
  for (const record of records.values()) {
    result.messages++; sessions.add(record.session);
    if (!record.tokens) { result.missing++; continue; }
    known++;
    for (const key of fields) result[key] += record.tokens[key];
  }
  result.sessions = sessions.size;
  result.status = result.missing ? 'partial' : detected ? 'ok' : 'unavailable';
  if (!detected || (result.missing && !known)) result.tokens = null;
  return result;
}

/** 汇总四个独立来源，单一来源不可用不会阻断其他来源。 */
async function readAllUsage(now = new Date()) {
  const home = os.homedir();
  const codex = process.env.CODEX_HOME || path.join(home, '.codex');
  const sources = { opencode: readOpenCodeUsage(now) };
  sources.opencode.status ||= sources.opencode.error ? 'error' : sources.opencode.missing ? 'partial' : 'ok';
  const roots = {
    codex: [path.join(codex, 'sessions'), path.join(codex, 'archived_sessions')],
    claude: [path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects')],
    gemini: [path.join(process.env.GEMINI_CLI_HOME || home, '.gemini', 'tmp')],
  };
  await Promise.all(Object.entries(roots).map(async ([agent, directories]) => { sources[agent] = await readLogUsage(agent, directories, now); }));
  return { date: dayRange(now).date, updatedAt: +now, sources };
}

if (!isMainThread && require.main === module) readAllUsage(new Date(workerData.now)).then(result => parentPort.postMessage(result));
module.exports = { AGENTS, normalizeTokens, readLogUsage, readAllUsage };
