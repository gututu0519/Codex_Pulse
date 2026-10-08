const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');

/** 通过官方本地 App Server 读取账号与额度，不发起推理请求。 */
class CodexClient extends EventEmitter {
  /** 初始化请求表和连接状态。 */
  constructor() {
    super();
    this.pending = new Map();
    this.sequence = 0;
    this.child = null;
    this.ready = null;
  }

  /** 查找随应用一起分发的官方 Windows 可执行文件。 */
  executable() {
    const root = path.dirname(require.resolve('@openai/codex/package.json')).replace('app.asar', 'app.asar.unpacked');
    const candidates = [
      path.join(root, '../codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe'),
      path.join(root, '../codex-win32-x64/vendor/x86_64-pc-windows-msvc/codex/codex.exe'),
      path.join(root, 'vendor/x86_64-pc-windows-msvc/codex/codex.exe'),
    ];
    const found = candidates.find(candidate => fs.existsSync(candidate));
    if (!found) throw new Error('未找到内置 Codex 组件，请重新安装应用。');
    return found;
  }

  /** 合并并发启动并在初始化握手结束后开放请求。 */
  async connect() {
    if (this.ready) return this.ready;
    this.ready = this.start().catch(error => { this.stop(); throw error; });
    return this.ready;
  }

  /** 启动标准输入输出连接并处理响应、通知及意外退出。 */
  async start() {
    const child = spawn(this.executable(), ['app-server'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== undefined && message.method) {
        child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Unsupported request' } }) + '\n');
      } else if (message.id !== undefined) {
        const request = this.pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      } else if (message.method) this.emit('notification', message);
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => this.fail(new Error('无法启动 Codex 组件，请检查安装。'), child));
    child.on('exit', () => { lines.close(); this.fail(new Error('Codex 连接已中断，下次刷新将重新连接。'), child); });
    await this.request('initialize', { clientInfo: { name: 'codex_pulse', title: 'Codex Pulse', version: '0.1.0' } });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  }

  /** 带超时发送 JSONL 请求，避免网络异常导致永久等待。 */
  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.killed) return reject(new Error('Codex 尚未连接。'));
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('连接超时，请检查网络后重试。')); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('无法发送请求，请重新连接。'));
      });
    });
  }

  /** 清理当前连接的待处理请求，忽略旧进程的延迟退出事件。 */
  fail(error, child) {
    if (child !== this.child) return;
    this.child = null;
    this.ready = null;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }

  /** 退出时关闭子进程并释放请求资源。 */
  stop() {
    const child = this.child;
    this.fail(new Error('连接已关闭。'), child);
    child?.kill();
  }
}

module.exports = { CodexClient };
