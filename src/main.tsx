import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, ArrowDownLeft, ArrowUpRight, ChevronLeft, Clock3, ExternalLink, Eye, LogIn, Minus, Pin, Power, RefreshCw, Settings2, ShieldCheck, Sparkles, Ticket, X } from 'lucide-react';
import './style.css';

type QuotaWindow = { remaining: number; minutes: number | null; resetsAt: number | null };
type ResetCredits = { availableCount: number; credits: { status: string; expiresAt: number | null }[] | null };
type Agent = 'opencode' | 'codex' | 'claude' | 'gemini';
const agentNames: Record<Agent, string> = { opencode: 'OpenCode', codex: 'Codex', claude: 'Claude Code', gemini: 'Gemini CLI' };
const agents = Object.keys(agentNames) as Agent[];
type DailyUsage = { date: string; tokens: number | null; updatedAt: number; error: string | null; input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number; tool?: number; messages?: number; sessions?: number; missing?: number; fallback?: number; timezone?: string; status?: string; sources?: Partial<Record<Agent, DailyUsage>> };
type Preferences = { pinned: boolean; compact: boolean; opacity: number; interval: number; notifications: boolean; startup: boolean; autoReset: boolean; lowQuotaReset: boolean; usageSources: Agent[] };
type AutoResetState = { status: string; message: string; nextAt: number | null; last: { at: number; message: string } | null; enabled: boolean };
type Snapshot = {
  status: string; account: { email: string | null; planType: string | null } | null;
  quota: { primary: QuotaWindow | null; secondary: QuotaWindow | null; plan: string | null; resetCredits?: ResetCredits | null } | null;
  updatedAt: number | null; error: string | null; busy: boolean; settings: Preferences; packaged?: boolean;
  usage?: DailyUsage | null;
  autoReset?: AutoResetState;
};
declare global {
  interface Window {
    pulse?: {
      get: () => Promise<Snapshot>; refresh: () => Promise<Snapshot>;
      login: () => Promise<{ ok: boolean; error?: string }>;
      settings: (patch: Partial<Preferences>) => Promise<Preferences>;
      layout: (single: boolean, credits: boolean, usage: boolean) => Promise<void>;
      hide: () => void; quit: () => void;
      drag: (action: 'start' | 'move' | 'end') => void;
      subscribe: (callback: (state: Snapshot) => void) => () => void;
    };
  }
}
const defaults: Preferences = { pinned: true, compact: false, opacity: 96, interval: 60, notifications: true, startup: false, autoReset: true, lowQuotaReset: true, usageSources: [...agents] };
const initial: Snapshot = { status: 'connecting', account: null, quota: null, updatedAt: null, error: null, busy: false, settings: defaults };

/** 构造明确标记的本地演示数据，预览不会混入真实额度。 */
function demoState(): Snapshot {
  return { ...initial, status: 'connected', account: { email: '预览账号 · 未连接真实数据', planType: 'PLUS' }, quota: {
    primary: { remaining: 72, minutes: 300, resetsAt: Math.floor(Date.now() / 1000) + 8340 },
    secondary: { remaining: 86, minutes: 10080, resetsAt: Math.floor(Date.now() / 1000) + 286320 }, plan: 'plus',
    resetCredits: { availableCount: 2, credits: [{ status: 'available', expiresAt: Math.floor(Date.now() / 1000) + 864000 }] },
  }, updatedAt: Date.now(), usage: { date: localDate(Date.now()), tokens: 128640, updatedAt: Date.now(), error: null, input: 18000, output: 10000, reasoning: 640, cacheRead: 100000, cacheWrite: 0, sessions: 3, messages: 12 } };
}

/** 生成系统时区的日期标签，跨日后隐藏昨日缓存。 */
function localDate(now: number) {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 按当前选择汇总有效来源，未知来源不伪装为零用量。 */
function selectedUsage(data: DailyUsage | null | undefined, selected: Agent[], now: number): DailyUsage {
  const result: DailyUsage = { date: localDate(now), tokens: 0, updatedAt: data?.updatedAt || now, error: null, missing: 0 };
  const sources = data?.sources || (data ? { opencode: data } : {});
  let known = 0;
  for (const agent of selected) {
    const source = sources[agent];
    if (!source || source.date !== result.date || source.tokens == null || (source.error && source.status !== 'partial')) { result.missing!++; continue; }
    known++;
    result.tokens! += source.tokens;
    for (const field of ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'tool', 'messages', 'sessions'] as const) result[field] = (result[field] || 0) + (source[field] || 0);
    result.missing! += source.missing || (source.error ? 1 : 0);
  }
  if (selected.length && !known) { result.tokens = null; result.error = data?.error || null; }
  return result;
}

/** 展示所选来源的当日汇总，点击进入选择和明细。 */
function UsageCard({ data, now, onClick }: { data: DailyUsage | null | undefined; now: number; onClick: () => void }) {
  const today = localDate(now);
  const tokens = data?.date === today && !data.error ? data.tokens : null;
  const value = tokens === null ? data?.error ? '更新失败' : '暂无数据' : formatTokens(tokens);
  const detail = data?.error ? '本地读取失败 · 10 秒后重试' : tokens === null ? '等待本地统计更新' : `${today} · 系统时间${data?.missing ? ' · 部分缺失' : ' · 含缓存'}`;
  const breakdown = tokens === null ? '' : `输入：${data?.input?.toLocaleString() ?? '—'}\n输出：${data?.output?.toLocaleString() ?? '—'}\n推理：${data?.reasoning?.toLocaleString() ?? '—'}\n缓存读取：${data?.cacheRead?.toLocaleString() ?? '—'}\n缓存写入：${data?.cacheWrite?.toLocaleString() ?? '—'}\n${data?.sessions ?? 0} 个会话 / ${data?.messages ?? 0} 次已完成调用\n`;
  const tooltip = `${tokens === null ? '' : `${tokens.toLocaleString('zh-CN')} Tokens\n`}${breakdown}所选本地 Agent 的今日用量，含缓存。\n点击选择来源和查看详情。${data?.missing ? '\n部分来源不可用或记录缺失，当前仅展示已知用量。' : ''}${data?.error ? `\n${data.error}` : ''}`;
  return <button className="usage-card" aria-label="今日 Token" title={tooltip} onClick={onClick}><Activity size={17} /><div><span>今日 Token</span><small>{detail}</small></div><strong>{value}</strong></button>;
}

/** 展示四个来源的选择、读取状态及独立明细，不展示会话正文。 */
function UsagePanel({ data, selected, now, onChange, onBack, demo }: { data: DailyUsage | null | undefined; selected: Agent[]; now: number; onChange: (value: Agent[]) => void; onBack: () => void; demo: boolean }) {
  const sources = data?.sources || (data ? { opencode: data } : {});
  const total = selectedUsage(data, selected, now);
  return <section className="usage-panel">
    <div className="section-title"><button className="back" onClick={onBack}><ChevronLeft size={17} />今日 Token</button><button className="back" onClick={() => onChange(selected.length === agents.length ? [] : [...agents])}>{selected.length === agents.length ? '全不选' : '全选'}</button></div>
    <div className="usage-total">{total.tokens === null ? '—' : total.tokens.toLocaleString()}<small>{demo ? '演示数据 · ' : ''}{selected.length ? `已选 ${selected.length} 个来源` : '未选择来源'}{total.missing ? ' · 部分统计' : ''}</small></div>
    <div className="usage-sources">{agents.map(agent => {
      const source = sources[agent];
      const fresh = source?.date === localDate(now);
      const known = fresh && source?.tokens != null;
      const status = !source ? '等待统计' : source.status === 'unavailable' ? '未检测到本地记录' : !fresh ? '等待今日更新' : source.status === 'error' ? '读取失败' : source.missing || source.error ? '部分统计' : source.messages === 0 ? '今日暂无调用' : '已同步';
      return <div className="usage-source" key={agent}>
        <label><input type="checkbox" checked={selected.includes(agent)} onChange={event => onChange(event.target.checked ? [...selected, agent] : selected.filter(value => value !== agent))} /><span>{agentNames[agent]}<small>{status}</small></span><strong>{known ? formatTokens(source.tokens!) : '—'}</strong></label>
        <details><summary>查看详细</summary><div className="usage-breakdown">
          <span>总 Token<strong>{known ? source.tokens!.toLocaleString() : '—'}</strong></span>
          {([['input', '输入（不含缓存）'], ['output', agent === 'claude' ? '输出（含推理）' : '输出'], ['reasoning', agent === 'claude' ? '推理（未单列）' : '推理'], ['cacheRead', '缓存读取'], ['cacheWrite', '缓存写入'], ['tool', '工具提示']] as const).map(([key, label]) => <span key={key}>{label}<strong>{known && source[key] !== undefined && !(agent === 'claude' && key === 'reasoning') ? source[key]!.toLocaleString() : '—'}</strong></span>)}
          <span>会话 / 用量记录<strong>{known ? `${source.sessions ?? 0} / ${source.messages ?? 0}` : '—'}</strong></span>
          <small>{source?.updatedAt ? `更新于 ${new Date(source.updatedAt).toLocaleTimeString()}` : '等待首次读取'}</small>
          {source?.error && <small className="warning">{source.error}</small>}
        </div></details>
      </div>;
    })}</div>
    <p className="usage-help">按系统时区每日 00:00 划分，含缓存；仅统计本机保留的日志。各来源按用量事件时间归属当日，不等同于订阅额度扣减。</p>
  </section>;
}

/** 两种窗口统一使用紧凑的 Token 数量格式。 */
function formatTokens(tokens: number) {
  return tokens >= 1e9 ? `${(tokens / 1e9).toFixed(1)}B` : tokens >= 1e6 ? `${(tokens / 1e6).toFixed(1)}M` : tokens >= 1e3 ? `${(tokens / 1e3).toFixed(1)}K` : String(tokens);
}

/** 根据服务器周期生成名称，避免假定所有账号均为五小时限额。 */
function period(minutes: number | null | undefined, fallback: string) {
  if (!minutes) return fallback;
  if (minutes === 10080) return '每周额度';
  if (minutes < 60) return `${minutes} 分钟额度`;
  if (minutes % 1440 === 0) return `${minutes / 1440} 天额度`;
  return `${Math.round(minutes / 60 * 10) / 10} 小时额度`;
}

/** 用服务器时间戳计算倒计时，到期后等待真实刷新。 */
function countdown(timestamp: number | null | undefined, now: number) {
  if (!timestamp) return '重置时间未知';
  const seconds = Math.ceil(timestamp - now / 1000);
  if (seconds <= 0) return '等待额度更新';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时后重置`;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')} 后重置`;
}

/** 统一图标按钮的提示与无障碍名称。 */
function IconButton({ title, children, onClick, active = false, disabled = false }: { title: string; children: React.ReactNode; onClick: () => void; active?: boolean; disabled?: boolean }) {
  return <button className={`icon-button ${active ? 'active' : ''}`} title={title} aria-label={title} onClick={onClick} disabled={disabled}>{children}</button>;
}

/** 绘制独立额度卡，低额度时切换为琥珀色。 */
function QuotaCard({ data, secondary = false, now }: { data: QuotaWindow | null | undefined; secondary?: boolean; now: number }) {
  const low = data && data.remaining <= 20;
  const value = data ? Math.round(data.remaining) : null;
  return <section className={`quota-card ${secondary ? 'violet' : 'mint'} ${low ? 'low' : ''}`}>
    <div className="quota-heading"><span><span className="tiny-dot" />{period(data?.minutes, '额度窗口')}</span><span className="micro">{data?.minutes === 10080 ? 'WEEKLY' : 'QUOTA'}</span></div>
    <div className="quota-number"><div>{value ?? '—'}<span>{value !== null ? '%' : ''}</span></div><span className="remaining-label">剩余可用</span></div>
    <div className="meter" role="progressbar" aria-label="剩余额度" aria-valuenow={value ?? undefined} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${value ?? 0}%` }} /></div>
    <div className="reset-line"><Clock3 size={12} /><span title={data?.resetsAt ? new Date(data.resetsAt * 1000).toLocaleString('zh-CN') : ''}>{data ? countdown(data.resetsAt, now) : '连接账号后显示额度'}</span><span className="used">{data ? `已用 ${Math.round(100 - data.remaining)}%` : '—'}</span></div>
  </section>;
}

/** 渲染设置中的开关，使用原生按钮提供键盘操作。 */
function Toggle({ label, checked, onChange, disabled = false }: { label: string; checked: boolean; onChange: () => void; disabled?: boolean }) {
  return <button className={`toggle ${checked ? 'on' : ''}`} role="switch" aria-label={label} aria-checked={checked} onClick={onChange} disabled={disabled}><span /></button>;
}

/** 展示官方重置卡数量及已返回明细中的最近到期时间，不推测未知有效期。 */
function ResetCreditCard({ data, now, automation, demo }: { data: ResetCredits | null | undefined; now: number; automation?: AutoResetState; demo: boolean }) {
  const dates = (data?.credits ?? []).filter(credit => credit.status === 'available' && credit.expiresAt !== null && credit.expiresAt * 1000 > now).map(credit => credit.expiresAt!);
  const next = dates.length ? Math.min(...dates) : null;
  const detail = !data ? '官方暂未提供重置卡信息' : data.availableCount === 0 ? '当前没有可用的重置卡' : next ? `${new Date(next * 1000).toLocaleDateString('zh-CN')} 到期 · 已返回明细中最近一张` : '到期时间暂无信息';
  const plan = automation?.nextAt ? `${new Date(automation.nextAt).toLocaleString('zh-CN', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} 自动使用 · 纽约` : automation?.message || '等待自动用卡计划';
  const history = automation?.last ? `最近结果（纽约）：${new Date(automation.last.at).toLocaleString('zh-CN', { timeZone: 'America/New_York' })}\n${automation.last.message}` : '尚无自动兑换记录';
  return <section className="reset-credit-card" aria-label="额度重置卡">
    <span className="ticket-icon"><Ticket size={19} /></span>
    <div className="ticket-copy"><div>额度重置卡<strong>{data ? `${data.availableCount} 张可用` : '暂无信息'}</strong></div><small title={detail}>{detail}</small>
      <div className={`auto-reset-plan ${automation?.status === 'error' ? 'warning' : ''}`} title={`临期规则：纽约 01:00–09:00，提前 1 小时。\n低额度规则：实际剩余低于 1% 时全天自动使用。两项可在设置中独立开关。\n${plan}\n${history}\n需要程序运行、电脑唤醒并联网。`}><Clock3 size={11} /><span>{demo ? '界面预览 · 不触发演示卡兑换' : plan}</span></div>
    </div>
  </section>;
}

/** 管理真实状态、独立预览和悬浮窗口的交互。 */
function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(initial);
  const [demo, setDemo] = useState(!window.pulse);
  const [preview] = useState(demoState);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [loginBusy, setLoginBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [packaged, setPackaged] = useState(false);
  const dragGesture = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const prefs = snapshot.settings;
  const view = demo ? preview : snapshot;
  const windows = [view.quota?.primary, view.quota?.secondary].filter((item): item is QuotaWindow => !!item);
  const selected = prefs.usageSources || agents;
  const usage = selectedUsage(view.usage, selected, now);
  const single = windows.length <= 1 && !settingsOpen && !usageOpen;
  const showCredits = !!view.quota && !settingsOpen && !usageOpen;
  const showUsage = !settingsOpen && !usageOpen;

  useEffect(() => {
    void window.pulse?.layout(single, showCredits, showUsage).catch(() => setNotice('窗口尺寸调整失败，请重启应用。'));
  }, [single, showCredits, showUsage]);

  useEffect(() => {
    const unsubscribe = window.pulse?.subscribe(setSnapshot);
    void window.pulse?.get().then(data => { setSnapshot(data); setPackaged(!!data.packaged); }).catch(() => setNotice('桌面服务连接失败，请重启应用。'));
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { unsubscribe?.(); clearInterval(timer); };
  }, []);

  /** 将设置变更交给主进程应用；浏览器预览仅保留本地状态。 */
  async function change(patch: Partial<Preferences>) {
    const updated = window.pulse ? await window.pulse.settings(patch) : { ...prefs, ...patch };
    setSnapshot(current => ({ ...current, settings: updated }));
  }

  /** 打开官方授权流程，并把可恢复错误展示在当前界面。 */
  async function signIn() {
    if (!window.pulse) { setNotice('请在桌面应用内连接 ChatGPT 账号。'); return; }
    setLoginBusy(true);
    setNotice('');
    setDemo(false);
    try {
      const result = await window.pulse.login();
      if (!result.ok) setNotice(result.error || '登录失败，请重试。');
    } catch { setNotice('登录服务不可用，请重试。'); }
    finally { setLoginBusy(false); }
  }

  /** 手动读取真实额度，演示状态下不触发账号请求。 */
  async function sync() {
    if (demo) { setNotice('当前为界面预览，请退出预览后同步真实额度。'); return; }
    try { if (window.pulse) await window.pulse.refresh(); } catch { setNotice('刷新失败，请重试。'); }
  }

  /** 捕获左键手势，整窗既可点击，也可按住拖动。 */
  function startDrag(event: React.PointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    suppressClick.current = false;
    dragGesture.current = { id: event.pointerId, x: event.screenX, y: event.screenY, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    window.pulse?.drag('start');
  }

  /** 超过五像素后视为拖动，屏幕坐标不会随窗口移动回跳。 */
  function moveDrag(event: React.PointerEvent<HTMLElement>) {
    const gesture = dragGesture.current;
    if (!gesture || gesture.id !== event.pointerId) return;
    if (Math.hypot(event.screenX - gesture.x, event.screenY - gesture.y) >= 5) gesture.moved = true;
    window.pulse?.drag('move');
  }

  /** 结束或取消拖动，抑制拖动产生的点击，防止误展开。 */
  function endDrag(event: React.PointerEvent<HTMLElement>) {
    const gesture = dragGesture.current;
    if (!gesture || gesture.id !== event.pointerId) return;
    suppressClick.current = gesture.moved || event.type !== 'pointerup';
    dragGesture.current = null;
    window.pulse?.drag('end');
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  /** 单击任意迷你窗内容即可展开，拖动后的合成点击仅消费标记。 */
  function expandCompact() {
    if (suppressClick.current) { suppressClick.current = false; return; }
    void change({ compact: false });
  }

  const connected = view.status === 'connected';
  const statusText = demo ? '演示数据' : snapshot.busy ? '正在同步' : connected ? '实时同步' : view.status === 'logging-in' ? '等待授权' : view.status === 'signed-out' ? '尚未连接' : view.status === 'error' ? '连接异常' : '连接中';
  const age = view.updatedAt ? Math.max(0, Math.floor((now - view.updatedAt) / 1000)) : null;
  const ageText = age === null ? '等待首次同步' : age < 60 ? `${age} 秒前更新` : `${Math.floor(age / 60)} 分钟前更新`;

  const todayTokens = usage.tokens;
  if (prefs.compact) return <main className="compact-shell" role="button" tabIndex={0} aria-label="展开面板" onClick={expandCompact}
    onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void change({ compact: false }); } }}>
    <div className="compact-brand"><Activity size={20} /><span>PULSE<small>{demo ? '演示数据' : connected ? '额度监视' : statusText}</small></span></div>
    {windows.map((item, index) => <div key={index} className={`compact-value ${index ? 'violet' : 'mint'}`}>{Math.round(item.remaining)}%<small>{item.minutes === 10080 ? '周额度' : period(item.minutes, '额度').replace('额度', '')}</small></div>)}
    {!windows.length && <div className="compact-value mint">—<small>暂无额度</small></div>}
    <button className="compact-usage" onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); setUsageOpen(true); setSettingsOpen(false); void change({ compact: false }); }} title={todayTokens === null ? usage.error || '等待今日用量同步' : `今日所选来源：${todayTokens.toLocaleString('zh-CN')} Tokens（含缓存）· 点击查看详细`}>
      {todayTokens === null ? '—' : formatTokens(todayTokens)}<small>{usage.error ? '读取失败' : usage.missing ? '今日 Token · 部分' : '今日 Token'}</small>
    </button>
    {view.quota?.resetCredits && <div className="compact-credits" title={`额度重置卡：${view.quota.resetCredits.availableCount} 张可用`} aria-label={`重置卡 ${view.quota.resetCredits.availableCount} 张`}><Ticket size={15} /><span>{view.quota.resetCredits.availableCount}</span></div>}
  </main>;

  return <main className={`shell ${single ? 'single-quota' : ''} ${showCredits ? 'with-credits' : ''} ${showUsage ? 'with-usage' : ''}`}>
    <div className="ambient" />
    <header className="topbar drag">
      <div className="brand"><span className="brand-mark"><Activity size={19} strokeWidth={1.8} /></span><span>codex<span className="brand-light">pulse</span><small>YOUR AMBIENT COMPANION</small></span></div>
      <div className="window-actions no-drag">
        <IconButton title={prefs.pinned ? '取消置顶' : '窗口置顶'} active={prefs.pinned} onClick={() => void change({ pinned: !prefs.pinned })}><Pin size={14} /></IconButton>
        <IconButton title="隐藏到系统托盘" onClick={() => window.pulse?.hide()}><Minus size={16} /></IconButton>
      </div>
    </header>

    {usageOpen ? <UsagePanel data={view.usage} selected={selected} now={now} onChange={value => void change({ usageSources: value })} onBack={() => setUsageOpen(false)} demo={demo} /> : settingsOpen ? <div className="settings-panel">
      <div className="section-title"><button className="back" onClick={() => setSettingsOpen(false)}><ChevronLeft size={17} />偏好设置</button><span className="micro">MAKE IT YOURS</span></div>
      <div className="setting-row"><div>始终置顶<small>让额度保持在视线之内</small></div><Toggle label="始终置顶" checked={prefs.pinned} onChange={() => void change({ pinned: !prefs.pinned })} /></div>
      <div className="setting-row"><div>低额度提醒<small>剩余 20% / 10% 时通知</small></div><Toggle label="低额度提醒" checked={prefs.notifications} onChange={() => void change({ notifications: !prefs.notifications })} /></div>
      <div className="setting-row"><div>自动使用临期重置卡<small>每天纽约 01:00–09:00 · 提前 1 小时</small></div><Toggle label="自动使用临期重置卡" checked={prefs.autoReset} onChange={() => void change({ autoReset: !prefs.autoReset })} /></div>
      <div className="setting-row"><div>余量低于 1% 自动使用<small>全天生效 · 不受工作时间限制</small></div><Toggle label="余量低于 1% 自动使用" checked={prefs.lowQuotaReset} onChange={() => void change({ lowQuotaReset: !prefs.lowQuotaReset })} /></div>
      <div className="automation-result" title={snapshot.autoReset?.last?.message}>最近结果：{snapshot.autoReset?.last?.message || '尚无兑换记录'}<small>程序须运行且电脑保持唤醒；官方可能暂无可重置额度。</small></div>
      <div className="setting-row"><div>开机启动<small>{packaged ? '登录 Windows 后自动运行' : '打包版本中可开启'}</small></div><Toggle label="开机启动" checked={prefs.startup} disabled={!packaged} onChange={() => void change({ startup: !prefs.startup })} /></div>
      <div className="setting-row"><div>同步频率<small>后台自动更新真实额度</small></div><select aria-label="同步频率" value={prefs.interval} onChange={event => void change({ interval: Number(event.target.value) })}><option value={30}>30 秒</option><option value={60}>1 分钟</option><option value={120}>2 分钟</option><option value={300}>5 分钟</option></select></div>
      <div className="opacity-setting"><div>窗口不透明度<span>{prefs.opacity}%</span></div><input aria-label="窗口不透明度" type="range" min="65" max="100" value={prefs.opacity} onChange={event => void change({ opacity: Number(event.target.value) })} /></div>
      <button className="secondary-button" onClick={() => { setDemo(!demo); setSettingsOpen(false); setNotice(''); }}><Eye size={15} />{demo ? '退出界面预览' : '体验界面预览'}<ArrowUpRight size={14} /></button>
      <button className="quit-button" onClick={() => window.pulse?.quit()}><Power size={13} />退出 Codex Pulse</button>
    </div> : <>
      <div className="overview"><div><span className="eyebrow">WORK WITHOUT INTERRUPTIONS</span><h1>专注创作，余量在握<span>。</span></h1></div><span className={`status ${demo ? 'demo' : connected ? '' : 'offline'}`}><i />{statusText}</span></div>
      <div className="account-row"><div className="account-icon"><Sparkles size={14} /></div><span className="account-name" title={view.account?.email || ''}>{view.account?.email || '你的 Codex 工作空间'}</span><span className="plan">{view.account?.planType?.toUpperCase() || view.quota?.plan?.toUpperCase() || 'CHATGPT'}</span></div>
      <div className="quota-stack">{windows.map((item, index) => <QuotaCard key={index} data={item} secondary={index > 0} now={now} />)}
        {!windows.length && <div className="quota-empty"><Activity size={24} /><span>{view.status === 'connected' ? '当前账号暂无可用额度窗口' : view.status === 'error' ? '额度暂时无法获取，请重试' : view.status === 'signed-out' ? '连接账号后显示实际额度' : '等待额度同步'}</span></div>}
      </div>
      {showCredits && <ResetCreditCard data={view.quota?.resetCredits} now={now} automation={snapshot.autoReset} demo={demo} />}
      {showUsage && <UsageCard data={usage} now={now} onClick={() => setUsageOpen(true)} />}
      {demo ? <button className="insight preview-note" onClick={() => { setDemo(false); setNotice(''); }}><Eye size={14} /><span>界面预览 · 当前数值为演示数据</span><X size={13} /></button>
        : !connected && !view.quota ? <button className="connect-button" disabled={loginBusy} onClick={() => void signIn()}><LogIn size={15} /><span>{loginBusy ? '正在打开浏览器…' : view.status === 'logging-in' ? '在浏览器完成授权 · 重新打开' : '连接 ChatGPT 账号'}</span><ExternalLink size={13} /></button>
        : <div className={`insight ${view.status === 'error' ? 'warning' : ''}`}><ShieldCheck size={14} /><span>{view.status === 'error' ? '同步失败 · 显示上次成功获取的数据' : '官方额度同步，让每一次灵感从容发生'}</span></div>}
      {(notice || view.error) && <div className="notice" role="status" title={notice || view.error || ''}>{notice || view.error}</div>}
    </>}

    <footer><button className={`refresh-button ${snapshot.busy && !demo ? 'syncing' : ''}`} disabled={snapshot.busy && !demo} onClick={() => void sync()} title="立即刷新"><RefreshCw size={12} /><span>{demo ? '预览模式' : ageText}</span></button><div className="footer-actions"><IconButton title="偏好设置" active={settingsOpen} onClick={() => { setUsageOpen(false); setSettingsOpen(!settingsOpen); }}><Settings2 size={15} /></IconButton><span className="divider" /><IconButton title="收起为迷你悬浮窗" onClick={() => { setSettingsOpen(false); setUsageOpen(false); void change({ compact: true }); }}><ArrowDownLeft size={16} /></IconButton></div></footer>
    {!settingsOpen && !usageOpen && !view.quota && !demo && <button className="empty-preview" onClick={() => setDemo(true)}><Eye size={11} />先看看界面效果</button>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
