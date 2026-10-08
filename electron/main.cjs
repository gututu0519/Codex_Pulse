const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, screen, Notification, powerMonitor } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { CodexClient } = require('./codex.cjs');
const { normalizeQuota, collectAlerts } = require('./quota.cjs');
const { Worker } = require('node:worker_threads');
const { AutoReset } = require('./auto-reset.cjs');

let win, tray, interval, settingsPath;
let quitting = false;
let refreshing = null;
let loginId = null;
let singlePanel = true;
let creditsPanel = false;
let usagePanel = false;
let usageWorker = null;
let usageTimer;
let autoReset, resetTimer;
let compactDrag = null;
let settings = { pinned: true, compact: false, opacity: 96, interval: 60, notifications: true, startup: false, autoReset: true, lowQuotaReset: true };
let state = { status: 'connecting', account: null, quota: null, usage: null, updatedAt: null, error: null, busy: false };
const client = new CodexClient();
const seenAlerts = new Set();

/** 将界面设置保存在用户配置目录，不存储账号凭据。 */
function saveSettings() {
  try { fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2)); } catch { /* 配置目录只读时保持本次会话设置。 */ }
}

/** 推送最新状态到受隔离的渲染进程。 */
function publish() {
  if (autoReset) state.autoReset = { ...autoReset.view, enabled: settings.autoReset || settings.lowQuotaReset };
  if (win && !win.isDestroyed()) win.webContents.send('pulse:state', { ...state, settings });
  if (tray) tray.setToolTip(`Codex Pulse${state.quota?.primary ? ` · 剩余 ${Math.round(state.quota.primary.remaining)}%` : ''}`);
}

/** 合并重复刷新，失败时明确标记旧数据。 */
async function refresh() {
  if (refreshing) return refreshing;
  if (autoReset?.busy) return { ...state, settings };
  refreshUsage();
  refreshing = (async () => {
    state.busy = true;
    publish();
    try {
      await client.connect();
      const { account } = await client.request('account/read', { refreshToken: false });
      if (account?.email !== state.account?.email || account?.type !== state.account?.type) {
        state.quota = null;
        state.updatedAt = null;
      }
      state.account = account ? { type: account.type, email: account.email ?? null, planType: account.planType ?? null } : null;
      if (!account || !['chatgpt', 'chatgptAuthTokens'].includes(account.type)) {
        state.status = 'signed-out';
        state.quota = null;
        state.updatedAt = null;
        state.error = account ? '当前为 API 登录，请连接 ChatGPT 订阅账号。' : null;
      } else {
        await refreshQuota(account);
      }
    } catch (error) {
      state.status = 'error';
      state.error = error.message;
    } finally {
      state.busy = false;
      publish();
    }
    return { ...state, settings };
  })();
  try { return await refreshing; } finally { refreshing = null; }
}

/** 独立更新额度与重置卡，Token 查询失败不会覆盖本次额度结果。 */
async function refreshQuota(account) {
  try {
    state.quota = normalizeQuota(await client.request('account/rateLimits/read'));
    state.updatedAt = Date.now();
    state.status = 'connected';
    state.error = null;
    if (settings.notifications && Notification.isSupported()) {
      for (const message of collectAlerts(state.quota, account.email, seenAlerts)) {
        new Notification({ title: 'Codex Pulse · 额度提醒', body: message }).show();
      }
    }
  } catch (error) { state.status = 'error'; state.error = error.message; }
  publish();
}

/** 在工作线程读取本地用量，独立于官方连接，每次读取结束释放数据库锁。 */
function refreshUsage() {
  if (usageWorker || quitting) return;
  const worker = new Worker(path.join(__dirname, 'usage.cjs'), { workerData: { now: Date.now() } });
  usageWorker = worker;
  let received = false;
  const timeout = setTimeout(() => void worker.terminate(), 15000);
  worker.once('message', result => { received = true; state.usage = result; publish(); });
  worker.once('error', () => { /* 退出事件统一显示失败状态。 */ });
  worker.once('exit', () => {
    clearTimeout(timeout);
    usageWorker = null;
    if (!received && !quitting) { state.usage = { tokens: null, error: 'OpenCode 用量读取失败或超时，稍后自动重试。' }; publish(); }
  });
}

/** 从浏览器打开官方登录页，只允许官方 HTTPS 授权地址。 */
async function login() {
  if (autoReset?.busy) return { ok: false, error: '正在核对自动用卡状态，请稍后再连接账号。' };
  try {
    await client.connect();
    if (loginId) await client.request('account/login/cancel', { loginId });
    const result = await client.request('account/login/start', { type: 'chatgpt' });
    const url = new URL(result.authUrl);
    if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com', 'auth0.openai.com'].includes(url.hostname)) throw new Error('官方登录地址无法识别。');
    loginId = result.loginId;
    await shell.openExternal(url.toString());
    state.status = 'logging-in';
    state.error = null;
    publish();
    return { ok: true };
  } catch (error) { return { ok: false, error: error.message }; }
}

/** 设置刷新频率，暂停登录期间的轮询以避免覆盖登录提示。 */
function schedule() {
  clearInterval(interval);
  interval = setInterval(() => { if (state.status !== 'logging-in') void refresh(); }, settings.interval * 1000);
}

/** 将窗口限制在当前显示器可见区域内，兼容拔掉副屏的情况。 */
function fitWindow() {
  const width = settings.compact ? singlePanel ? 356 : 404 : 384;
  const height = settings.compact ? 96 : (singlePanel ? 440 : 580) + (creditsPanel ? 110 : 0) + (usagePanel ? 62 : 0);
  const bounds = win.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  win.setBounds({ width, height, x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)), y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)) });
}

/** 应用经过校验的界面设置并保存。 */
function updateSettings(patch) {
  compactDrag = null;
  for (const key of ['pinned', 'compact', 'notifications', 'startup', 'autoReset', 'lowQuotaReset']) if (typeof patch[key] === 'boolean') settings[key] = patch[key];
  if (Number.isFinite(patch.opacity)) settings.opacity = Math.max(65, Math.min(100, Math.round(patch.opacity)));
  if ([30, 60, 120, 300].includes(patch.interval)) settings.interval = patch.interval;
  win.setAlwaysOnTop(settings.pinned, 'floating');
  win.setOpacity(settings.opacity / 100);
  fitWindow();
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: settings.startup, path: process.env.PORTABLE_EXECUTABLE_FILE || app.getPath('exe') });
  schedule();
  saveSettings();
  if ((patch.autoReset !== undefined || patch.lowQuotaReset !== undefined) && autoReset) {
    if (!settings.autoReset && !settings.lowQuotaReset) autoReset.show('disabled', '自动用卡已关闭');
    else void checkAutoReset();
  }
  publish();
  return settings;
}

/** 获取全新账号及卡片明细，并在读取前后确认账号未切换。 */
async function readResetSnapshot() {
  await client.connect();
  const first = await client.request('account/read', { refreshToken: false });
  const account = first.account;
  if (!account || !['chatgpt', 'chatgptAuthTokens'].includes(account.type)) return null;
  const accountKey = JSON.stringify(account);
  const quota = normalizeQuota(await client.request('account/rateLimits/read'));
  const second = await client.request('account/read', { refreshToken: false });
  if (JSON.stringify(second.account) !== accountKey) throw new Error('账号发生变化，等待下次同步');
  state.account = { type: account.type, email: account.email ?? null, planType: account.planType ?? null };
  state.quota = quota;
  state.updatedAt = Date.now();
  state.status = 'connected';
  state.error = null;
  publish();
  return { accountKey, credits: quota.resetCredits, quota };
}

/** 独立于界面显示与额度刷新频率检查自动兑换，避免并发登录和重复请求。 */
async function checkAutoReset() {
  if (quitting || refreshing || loginId || state.status === 'logging-in' || !autoReset) return;
  await autoReset.tick();
  publish();
}

/** 生成不依赖外部资源的清晰托盘图标。 */
function createIcon() {
  const size = 32;
  const buffer = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    const ring = Math.abs(Math.hypot(x - 15.5, y - 15.5) - 10.5) < 2;
    const dot = Math.hypot(x - 15.5, y - 15.5) < 3;
    buffer[i] = 200; buffer[i + 1] = 223; buffer[i + 2] = 117; buffer[i + 3] = ring || dot ? 255 : 0;
  }
  return nativeImage.createFromBitmap(buffer, { width: size, height: size });
}

/** 创建无边框悬浮窗及常驻托盘。 */
function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    width: 384, height: 580,
    x: settings.position?.x ?? area.x + area.width - 414, y: settings.position?.y ?? area.y + 80,
    frame: false, transparent: true, resizable: false, maximizable: false, fullscreenable: false,
    alwaysOnTop: settings.pinned, skipTaskbar: true, show: false, hasShadow: false,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setOpacity(settings.opacity / 100);
  fitWindow();
  win.loadFile(path.join(__dirname, '../dist/index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.on('close', event => { if (!quitting) { event.preventDefault(); win.hide(); } });
  win.on('moved', () => { const { x, y } = win.getBounds(); settings.position = { x, y }; saveSettings(); });
  tray = new Tray(createIcon());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 Codex Pulse', click: () => { win.show(); win.focus(); } },
    { label: '刷新额度', click: () => void refresh() },
    { label: '切换迷你模式', click: () => updateSettings({ compact: !settings.compact }) },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
  tray.on('click', () => { if (win.isVisible()) win.hide(); else { win.show(); win.focus(); } });
  screen.on('display-removed', fitWindow);
  screen.on('display-metrics-changed', fitWindow);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { win?.show(); win?.focus(); });
  app.whenReady().then(() => {
    app.setAppUserModelId('com.codexpulse.desktop');
    settingsPath = path.join(app.getPath('userData'), 'settings.json');
    try {
      const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      for (const key of ['pinned', 'compact', 'notifications', 'startup', 'autoReset', 'lowQuotaReset']) if (typeof saved[key] === 'boolean') settings[key] = saved[key];
      if ([30, 60, 120, 300].includes(saved.interval)) settings.interval = saved.interval;
      if (Number.isFinite(saved.opacity)) settings.opacity = Math.max(65, Math.min(100, saved.opacity));
      if (Number.isInteger(saved.position?.x) && Number.isInteger(saved.position?.y)) settings.position = saved.position;
    } catch { /* 首次运行采用默认配置。 */ }
    autoReset = new AutoReset({
      filePath: path.join(app.getPath('userData'), 'auto-reset.json'),
      readSnapshot: readResetSnapshot,
      consume: params => client.request('account/rateLimitResetCredit/consume', params),
      enabled: () => (settings.autoReset || settings.lowQuotaReset) && !quitting && process.env.CODEX_PULSE_DISABLE_AUTO_RESET !== '1',
      expiryEnabled: () => settings.autoReset,
      lowEnabled: () => settings.lowQuotaReset,
      onChange: publish,
      notify: message => {
        if (Notification.isSupported()) new Notification({ title: 'Codex Pulse · 自动用卡', body: message }).show();
      },
    });
    createWindow();
    ipcMain.handle('pulse:get', () => ({ ...state, settings, packaged: app.isPackaged }));
    ipcMain.handle('pulse:refresh', refresh);
    ipcMain.handle('pulse:login', login);
    ipcMain.handle('pulse:settings', (_event, patch) => updateSettings(patch || {}));
    ipcMain.handle('pulse:layout', (_event, layout) => { singlePanel = layout?.single === true; creditsPanel = layout?.credits === true; usagePanel = layout?.usage === true; fitWindow(); });
    ipcMain.on('pulse:hide', () => win.hide());
    ipcMain.on('pulse:quit', () => app.quit());
    ipcMain.on('pulse:drag', (_event, action) => {
      if (!settings.compact) { compactDrag = null; return; }
      if (action === 'start') compactDrag = { cursor: screen.getCursorScreenPoint(), bounds: win.getBounds() };
      if (action === 'move' && compactDrag) {
        const cursor = screen.getCursorScreenPoint();
        const dx = cursor.x - compactDrag.cursor.x, dy = cursor.y - compactDrag.cursor.y;
        if (Math.hypot(dx, dy) >= 5) win.setPosition(compactDrag.bounds.x + dx, compactDrag.bounds.y + dy);
      }
      if (action === 'end') { compactDrag = null; fitWindow(); }
    });
    client.on('notification', message => {
      if (message.method === 'account/login/completed') {
        loginId = null;
        if (message.params.success) void refresh();
        else { state.status = 'error'; state.error = message.params.error || '登录未完成，请重试。'; publish(); }
      }
      if (message.method === 'account/rateLimits/updated' && !state.busy) void refresh();
    });
    powerMonitor.on('resume', () => { void refresh().then(checkAutoReset); });
    schedule();
    usageTimer = setInterval(refreshUsage, 10000);
    resetTimer = setInterval(() => void checkAutoReset(), 30000);
    void refresh().then(checkAutoReset);
  });
  app.on('before-quit', () => { quitting = true; clearInterval(interval); clearInterval(usageTimer); clearInterval(resetTimer); void usageWorker?.terminate(); client.stop(); });
  app.on('window-all-closed', () => { if (quitting) app.quit(); });
}
