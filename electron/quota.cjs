/** 将官方额度窗口转换为剩余比例，缺失值保留为未知。 */
function normalizeWindow(window) {
  if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) return null;
  return {
    remaining: Math.max(0, Math.min(100, 100 - window.usedPercent)),
    minutes: window.windowDurationMins ?? null,
    resetsAt: window.resetsAt ?? null,
  };
}

/** 优先读取 Codex 配额桶，兼容旧版单桶接口。 */
function normalizeQuota(response) {
  const bucket = response.rateLimitsByLimitId?.codex ?? response.rateLimits;
  if (!bucket) throw new Error('官方接口暂未返回 Codex 额度，请稍后刷新。');
  return { primary: normalizeWindow(bucket.primary), secondary: normalizeWindow(bucket.secondary), plan: bucket.planType ?? null, resetCredits: normalizeResetCredits(response.rateLimitResetCredits) };
}

/** 使用官方总数，保留未知明细；卡片列表可能被截断，不能拿列表长度充当总数。 */
function normalizeResetCredits(value) {
  if (!value || !Number.isInteger(value.availableCount) || value.availableCount < 0) return null;
  return {
    availableCount: value.availableCount,
    credits: Array.isArray(value.credits) ? value.credits.map(credit => ({
      id: typeof credit.id === 'string' ? credit.id : null,
      resetType: typeof credit.resetType === 'string' ? credit.resetType : null,
      status: credit.status,
      expiresAt: typeof credit.expiresAt === 'number' && Number.isFinite(credit.expiresAt) ? credit.expiresAt : null,
    })) : null,
  };
}

/** 在同一账号、窗口和阈值内仅提醒一次。 */
function collectAlerts(quota, account, seen) {
  const alerts = [];
  for (const [name, window] of Object.entries(quota)) {
    if (!window || typeof window !== 'object' || !Number.isFinite(window.remaining)) continue;
    const threshold = window.remaining <= 10 ? 10 : window.remaining <= 20 ? 20 : null;
    if (!threshold) continue;
    const key = `${account}:${name}:${window.resetsAt}:${threshold}`;
    if (!seen.has(key)) {
      seen.add(key);
      if (threshold === 10) seen.add(`${account}:${name}:${window.resetsAt}:20`);
      const minutes = window.minutes;
      const label = minutes === 10080 ? '每周额度' : !minutes ? '额度窗口' : minutes < 60 ? `${minutes} 分钟额度` : minutes % 1440 === 0 ? `${minutes / 1440} 天额度` : `${Math.round(minutes / 60 * 10) / 10} 小时额度`;
      alerts.push(`${label}仅剩 ${Math.round(window.remaining)}%`);
    }
  }
  return alerts;
}

module.exports = { normalizeWindow, normalizeQuota, normalizeResetCredits, collectAlerts };
