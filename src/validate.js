// 接口入参校验：所有 PATCH 都必须经过这里
// 背景：本项目在局域网内默认可信，但表单字段直接落库意味着一个笔误就能
// 抹掉办理参数、把凭证发到别的域名，或让防重复提交的幂等键失效。

function bad(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function intInRange(value, min, max, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw bad(`${label}必须是数字`);
  const i = Math.trunc(n);
  if (i < min || i > max) throw bad(`${label}需在 ${min} ~ ${max} 之间`);
  return i;
}

const COORD_KEYS = ['jjdzgdjd', 'jjdzgdwd', 'zjxxdzgdjd', 'zjxxdzgdwd', 'sqdzgdjd', 'sqdzgdwd'];

export const APPLY_PARAM_KEYS = [
  'area',
  'xxdz',
  'jjdzgdjd',
  'jjdzgdwd',
  'zjxxdz',
  'zjxxdzgdjd',
  'zjxxdzgdwd',
  'sqdzgdjd',
  'sqdzgdwd',
  'jjmd',
  'jjmdmc',
  'sfzj',
  'jjdq',
];

/**
 * 校验全局设置。接口地址限定为 https + beijing.gov.cn，
 * 否则 Authorization 可能被发到任意主机。
 */
export function validateSettings(patch, current = {}) {
  if (!patch || typeof patch !== 'object') throw bad('设置内容格式不正确');
  const out = {};

  if ('baseUrl' in patch) {
    const raw = String(patch.baseUrl || '').trim().replace(/\/+$/, '');
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw bad('接口地址不是合法的 URL');
    }
    if (parsed.protocol !== 'https:') throw bad('接口地址必须使用 https');
    if (!/(^|\.)beijing\.gov\.cn$/i.test(parsed.hostname)) {
      throw bad('接口地址必须指向 beijing.gov.cn 域名，避免凭证被发送到其他主机');
    }
    out.baseUrl = raw;
  }

  if ('cacheTtlSec' in patch) out.cacheTtlSec = intInRange(patch.cacheTtlSec, 0, 86400, '查询缓存');
  if ('viewRefreshSec' in patch) out.viewRefreshSec = intInRange(patch.viewRefreshSec, 0, 86400, '页面回源阈值');
  if ('minIntervalMs' in patch) out.minIntervalMs = intInRange(patch.minIntervalMs, 0, 60000, '最小请求间隔');
  if ('autoRefreshOnView' in patch) out.autoRefreshOnView = Boolean(patch.autoRefreshOnView);
  if ('insecureTLS' in patch) out.insecureTLS = Boolean(patch.insecureTLS);

  if ('scheduler' in patch) {
    const s = patch.scheduler || {};
    const merged = { ...(current.scheduler || {}) };
    if ('enabled' in s) merged.enabled = Boolean(s.enabled);
    if ('tickSec' in s) merged.tickSec = intInRange(s.tickSec, 10, 3600, '调度间隔');
    out.scheduler = merged;
  }

  return out;
}

/** 校验用户级配置更新，只允许白名单字段 */
export function validateUserPatch(patch) {
  if (!patch || typeof patch !== 'object') throw bad('内容格式不正确');
  const out = {};

  if ('note' in patch) out.note = String(patch.note ?? '').slice(0, 100);
  if ('enabled' in patch) out.enabled = Boolean(patch.enabled);

  if ('notify' in patch) {
    const sc = patch.notify?.serverchan || {};
    out.notify = {
      serverchan: {
        enabled: Boolean(sc.enabled),
        sendKey: String(sc.sendKey ?? '').trim().slice(0, 200),
      },
    };
  }

  if ('applyParams' in patch) {
    const p = patch.applyParams;
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw bad('办理参数必须是对象');
    const clean = {};
    for (const key of APPLY_PARAM_KEYS) {
      if (key in p) clean[key] = String(p[key] ?? '').trim().slice(0, 200);
    }
    for (const key of COORD_KEYS) {
      if (clean[key] && !/^-?\d+(\.\d+)?$/.test(clean[key])) {
        throw bad(`经纬度格式不正确：${key}`);
      }
    }
    if (clean.jjmd && !/^0[1-9]$/.test(clean.jjmd)) throw bad('进京事由编码不合法');
    if (clean.sfzj && !/^[01]$/.test(clean.sfzj)) throw bad('「是否在京」取值不合法');
    out.applyParams = clean;
  }

  return out;
}

/**
 * 校验自动办理设置。只接受用户可编辑的四个字段，
 * 幂等键、最近评估日期等内部状态一律不允许从接口写入。
 */
export function validateAutoPatch(body) {
  const p = (body && typeof body === 'object' && body.el) || {};
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw bad('自动办理设置格式不正确');
  const out = {};

  if ('enabled' in p) out.enabled = Boolean(p.enabled);
  if ('warnAck' in p) out.warnAck = Boolean(p.warnAck);
  if ('makeup' in p) out.makeup = Boolean(p.makeup);
  if ('time' in p) {
    const time = String(p.time ?? '');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw bad('办理时间格式应为 HH:MM（24 小时制）');
    out.time = time;
  }

  return out;
}
