// 进京证管理平台：HTTP 服务 + API 路由 + 静态站点托管
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store, newId } from './src/store.js';
import { JjzClient, JjzError } from './src/jjz.js';
import { defaultBaseUrl } from './src/endpoints.js';
import { normalizeStateList, extractProfile, maskToken } from './src/normalize.js';
import { stamp, today } from './src/date.js';
import { Scheduler, defaultAutoConfig } from './src/scheduler.js';
import { notifyUser, sendServerChan, isNotifyConfigured } from './src/notify.js';
import { missingParams } from './src/apply.js';
import { searchPoi, reverseGeocode } from './src/geo.js';
import { validateSettings, validateUserPatch, validateAutoPatch } from './src/validate.js';

// 兜底：任何未捕获的异步异常都不应该让服务进程退出。
// 调度器承担着「证件到期当天自动办理」的职责，进程意外退出可能直接导致漏办。
process.on('unhandledRejection', (err) => console.error('[进程] 未处理的 Promise 拒绝：', err));
process.on('uncaughtException', (err) => console.error('[进程] 未捕获异常：', err));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const useMock = args.includes('--mock');
const portArg = args.find((a) => a.startsWith('--port='));
const dataArg = args.find((a) => a.startsWith('--data='));

const PORT = Number(portArg ? portArg.split('=')[1] : process.env.PORT || 3000);
const DATA_DIR = dataArg ? path.resolve(dataArg.split('=')[1]) : path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');

const store = new Store(DATA_DIR);

// 兼容早期版本写入的车辆配置：补齐字段并迁移已废弃的字段名
let migrated = false;
for (const user of store.users) {
  for (const vehicle of user.vehicles || []) {
    vehicle.auto = vehicle.auto || {};
    const prev = vehicle.auto.el || {};
    const upToDate =
      'pendingConfirm' in prev && 'lastCheckedAt' in prev && !('pendingConfirmAt' in prev) && !('lastSubmitDate' in prev);
    if (upToDate) continue;
    const next = { ...defaultAutoConfig(), ...prev };
    if (prev.pendingConfirmAt && !next.pendingConfirm) {
      next.pendingConfirm = { at: prev.pendingConfirmAt, attempts: 0, since: prev.lastSubmitDate || today() };
    }
    delete next.pendingConfirmAt;
    delete next.lastSubmitDate;
    vehicle.auto.el = next;
    migrated = true;
  }
}
if (migrated) store.save();

/** 最近一次查询的原始响应，仅驻留内存，避免把配置文件撑大 */
const rawCache = new Map();

/** 正在后台回源的用户，避免页面高频轮询时重复触发 */
const refreshing = new Set();

// 启动时恢复上次查询结果，避免重启后仪表盘空白
for (const [userId, entry] of Object.entries(store.loadState())) {
  rawCache.set(userId, entry);
}

let client = buildClient();

function persistState() {
  store.saveState(Object.fromEntries(rawCache));
}

function setSnapshot(userId, envelope, normalized) {
  rawCache.set(userId, {
    envelope,
    normalized,
    fetchedAt: Date.now(),
    cached: Boolean(envelope.cached),
  });
  persistState();
}

const scheduler = new Scheduler({
  store,
  getClient: () => client,
  setSnapshot,
  notify: (user, message) => notifyUser(user, message),
  record: (entry) => store.appendHistory(entry),
  log: (message) => console.log(message),
});

/** 快照超过 viewRefreshSec 的用户，需要后台回源 */
function staleUsers() {
  const s = store.config.settings;
  if (!s.autoRefreshOnView) return [];
  const threshold = (Number(s.viewRefreshSec) || 0) * 1000;
  if (threshold <= 0) return [];
  const now = Date.now();
  return store.users.filter((u) => {
    if (!u.enabled) return false;
    const entry = rawCache.get(u.id);
    return !entry || now - entry.fetchedAt > threshold;
  });
}

/**
 * 后台回源：立刻返回旧快照，新数据等下一次轮询取。
 * 是否真的发出网络请求由客户端 TTL（cacheTtlSec）决定，页面轮询无法击穿它。
 */
function revalidate(users) {
  for (const user of users) {
    if (refreshing.has(user.id)) continue;
    refreshing.add(user.id);
    refreshUser(user, { force: false })
      .then(() => store.save())
      .catch((err) => {
        user.lastError = err instanceof JjzError ? err.bizMsg || err.message : err.message;
        user.updatedAt = stamp();
        store.save();
      })
      .finally(() => refreshing.delete(user.id));
  }
}

function buildClient() {
  const s = store.config.settings;
  return new JjzClient({
    baseUrl: s.baseUrl || defaultBaseUrl(),
    minIntervalMs: Number.isFinite(s.minIntervalMs) ? s.minIntervalMs : 1200,
    cacheTtlMs: (Number(s.cacheTtlSec) || 300) * 1000,
    insecureTLS: Boolean(s.insecureTLS),
    mockDir: useMock ? path.join(__dirname, 'test', 'fixtures') : null,
  });
}

// ---------- 工具 ----------

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 512) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function publicUser(user) {
  const entry = rawCache.get(user.id);
  return {
    id: user.id,
    note: user.note,
    enabled: user.enabled,
    profile: user.profile,
    notify: user.notify,
    applyParams: user.applyParams,
    vehicles: user.vehicles,
    tokenMasked: maskToken(user.token),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastCheckedAt: user.lastCheckedAt,
    lastError: user.lastError,
    snapshotFetchedAt: entry ? entry.fetchedAt : null,
  };
}

function cacheOf(userId) {
  const hit = rawCache.get(userId);
  return hit ? hit.normalized : null;
}

/** 拉取状态、更新用户档案与车辆清单、写快照 */
async function refreshUser(user, { force = false } = {}) {
  const envelope = await client.stateList(user.token, { cache: !force });
  const normalized = normalizeStateList(envelope);
  const profile = extractProfile(envelope);

  if (profile.name) user.profile.name = profile.name;
  if (profile.idCard) {
    user.profile.idCard = profile.idCard;
    user.profile.idCardMasked = profile.idCardMasked;
  }

  // 车辆清单以接口为准，但保留用户已配置的自动办理规则：
  // 接口里消失的车辆只标记为 inactive，规则不丢，避免临时查询异常导致配置被清空
  const seen = new Set();
  for (const v of normalized.vehicles) {
    seen.add(v.vId);
    let record = user.vehicles.find((x) => x.vId === v.vId);
    if (!record) {
      record = {
        id: newId('v'),
        vId: v.vId,
        plate: v.plate,
        plateType: v.plateType,
        vehicleType: v.vehicleType,
        auto: {
          el: defaultAutoConfig(),
        },
        active: true,
      };
      user.vehicles.push(record);
    }
    record.plate = v.plate;
    record.plateType = v.plateType;
    record.vehicleType = v.vehicleType;
    record.active = true;
  }
  for (const record of user.vehicles) {
    if (!seen.has(record.vId)) record.active = false;
  }

  user.lastCheckedAt = stamp();
  user.updatedAt = stamp();
  user.lastError = null;
  rawCache.set(user.id, { envelope, normalized, fetchedAt: Date.now(), cached: Boolean(envelope.cached) });
  persistState();
  // 命中缓存不写历史，避免页面轮询把历史文件刷成重复数据
  if (!envelope.cached) {
    store.appendHistory({
    at: user.lastCheckedAt,
    userId: user.id,
    type: 'state',
    vehicles: normalized.vehicles.map((v) => ({
      plate: v.plate,
      yl: v.yl.current ? { status: v.yl.current.status, validTo: v.yl.current.validTo } : null,
      el: v.el.current ? { status: v.el.current.status, validTo: v.el.current.validTo } : null,
      counters: v.counters,
    })),
  });
  }
  return normalized;
}

// ---------- 路由 ----------

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const regex = new RegExp(
    `^${pattern.replace(/:([A-Za-z]+)/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    })}$`,
  );
  routes.push({ method, regex, keys, handler });
}

route('GET', '/api/health', async () => ({
  ok: true,
  mock: useMock,
  now: stamp(),
  today: today(),
  dataDir: DATA_DIR,
  users: store.users.length,
  stats: client.stats,
}));

route('GET', '/api/settings', async () => ({ settings: pickPublicSettings() }));

route('PATCH', '/api/settings', async (_req, _m, body) => {
  const patch = validateSettings(body, store.config.settings);
  const beforeTickSec = store.config.settings.scheduler?.tickSec;
  Object.assign(store.config.settings, patch);
  store.save();
  client = buildClient();
  // 只有调度间隔真的变了才重启定时器，且不立即检查：
  // 否则「保存设置」这个动作会顺手触发一次真实办理检查
  if (store.config.settings.scheduler?.tickSec !== beforeTickSec) {
    scheduler.start({ immediate: false });
  }
  return { settings: store.config.settings };
});

route('GET', '/api/users', async () => ({ users: store.users.map(publicUser) }));

route('POST', '/api/users', async (_req, _m, body) => {
  const token = String(body.token || '').trim();
  if (!token) throw Object.assign(new Error('请填写 Authorization'), { status: 400 });
  if (store.users.some((u) => u.token === token)) {
    throw Object.assign(new Error('该 Authorization 已存在'), { status: 409 });
  }

  const user = store.addUser({ token, note: String(body.note || '').trim() });
  try {
    await refreshUser(user, { force: true });
  } catch (err) {
    store.removeUser(user.id);
    throw err;
  }
  store.save();
  return { user: publicUser(user) };
});

route('PATCH', '/api/users/:id', async (_req, m, body) => {
  const user = store.findUser(m.id);
  if (!user) throw Object.assign(new Error('用户不存在'), { status: 404 });
  const patch = validateUserPatch(body);
  // 办理参数做合并而不是整体替换，避免漏传字段把已有配置抹掉
  if (patch.applyParams) patch.applyParams = { ...user.applyParams, ...patch.applyParams };
  Object.assign(user, patch);
  user.updatedAt = stamp();
  store.save();
  return { user: publicUser(user) };
});

route('DELETE', '/api/users/:id', async (_req, m) => {
  const user = store.findUser(m.id);
  if (!user) throw Object.assign(new Error('用户不存在'), { status: 404 });
  store.removeUser(user.id);
  rawCache.delete(user.id);
  store.save();
  return { ok: true };
});

route('POST', '/api/users/:id/refresh', async (_req, m, body) => {
  const user = store.findUser(m.id);
  if (!user) throw Object.assign(new Error('用户不存在'), { status: 404 });
  try {
    const normalized = await refreshUser(user, { force: Boolean(body.force) });
    store.save();
    return { state: normalized, user: publicUser(user) };
  } catch (err) {
    user.lastError = err instanceof JjzError ? err.bizMsg || err.message : err.message;
    user.updatedAt = stamp();
    store.save();
    throw err;
  }
});

route('GET', '/api/dashboard', async () => {
  // 先回旧快照、再异步回源；refreshing 要在起手之后取，否则响应里看不到回源状态
  revalidate(staleUsers());
  const users = store.users.map((user) => ({
    ...publicUser(user),
    state: cacheOf(user.id),
    refreshing: refreshing.has(user.id),
  }));
  const vehicles = users.flatMap((u) => (u.state?.vehicles || []).map((v) => ({ ...v, userId: u.id, owner: u.profile.name || u.note || '未命名' })));
  const summary = {
    users: users.length,
    vehicles: vehicles.length,
    active: vehicles.filter((v) => v.yl.current?.isActive || v.el.current?.isActive).length,
    expiring: vehicles.filter((v) => v.yl.needsAttention || v.el.needsAttention).length,
    error: users.filter((u) => u.lastError).length,
    refreshing: users.filter((u) => u.refreshing).length,
  };
  return { summary, users, vehicles, today: today(), settings: pickPublicSettings() };
});

function pickPublicSettings() {
  const s = store.config.settings;
  return {
    cacheTtlSec: s.cacheTtlSec,
    viewRefreshSec: s.viewRefreshSec,
    minIntervalMs: s.minIntervalMs,
    autoRefreshOnView: s.autoRefreshOnView,
    scheduler: s.scheduler,
    // 接口地址刻意不下发：页面上不应该看到它
  };
}

route('GET', '/api/users/:id/raw', async (_req, m) => {
  const hit = rawCache.get(m.id);
  if (!hit) throw Object.assign(new Error('暂无数据，请先刷新'), { status: 404 });
  return { fetchedAt: hit.fetchedAt, cached: hit.cached, envelope: hit.envelope };
});

// ---------- 定时任务 ----------

route('GET', '/api/tasks', async () => {
  const tasks = [];
  for (const user of store.users) {
    const view = cacheOf(user.id);
    for (const vehicle of user.vehicles || []) {
      const v = view?.vehicles.find((x) => x.vId === vehicle.vId);
      const permit = v?.el?.current || null;
      const auto = vehicle.auto?.el || defaultAutoConfig();
      tasks.push({
        userId: user.id,
        owner: user.profile?.name || user.note || '未命名',
        vehicleId: vehicle.id,
        vId: vehicle.vId,
        plate: vehicle.plate,
        active: vehicle.active !== false,
        auto,
        permit: permit
          ? { status: permit.status, validFrom: permit.validFrom, validTo: permit.validTo, isActive: permit.isActive }
          : null,
        // 触发点：当前六环外证件的最后一天 + 用户设定的时间
        nextTrigger: permit ? `${permit.validTo} ${auto.time || '09:00'}` : null,
        paramsReady: missingParams(user.applyParams || {}).length === 0,
        notifyReady: isNotifyConfigured(user),
      });
    }
  }
  return {
    tasks,
    scheduler: {
      enabled: Boolean(store.config.settings.scheduler?.enabled),
      tickSec: Number(store.config.settings.scheduler?.tickSec) || 60,
      lastTickAt: scheduler.lastTickAt,
      history: store
        .readHistory({ limit: 200 })
        .filter((r) => r.type === 'apply')
        .slice(-20)
        .reverse(),
    },
  };
});

route('PATCH', '/api/users/:id/vehicles/:vid/auto', async (_req, m, body) => {
  const user = store.findUser(m.id);
  if (!user) throw Object.assign(new Error('用户不存在'), { status: 404 });
  const vehicle = (user.vehicles || []).find((v) => v.id === m.vid || v.vId === m.vid);
  if (!vehicle) throw Object.assign(new Error('车辆不存在'), { status: 404 });

  const safe = validateAutoPatch(body);
  const wasEnabled = vehicle.auto?.el?.enabled === true;
  const merged = { ...defaultAutoConfig(), ...(vehicle.auto?.el || {}), ...safe };

  if (merged.enabled && !merged.warnAck) {
    throw Object.assign(new Error('开启六环外自动办理前，请先勾选确认行驶范围提示'), { status: 400 });
  }
  // 从关闭切到开启时清掉当天标记，便于当天立即生效
  if (merged.enabled && !wasEnabled) {
    merged.lastEvalDate = null;
    merged.attempt = null;
  }

  vehicle.auto = { ...(vehicle.auto || {}), el: merged };
  store.save();
  return { task: { vehicleId: vehicle.id, plate: vehicle.plate, auto: merged } };
});

route('POST', '/api/tasks/tick', async () => {
  const events = await scheduler.tick();
  return { events, lastTickAt: scheduler.lastTickAt };
});

route('POST', '/api/geo/search', async (_req, _m, body) => {
  const keyword = String(body.keyword || '').trim();
  if (keyword.length < 2) throw Object.assign(new Error('请输入至少 2 个字的地点名称'), { status: 400 });
  return { results: await searchPoi(keyword) };
});

route('POST', '/api/geo/reverse', async (_req, _m, body) => {
  const { lng, lat } = body || {};
  if (!lng || !lat) throw Object.assign(new Error('缺少经纬度'), { status: 400 });
  return { geo: await reverseGeocode(lng, lat) };
});

route('POST', '/api/users/:id/notify-test', async (_req, m) => {
  const user = store.findUser(m.id);
  if (!user) throw Object.assign(new Error('用户不存在'), { status: 404 });
  if (!isNotifyConfigured(user)) {
    throw Object.assign(new Error('尚未启用 Server酱或未填写 SendKey'), { status: 400 });
  }
  await sendServerChan(user.notify.serverchan.sendKey, {
    title: '进京证管理平台 · 测试通知',
    desp: `收到这条消息说明推送配置成功。\n\n发送时间：${stamp()}`,
  });
  return { ok: true };
});

// ---------- 静态资源 ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    // 畸形百分号编码会让 decodeURIComponent 抛错，这里必须兜住，
    // 否则异常会逃出请求处理器并终止整个进程
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('400 Bad Request');
    return;
  }
  const filePath = path.join(PUBLIC_DIR, rel);
  // 必须带上路径分隔符比较，否则同前缀目录（如 public-evil）也会被放过
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
    return;
  }
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const body = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
  res.end(body);
}

// ---------- 主循环 ----------

async function handleRequest(req, res) {
  let pathname;
  try {
    pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('400 Bad Request');
    return;
  }

  if (!pathname.startsWith('/api/')) {
    serveStatic(req, res, pathname);
    return;
  }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const match = r.regex.exec(pathname);
    if (!match) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, match[i + 1]]));
    try {
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
      const result = await r.handler(req, params, body);
      sendJson(res, 200, result);
    } catch (err) {
      const status = err.status || (err instanceof JjzError && err.isAuthFailure ? 401 : 500);
      const message = err instanceof JjzError ? err.bizMsg || err.message : err.message;
      sendJson(res, status, {
        error: { message, code: err.bizCode ?? null, authFailure: err instanceof JjzError ? err.isAuthFailure : false },
      });
    }
    return;
  }

  sendJson(res, 404, { error: { message: '接口不存在' } });
}

const server = http.createServer((req, res) => {
  // 单个请求出错只影响这一个请求，进程必须继续活着
  handleRequest(req, res).catch((err) => {
    console.error('[服务] 请求处理失败：', err);
    if (res.headersSent) res.end();
    else sendJson(res, 500, { error: { message: '服务器内部错误' } });
  });
});

server.listen(PORT, () => {
  console.log(`进京证管理平台已启动 http://127.0.0.1:${PORT}`);
  console.log(`数据目录：${DATA_DIR}`);
  if (useMock) console.log('当前为 mock 模式，不会请求真实接口');
  if (store.users.length === 0) console.log('提示：还没有添加任何用户，打开页面粘贴 Authorization 即可');
  scheduler.start();
  const autoCount = store.users.reduce(
    (n, u) => n + (u.vehicles || []).filter((v) => v.auto?.el?.enabled).length,
    0,
  );
  console.log(`调度器已启动，每 ${scheduler.tickSec} 秒检查一次，当前有 ${autoCount} 辆车开启自动办理`);
});
