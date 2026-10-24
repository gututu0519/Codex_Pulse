const { chromium } = require('playwright');
const assert = require('node:assert/strict');

/** 在隔离浏览器中验证来源选择、详情、跨日与迷你窗，不触发真实账号操作。 */
async function smoke() {
  const { createServer } = await import('vite');
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
    const page = await browser.newPage({ viewport: { width: 384, height: 752 } });
    await page.addInitScript(() => {
      const now = new Date(), date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const agents = ['opencode', 'codex', 'claude', 'gemini'];
      let callback;
      const state = { status: 'signed-out', account: null, quota: null, busy: false, error: null, updatedAt: null,
        settings: { pinned: true, compact: false, opacity: 96, interval: 60, notifications: false, startup: false, autoReset: false, lowQuotaReset: false, usageSources: JSON.parse(localStorage.getItem('selected') || 'null') || agents },
        usage: { date, updatedAt: +now, sources: Object.fromEntries(agents.map((agent, i) => [agent, { date, tokens: (i + 1) * 100, input: 10, output: 20, cacheRead: 70, messages: 1, sessions: 1, updatedAt: +now, error: null, status: 'ok' }])) } };
      window.pulse = {
        get: async () => state, subscribe: handler => { callback = handler; return () => {}; },
        settings: async patch => { Object.assign(state.settings, patch); localStorage.setItem('selected', JSON.stringify(state.settings.usageSources)); callback?.({ ...state }); return { ...state.settings }; },
        layout: async () => {}, refresh: async () => state, drag: () => {}, hide: () => {}, quit: () => {}, login: async () => ({ ok: false }),
      };
    });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.resolvedUrls.local[0]);
    const card = page.getByRole('button', { name: '今日 Token', exact: true });
    await card.getByText('1.0K', { exact: true }).waitFor();
    await card.click();
    assert.equal(await page.getByRole('checkbox').count(), 4);
    for (const checkbox of await page.getByRole('checkbox').all()) assert.equal(await checkbox.isChecked(), true);
    await page.getByRole('checkbox', { name: /Codex/ }).uncheck();
    await page.locator('.usage-total').getByText('800', { exact: false }).waitFor();
    await page.locator('summary').first().click();
    await page.locator('.usage-breakdown').first().getByText('输入（不含缓存）', { exact: false }).waitFor();
    assert.equal(await page.locator('.usage-breakdown').first().isVisible(), true);
    await page.getByRole('button', { name: '全选', exact: true }).click();
    await page.getByRole('button', { name: '全不选', exact: true }).click();
    await page.getByText('未选择来源', { exact: true }).waitFor();
    await page.getByRole('checkbox', { name: /OpenCode/ }).check();
    await page.reload();
    await card.getByText('100', { exact: true }).waitFor();
    await page.getByRole('button', { name: '收起为迷你悬浮窗' }).click();
    await page.locator('.compact-usage').getByText('100', { exact: false }).waitFor();
    await page.locator('.compact-usage').click();
    await page.locator('.usage-panel').waitFor();
    assert.equal(await page.getByRole('checkbox', { name: /Codex/ }).isChecked(), false);
    const layout = await page.evaluate(() => {
      const shell = document.querySelector('.shell').getBoundingClientRect();
      const footer = document.querySelector('footer').getBoundingClientRect();
      return footer.bottom <= shell.bottom;
    });
    assert.equal(layout, true);
    await page.evaluate(async () => {
      const state = await window.pulse.get();
      state.usage.sources.gemini = { ...state.usage.sources.gemini, tokens: null, status: 'unavailable' };
      state.usage.sources.codex.date = '2000-01-01';
      await window.pulse.settings({ usageSources: ['opencode', 'codex', 'claude', 'gemini'] });
    });
    await page.locator('.usage-total').getByText('400', { exact: false }).waitFor();
    await page.getByText('未检测到本地记录', { exact: true }).waitFor();
    await page.getByText('等待今日更新', { exact: true }).waitFor();
    await page.evaluate(async () => { await window.pulse.settings({ usageSources: ['gemini'] }); });
    await page.locator('.usage-total').getByText('—', { exact: false }).waitFor();
    assert.deepEqual(errors, []);
    console.log('Usage UI: selection / persistence / details / compact / layout passed');
  } finally { await browser?.close(); await server.close(); }
}

smoke().catch(error => { console.error(error); process.exitCode = 1; });
