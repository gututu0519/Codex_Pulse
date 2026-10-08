const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

/** 在真实 Electron 窗口验证预览、设置、迷你切换与托盘隐藏。 */
async function smoke() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.CODEX_PULSE_DISABLE_AUTO_RESET = '1';
  const application = await electron.launch(process.env.PULSE_PACKAGED_PATH
    ? { executablePath: process.env.PULSE_PACKAGED_PATH, args: [], env }
    : { args: [path.join(__dirname, '..')], env });
  let original;
  try {
    const page = await application.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => !!window.pulse);
    original = await page.evaluate(() => window.pulse.get());
    const deadline = Date.now() + 70000;
    while ((original.status === 'connecting' || original.busy) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250));
      original = await page.evaluate(() => window.pulse.get());
    }
    assert.notEqual(original.status, 'connecting', '首次自动同步应完成');
    assert.equal(original.busy, false, '首次自动同步不应永久等待');
    console.log(`Account integration: status=${original.status}, quota=${!!original.quota}, packaged=${original.packaged}`);
    if (process.env.PULSE_REQUIRE_USAGE === '1') {
      const usageDeadline = Date.now() + 20000;
      let usage = (await page.evaluate(() => window.pulse.get())).usage;
      while (!usage && Date.now() < usageDeadline) {
        await new Promise(resolve => setTimeout(resolve, 200));
        usage = (await page.evaluate(() => window.pulse.get())).usage;
      }
      assert.ok(usage && !usage.error, usage?.error || '本地统计工作线程未返回结果');
      assert.ok(Number.isFinite(usage.tokens));
      console.log(`OpenCode usage: tokens=${usage.tokens}, timezone=${usage.timezone}, sessions=${usage.sessions}`);
    }
    await page.evaluate(() => window.pulse.settings({ compact: false }));
    const weekly = { remaining: 67, minutes: 10080, resetsAt: Math.floor(Date.now() / 1000) + 500000 };
    for (const slot of ['primary', 'secondary']) {
      const fixture = { ...original, status: 'connected', busy: false, error: null, account: { email: '单周额度测试', planType: 'pro' }, settings: { ...original.settings, compact: false }, quota: { primary: null, secondary: null, [slot]: weekly } };
      await application.evaluate(({ BrowserWindow }, state) => BrowserWindow.getAllWindows()[0].webContents.send('pulse:state', state), fixture);
      await page.getByText('每周额度', { exact: true }).waitFor();
      await page.waitForFunction(() => window.outerHeight === 612);
      assert.equal(await page.getByRole('progressbar').count(), 1);
      assert.equal(await page.getByText('连接账号后显示额度', { exact: true }).count(), 0);
      await page.getByRole('button', { name: '收起为迷你悬浮窗' }).click();
      // 主进程设置推送会恢复真实状态，重新注入当前测试窗口。
      await application.evaluate(({ BrowserWindow }, state) => BrowserWindow.getAllWindows()[0].webContents.send('pulse:state', state), { ...fixture, settings: { ...fixture.settings, compact: true } });
      await page.getByText('周额度', { exact: true }).waitFor();
      assert.equal(await page.locator('.compact-value').count(), 1);
      await page.getByRole('button', { name: '展开面板' }).click();
    }
    for (const credits of [null, { availableCount: 0, credits: [] }, { availableCount: 3, credits: null }, { availableCount: 2, credits: [{ status: 'available', expiresAt: 2000000000 }, { status: 'consumed', expiresAt: 1900000000 }] }]) {
      const fixture = { ...original, status: 'connected', busy: false, error: null, account: { email: '重置卡测试账号', planType: 'pro' }, settings: { ...original.settings, compact: false }, quota: { primary: weekly, secondary: null, resetCredits: credits } };
      await application.evaluate(({ BrowserWindow }, state) => BrowserWindow.getAllWindows()[0].webContents.send('pulse:state', state), fixture);
      const card = page.getByRole('region', { name: '额度重置卡' });
      await card.getByText(credits ? `${credits.availableCount} 张可用` : '暂无信息', { exact: true }).waitFor();
      if (credits?.availableCount === 2) {
        await card.getByText(`${new Date(2000000000 * 1000).toLocaleDateString('zh-CN')} 到期`, { exact: false }).waitFor();
        await page.screenshot({ path: path.join(os.tmpdir(), 'opencode', 'codex-pulse-reset-credits.png') });
      }
      await page.getByRole('button', { name: '收起为迷你悬浮窗' }).click();
      await application.evaluate(({ BrowserWindow }, state) => BrowserWindow.getAllWindows()[0].webContents.send('pulse:state', state), { ...fixture, settings: { ...fixture.settings, compact: true } });
      if (credits) await page.getByLabel(`重置卡 ${credits.availableCount} 张`, { exact: true }).waitFor();
      else assert.equal(await page.locator('.compact-credits').count(), 0);
      await page.getByRole('button', { name: '展开面板' }).click();
    }
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    for (const [usage, expected] of [
      [{ date: today, tokens: 128640, error: null }, '128.6K'],
      [{ date: today, tokens: 0, error: null }, '0'],
      [{ date: today, tokens: null, error: null }, '暂无数据'],
      [{ date: '2000-01-01', tokens: 999, error: null }, '暂无数据'],
      [{ date: today, tokens: 123, error: '测试查询失败' }, '更新失败'],
    ]) {
      const fixture = { ...original, status: 'connected', busy: false, error: null, usage, settings: { ...original.settings, compact: false }, quota: { primary: weekly, secondary: null } };
      await application.evaluate(({ BrowserWindow }, state) => BrowserWindow.getAllWindows()[0].webContents.send('pulse:state', state), fixture);
      await page.getByRole('region', { name: '今日 Token', exact: true }).getByText(expected, { exact: true }).waitFor();
      assert.equal(await page.getByRole('progressbar').count(), 1);
    }
    await page.getByRole('button', { name: '偏好设置', exact: true }).click();
    await page.getByRole('button', { name: '体验界面预览' }).click();
    await page.getByText('界面预览 · 当前数值为演示数据').waitFor();
    assert.equal(await page.getByRole('progressbar').first().getAttribute('aria-valuenow'), '72');
    const layout = await page.evaluate(() => {
      const shell = document.querySelector('.shell');
      const footer = document.querySelector('footer');
      return { shellBottom: shell.getBoundingClientRect().bottom, footerBottom: footer.getBoundingClientRect().bottom, overflow: shell.scrollHeight - shell.clientHeight };
    });
    assert.ok(layout.footerBottom <= layout.shellBottom, JSON.stringify(layout));
    await page.screenshot({ path: path.join(os.tmpdir(), 'opencode', 'codex-pulse-preview.png') });
    await page.getByRole('button', { name: '收起为迷你悬浮窗' }).click();
    await page.getByRole('button', { name: '展开面板' }).waitFor();
    assert.equal(await page.locator('.compact-shell button').count(), 0, '迷你窗不再显示放大按钮');
    await page.locator('.compact-usage').getByText('128.6K', { exact: false }).waitFor();
    assert.match(await page.locator('.compact-usage').getAttribute('title'), /128,640/);
    assert.equal((await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())).height, 96);
    await page.screenshot({ path: path.join(os.tmpdir(), 'opencode', 'codex-pulse-mini.png') });
    const beforeDrag = await application.evaluate(({ BrowserWindow, screen }) => {
      globalThis.pulseOriginalCursor = screen.getCursorScreenPoint;
      globalThis.pulseTestCursor = { x: 500, y: 300 };
      screen.getCursorScreenPoint = () => globalThis.pulseTestCursor;
      return BrowserWindow.getAllWindows()[0].getBounds();
    });
    try {
      await page.mouse.move(40, 40);
      await page.mouse.down();
      await application.evaluate(() => { globalThis.pulseTestCursor = { x: 530, y: 320 }; });
      await page.mouse.move(70, 60, { steps: 4 });
      const dragged = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
      assert.equal(dragged.x, beforeDrag.x + 30);
      assert.equal(dragged.y, beforeDrag.y + 20);
      await page.mouse.up();
      assert.equal((await page.evaluate(() => window.pulse.get())).settings.compact, true, '拖动结束不应误展开');
    } finally {
      await application.evaluate(({ BrowserWindow, screen }, bounds) => {
        screen.getCursorScreenPoint = globalThis.pulseOriginalCursor;
        delete globalThis.pulseOriginalCursor;
        delete globalThis.pulseTestCursor;
        BrowserWindow.getAllWindows()[0].setBounds(bounds);
      }, beforeDrag);
    }
    await page.locator('.compact-usage').click();
    await page.getByRole('button', { name: '收起为迷你悬浮窗' }).waitFor();
    await page.getByRole('button', { name: '收起为迷你悬浮窗' }).click();
    await page.locator('.compact-brand').click();
    await page.getByRole('button', { name: '收起为迷你悬浮窗' }).waitFor();
    await page.getByRole('button', { name: '偏好设置', exact: true }).click();
    await page.getByRole('switch', { name: '始终置顶' }).click();
    const autoToggle = page.getByRole('switch', { name: '自动使用临期重置卡', exact: true });
    await autoToggle.click();
    assert.equal((await page.evaluate(() => window.pulse.get())).settings.autoReset, !original.settings.autoReset);
    await autoToggle.click();
    const lowToggle = page.getByRole('switch', { name: '余量低于 1% 自动使用', exact: true });
    await lowToggle.click();
    assert.equal((await page.evaluate(() => window.pulse.get())).settings.lowQuotaReset, !original.settings.lowQuotaReset);
    await lowToggle.click();
    const pinned = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isAlwaysOnTop());
    assert.equal(pinned, !original.settings.pinned);
    await page.screenshot({ path: path.join(os.tmpdir(), 'opencode', 'codex-pulse-settings.png') });
    await page.getByRole('button', { name: '隐藏到系统托盘' }).click();
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
    assert.deepEqual(errors, []);
    console.log('Desktop smoke: preview / layout / compact / pin / tray-hide passed');
  } finally {
    if (original) {
      const page = await application.firstWindow();
      await page.evaluate(settings => window.pulse.settings(settings), original.settings);
    }
    await application.close();
  }
}

smoke().catch(error => { console.error(error); process.exitCode = 1; });
