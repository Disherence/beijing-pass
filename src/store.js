// JSON 持久化：配置读写在内存中完成，落盘用「临时文件 + rename」，避免写坏文件
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { stamp } from './date.js';

const DEFAULT_CONFIG = {
  version: 1,
  settings: {
    // 留空表示使用内置地址；需要覆盖时在这里填写，或设置环境变量 JJZ_BASE_URL
    baseUrl: '',
    // 上游请求的最小间隔兜底：页面轮询再频繁也无法突破这个下限
    cacheTtlSec: 300,
    minIntervalMs: 1200,
    // 页面打开/轮询时，快照超过这个时长就异步回源一次
    viewRefreshSec: 300,
    autoRefreshOnView: true,
    insecureTLS: false,
    scheduler: { enabled: true, tickSec: 60 },
  },
  users: [],
};

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.configPath = path.join(dataDir, 'config.json');
    this.historyPath = path.join(dataDir, 'history.jsonl');
    this.statePath = path.join(dataDir, 'state.json');
    /** 历史文件超过这个大小就轮转，避免无界增长 */
    this.maxHistoryBytes = 5 * 1024 * 1024;
    this.config = this.#load();
  }

  /** 最近一次查询结果，重启后仪表盘仍能显示上次已知状态 */
  loadState() {
    if (!fs.existsSync(this.statePath)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch {
      return {};
    }
  }

  saveState(state) {
    const tmp = `${this.statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, this.statePath);
  }

  #load() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (!fs.existsSync(this.configPath)) {
      // 配置与快照含 Authorization、身份信息，权限收紧到仅属主可读写
      fs.writeFileSync(this.configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), { mode: 0o600 });
      return structuredClone(DEFAULT_CONFIG);
    }
    const raw = fs.readFileSync(this.configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...structuredClone(DEFAULT_CONFIG),
      ...parsed,
      settings: { ...DEFAULT_CONFIG.settings, ...(parsed.settings || {}) },
      users: parsed.users || [],
    };
  }

  save() {
    const tmp = `${this.configPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.config, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.configPath);
  }

  get users() {
    return this.config.users;
  }

  findUser(id) {
    return this.config.users.find((u) => u.id === id);
  }

  addUser({ token, note = '' }) {
    const user = {
      id: newId('u'),
      token,
      note,
      enabled: true,
      profile: { name: '', idCard: '', idCardMasked: '', userId: '' },
      notify: { serverchan: { enabled: false, sendKey: '' } },
      applyParams: {},
      vehicles: [],
      createdAt: stamp(),
      updatedAt: stamp(),
      lastCheckedAt: null,
      lastError: null,
    };
    this.config.users.push(user);
    return user;
  }

  removeUser(id) {
    const i = this.config.users.findIndex((u) => u.id === id);
    if (i < 0) return false;
    this.config.users.splice(i, 1);
    return true;
  }

  /** 追加一条快照；文件按行存储，便于后续做趋势分析 */
  appendHistory(record) {
    this.#rotateHistoryIfNeeded();
    fs.appendFileSync(this.historyPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }

  #rotateHistoryIfNeeded() {
    try {
      if (!fs.existsSync(this.historyPath)) return;
      if (fs.statSync(this.historyPath).size < this.maxHistoryBytes) return;
      const backup = `${this.historyPath}.1`;
      fs.rmSync(backup, { force: true });
      fs.renameSync(this.historyPath, backup);
    } catch {
      /* 轮转失败不应影响主流程 */
    }
  }

  /**
   * 只读文件尾部若干 KB。定时任务页每分钟都会调用一次，
   * 全量读取一个无界追加文件既慢又浪费。
   */
  readHistory({ limit = 200, maxBytes = 256 * 1024 } = {}) {
    if (!fs.existsSync(this.historyPath)) return [];
    const { size } = fs.statSync(this.historyPath);
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return [];

    const fd = fs.openSync(this.historyPath, 'r');
    let text;
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, start);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    // 从中间截断时，丢掉可能不完整的第一行
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }

    return text
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }
}
