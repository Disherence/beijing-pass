// 把交管接口的原始响应整理成界面能直接用的结构
// 注意：空数组时接口会直接把字段省掉，必须容错
import { diffDays, today } from './date.js';

export const PERMIT_TYPE = {
  YL: '01', // 六环内
  EL: '02', // 六环外
};

export const TYPE_LABEL = {
  [PERMIT_TYPE.YL]: '六环内',
  [PERMIT_TYPE.EL]: '六环外',
};

const ACTIVE = 1; // 审核通过(生效中)

// 待生效记录的字段名由 6 个字母组成：e c b z x x（注意不是 e c z b x x）。
// 拼错时该字段会静默变成 undefined，六环外记录整段消失，因此单独抽成常量。
const PENDING_RECORDS = 'ecbzxx';

// 导出给测试与其他模块复用，避免各处手打这个易错字面量
export { PENDING_RECORDS };

function recordsOf(vehicle) {
  return [...(vehicle.bzxx || []), ...(vehicle[PENDING_RECORDS] || [])];
}

/** 同一类型可能有多条（生效中 + 待生效），取有效期最靠后的那条作为当前证 */
function pickLatest(records) {
  return records.reduce((best, r) => (!best || r.yxqz > best.yxqz ? r : best), null);
}

function decorate(record, todayStr) {
  if (!record) return null;
  const remaining = record.yxqz ? diffDays(todayStr, record.yxqz) : null;
  return {
    applyId: record.applyId,
    statusCode: record.blzt,
    status: record.blztmc,
    validFrom: record.yxqs,
    validTo: record.yxqz,
    startLabel: record.sxrqmc,
    endLabel: record.sxrzmc,
    permitNo: record.jjzh,
    appliedAt: record.sqsj,
    rejectReason: record.shsbyy || record.shsbyyms || null,
    remainingDays: remaining,
    isActive: record.blzt === ACTIVE,
    /** 包含在证件上的印章图，接口给的是 base64 PNG */
    stampImage: record.tphtml ? `data:image/png;base64,${record.tphtml}` : null,
  };
}

/** 单个车辆对象 → 视图模型 */
export function normalizeVehicle(vehicle, todayStr = today()) {
  const all = recordsOf(vehicle);
  const byType = (code) => all.filter((r) => r.jjzzl === code).sort((a, b) => (a.yxqz < b.yxqz ? 1 : -1));

  const build = (code) => {
    const records = byType(code);
    const current = pickLatest(records);
    const decorated = decorate(current, todayStr);
    // 最后一天可续办：官方口径就是证件到期当天
    const lastDay = Boolean(decorated && decorated.validTo === todayStr);
    return {
      label: TYPE_LABEL[code],
      records: records.map((r) => decorate(r, todayStr)),
      current: decorated,
      lastDay,
      // 只把「还有效且即将到期」算作需要关注；已过期的旧证不计入，否则计数会永久虚高
      needsAttention: Boolean(
        decorated &&
          decorated.remainingDays !== null &&
          decorated.remainingDays >= 0 &&
          decorated.remainingDays <= 1,
      ),
    };
  };

  return {
    vId: vehicle.vId,
    plate: vehicle.hphm,
    plateType: vehicle.hpzl,
    vehicleType: vehicle.cllx,
    status: vehicle.qyzt,
    active: true,
    yl: build(PERMIT_TYPE.YL),
    el: build(PERMIT_TYPE.EL),
    counters: {
      ylUsed: toNum(vehicle.ybcs),
      ylLeft: toNum(vehicle.sycs),
      ylAllowed: Boolean(vehicle.ylzsfkb),
      elAllowed: Boolean(vehicle.elzsfkb),
    },
    rules: {
      yl: vehicle.ylzqyms || null,
      el: vehicle.elzqyms || null,
    },
  };
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

/** 整个 stateList 响应 → 视图模型 */
export function normalizeStateList(envelope, todayStr = today()) {
  const data = envelope?.data || {};
  const vehicles = (data.bzclxx || []).map((v) => normalizeVehicle(v, todayStr));
  return {
    idCard: data.sfzmhm || null,
    ylNotice: data.ylzqyms || null,
    elNotice: data.elzqyms || null,
    ylName: data.ylzmc || null,
    elName: data.elzmc || null,
    vehicles,
    raw: envelope,
  };
}

/** 从响应里推断用户身份：接口只回身份证，姓名要从办证记录里取 */
export function extractProfile(envelope) {
  const data = envelope?.data || {};
  const vehicles = data.bzclxx || [];
  let name = '';
  for (const v of vehicles) {
    for (const r of recordsOf(v)) {
      if (r.jsrxm) {
        name = r.jsrxm;
        break;
      }
    }
    if (name) break;
  }
  return { name, idCard: data.sfzmhm || '', idCardMasked: maskIdCard(data.sfzmhm) };
}

export function maskIdCard(id) {
  if (!id || id.length < 8) return id || '';
  return `${id.slice(0, 4)}**********${id.slice(-4)}`;
}

export function maskToken(token) {
  if (!token) return '';
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}
