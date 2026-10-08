const { Temporal } = require('@js-temporal/polyfill');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');

const ZONE = 'America/New_York';
const HOUR = 3600000;
const RETRY = 5 * 60000;
const TERMINAL = new Set(['reset', 'alreadyRedeemed', 'noCredit', 'expired', 'unavailable']);

/** 将绝对时间转换为纽约日历时间，自动应用夏令时。 */
function nyTime(milliseconds) {
  return Temporal.Instant.fromEpochMilliseconds(milliseconds).toZonedDateTimeISO(ZONE);
}

/** 选择距过期至少一小时且位于每天 01:00–08:00 的最晚计划时刻。 */
function plannedTime(expiresAt) {
  const deadline = expiresAt - HOUR;
  const local = nyTime(deadline);
  const start = local.startOfDay().with({ hour: 1 });
  if (deadline < start.epochMilliseconds) return local.subtract({ days: 1 }).startOfDay().with({ hour: 8 }).epochMilliseconds;
  return Math.min(deadline, local.startOfDay().with({ hour: 8 }).epochMilliseconds);
}

/** 实际发送兑换只允许在纽约每天 01:00（含）至 09:00（不含）。 */
function isWorking(milliseconds) {
  const hour = nyTime(milliseconds).hour;
  return hour >= 1 && hour < 9;
}

/** 错过计划后寻找下一次可执行时刻，不把非工作时间当作补执行窗口。 */
function nextWorkTime(milliseconds) {
  if (isWorking(milliseconds)) return milliseconds;
  const local = nyTime(milliseconds);
  return (local.hour < 1 ? local : local.add({ days: 1 })).startOfDay().with({ hour: 1 }).epochMilliseconds;
}

/** 为账号与卡片生成不可冲突的本地记录键，不持久化账号邮箱。 */
function recordKey(accountKey, creditId) {
  return createHash('sha256').update(JSON.stringify([accountKey, creditId])).digest('hex');
}

/** 根据接口原始剩余比例判断任一窗口是否严格低于 1%，不使用显示取整值。 */
function hasLowQuota(quota) {
  return [quota?.primary, quota?.secondary].some(window => Number.isFinite(window?.remaining) && window.remaining >= 0 && window.remaining < 1);
}

/** 持久化、串行执行临期兑换；所有网络依赖可注入以进行无真实消费测试。 */
class AutoReset {
  /** 读取执行记录，损坏时停止自动兑换，避免丢失未确认请求的幂等标识。 */
  constructor({ filePath, readSnapshot, consume, enabled, expiryEnabled = () => true, lowEnabled = () => false, notify = () => {}, onChange = () => {}, clock = Date.now }) {
    Object.assign(this, { filePath, readSnapshot, consume, enabled, expiryEnabled, lowEnabled, notify, onChange, clock });
    this.journal = { version: 1, entries: {}, last: null };
    this.busy = false;
    this.view = { status: 'waiting', message: '等待卡片同步', nextAt: null, last: null };
    try {
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (saved.version !== 1 || !saved.entries || typeof saved.entries !== 'object' || Array.isArray(saved.entries)) throw new Error('执行记录格式不正确');
      for (const entry of Object.values(saved.entries)) {
        if (!entry || typeof entry.creditId !== 'string' || typeof entry.account !== 'string' || (entry.expiresAt !== null && !Number.isFinite(entry.expiresAt)) || typeof entry.outcome !== 'string' || (entry.idempotencyKey !== null && typeof entry.idempotencyKey !== 'string')) throw new Error('执行记录不完整');
        if (entry.outcome === 'pending' && !entry.idempotencyKey) throw new Error('未确认请求缺少幂等标识');
      }
      this.journal = saved;
    } catch (error) { if (error.code !== 'ENOENT') this.loadError = '自动用卡记录无法读取，请检查 auto-reset.json。'; }
  }

  /** 原子替换记录文件；写入成功之前绝不发送兑换请求。 */
  save() {
    fs.writeFileSync(`${this.filePath}.tmp`, JSON.stringify(this.journal, null, 2));
    fs.renameSync(`${this.filePath}.tmp`, this.filePath);
  }

  /** 更新对外展示，不暴露卡片标识和幂等键。 */
  show(status, message, nextAt = null) {
    this.view = { status, message, nextAt, last: this.journal.last };
    this.onChange();
    return this.view;
  }

  /** 保存执行结果，并对新的结果发送一次系统通知。 */
  result(entry, outcome, message) {
    const changed = entry.outcome !== outcome;
    entry.outcome = outcome;
    entry.retryAt = this.clock() + RETRY;
    this.journal.last = { at: this.clock(), message };
    this.save();
    if (changed) { try { this.notify(message); } catch { /* 系统通知失败不改变已保存的兑换结果。 */ } }
  }

  /** 低额度规则全天生效，临期规则单独遵守纽约工作时段。 */
  trigger(snapshot, expiresAt, now) {
    if (this.lowEnabled() && hasLowQuota(snapshot?.quota)) return 'low';
    if (this.expiryEnabled() && Number.isFinite(expiresAt) && isWorking(now) && plannedTime(expiresAt) <= now) return 'expiry';
    return null;
  }

  /** 单次检查只兑换一张，重新读取卡片后复核账号、工作时段和到期状态。 */
  async tick() {
    if (this.busy) return this.view;
    if (!this.enabled()) return this.show('disabled', '自动用卡已关闭');
    if (this.loadError) return this.show('error', this.loadError);
    this.busy = true;
    try {
      const snapshot = await this.readSnapshot();
      if (!this.enabled()) return this.show('disabled', '自动用卡已关闭');
      if (!snapshot?.accountKey) return this.show('waiting', '等待 ChatGPT 账号连接');
      const account = recordKey(snapshot.accountKey, 'account');
      const now = this.clock();
      for (const entry of Object.values(this.journal.entries)) {
        if (entry.account === account && !TERMINAL.has(entry.outcome) && entry.expiresAt !== null && entry.expiresAt <= now) {
          this.result(entry, 'expired', '重置卡已到期，未能确认自动使用成功');
        }
      }
      if (!Array.isArray(snapshot.credits?.credits)) return this.show('waiting', '缺少卡片明细，暂无法安排');
      const cards = snapshot.credits.credits.filter(card => typeof card.id === 'string' && card.id && card.resetType === 'codexRateLimits' && card.status === 'available' && ((Number.isFinite(card.expiresAt) && card.expiresAt * 1000 > now) || (card.expiresAt === null && this.lowEnabled())))
        .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
      // 未确认的旧请求优先核对，避免跳过尚在途的兑换去使用下一张卡。
      const uncertain = Object.values(this.journal.entries).find(entry => entry.account === account && entry.outcome === 'pending' && (entry.expiresAt === null || entry.expiresAt > now));
      if (uncertain && !cards.some(card => card.id === uncertain.creditId)) {
        const known = snapshot.credits.credits.find(card => card.id === uncertain.creditId);
        if ((known && known.status !== 'available') || snapshot.credits.availableCount === 0) {
          this.result(uncertain, 'unavailable', '上次兑换的卡片已不可用，请以最新官方额度为准');
        } else return this.show('waiting', '上次兑换结果待核对，等待该卡片明细');
      }
      const card = uncertain && cards.find(card => card.id === uncertain.creditId) || cards.find(item => !TERMINAL.has(this.journal.entries[recordKey(snapshot.accountKey, item.id)]?.outcome));
      if (!card) return this.show('waiting', cards.length ? '当前卡片已处理，等待官方状态同步' : snapshot.credits.availableCount > 0 ? '缺少有效 ID 或到期时间，暂无法安排' : '暂无需要安排的重置卡');
      const expiresAt = card.expiresAt === null ? null : card.expiresAt * 1000;
      const key = recordKey(snapshot.accountKey, card.id);
      let entry = this.journal.entries[key];
      const low = this.lowEnabled() && hasLowQuota(snapshot.quota);
      if (!low && (!this.expiryEnabled() || expiresAt === null)) return this.show('waiting', this.lowEnabled() ? '全天监测中 · 余量低于 1% 自动使用' : '缺少到期时间，暂无法安排');
      const due = Math.max(low ? now : plannedTime(expiresAt), entry?.retryAt || 0);
      const nextAt = low ? Math.max(now, due) : nextWorkTime(Math.max(now, due));
      if (expiresAt !== null && nextAt >= expiresAt) return this.show('waiting', low ? '重试前卡片将到期，等待官方状态更新' : '已错过可用工作时段；低额度规则仍独立监测');
      if (now < due || (!low && !isWorking(now))) return this.show('planned', low ? '低额度兑换等待重试 · 全天生效' : '已安排 · 纽约时间', nextAt);

      const fresh = await this.readSnapshot();
      const current = fresh?.credits?.credits?.find(item => item.id === card.id && item.status === 'available' && item.resetType === 'codexRateLimits');
      const currentExpiry = current?.expiresAt === null ? null : current?.expiresAt * 1000;
      const reason = this.trigger(fresh, currentExpiry, this.clock());
      if (!this.enabled() || fresh?.accountKey !== snapshot.accountKey || !current || (currentExpiry !== null && (!Number.isFinite(currentExpiry) || currentExpiry <= this.clock())) || !reason) {
        return this.show('waiting', '账号、卡片或时间已变化，下次重新检查');
      }
      if (!entry) {
        entry = { account, creditId: card.id, expiresAt, outcome: 'new', idempotencyKey: null, retryAt: 0 };
        this.journal.entries[key] = entry;
      }
      entry.expiresAt = currentExpiry;
      entry.trigger = reason;
      entry.idempotencyKey ||= randomUUID();
      const previous = entry.outcome;
      entry.outcome = 'pending';
      entry.retryAt = this.clock() + RETRY;
      this.save();
      if (!this.enabled() || !this.trigger(fresh, entry.expiresAt, this.clock()) || (entry.expiresAt !== null && entry.expiresAt <= this.clock())) return this.show('waiting', '触发条件已变化或关闭自动用卡，暂停发送');
      this.show('running', reason === 'low' ? '余量低于 1%，正在自动使用重置卡' : '正在自动使用临期重置卡');
      try {
        const response = await this.consume({ creditId: card.id, idempotencyKey: entry.idempotencyKey });
        if (response.outcome === 'reset' || response.outcome === 'alreadyRedeemed') {
          this.result(entry, response.outcome, reason === 'low' ? '余量低于 1%，已使用重置卡并重新同步额度' : '临期重置卡已使用，官方额度将重新同步');
          try { await this.readSnapshot(); } catch { return this.show('waiting', '已使用重置卡，等待额度同步'); }
          return this.show('success', '已使用 1 张重置卡');
        }
        if (response.outcome === 'nothingToReset') {
          entry.outcome = previous;
          entry.idempotencyKey = null; // 确定未消费，后续资格变化属于新的逻辑尝试。
          this.result(entry, 'retry', reason === 'low' ? '当前没有可重置额度，5 分钟后重新检查低额度条件' : '当前没有可重置额度，工作时段内 5 分钟后重试');
          return this.show('waiting', this.journal.last.message);
        }
        if (response.outcome === 'noCredit') {
          this.result(entry, 'noCredit', '官方返回无可用重置卡，将同步最新状态');
          try { await this.readSnapshot(); } catch { /* 定时查询继续同步。 */ }
          return this.show('waiting', this.journal.last.message);
        }
        throw new Error('兑换返回未知结果');
      } catch (error) {
        // 响应丢失或写入失败仍保留同一幂等键，重启后可安全核对。
        entry.outcome = 'pending';
        entry.retryAt = this.clock() + RETRY;
        this.journal.last = { at: this.clock(), message: `兑换结果待确认，稍后用同一操作标识重试：${error.message}` };
        this.save();
        if (previous !== 'pending') { try { this.notify('重置卡兑换结果待确认，程序将按当前触发规则自动重试'); } catch { /* 通知失败仍保留幂等重试记录。 */ } }
        return this.show('error', this.journal.last.message);
      }
    } catch (error) { return this.show('error', `自动用卡检查失败：${error.message}`); }
    finally { this.busy = false; }
  }
}

module.exports = { AutoReset, plannedTime, isWorking, nextWorkTime, hasLowQuota, ZONE };
