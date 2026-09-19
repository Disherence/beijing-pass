// 自动办理：报文组装与前置校验
// 字段顺序与真实抓包报文保持一致，便于与基准报文逐字段对比
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 基准报文来自真实抓包（已脱敏），用于校验我们组装的字段集合是否一致 */
export function referenceKeys() {
  const file = path.join(__dirname, '..', 'test', 'fixtures', 'insertApplyRecord.request.json');
  if (!fs.existsSync(file)) return null;
  return Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/** 用户必须自行配置的办理参数 */
export const REQUIRED_PARAMS = [
  ['area', '进京目的地所在区县'],
  ['xxdz', '进京详细地址'],
  ['jjdzgdjd', '进京地址经度'],
  ['jjdzgdwd', '进京地址纬度'],
  ['zjxxdz', '在京详细地址'],
  ['zjxxdzgdjd', '在京地址经度'],
  ['zjxxdzgdwd', '在京地址纬度'],
  ['sqdzgdjd', '申请地经度'],
  ['sqdzgdwd', '申请地纬度'],
  ['jjmd', '进京目的地编码'],
  ['jjmdmc', '进京目的地名称'],
];

export function missingParams(params = {}) {
  return REQUIRED_PARAMS.filter(([key]) => {
    const v = params[key];
    return v === undefined || v === null || v === '';
  }).map(([key, label]) => label);
}

/**
 * 组装 insertApplyRecord 报文。
 * 车辆相关字段一律从状态接口的原始车辆对象透传，避免我们自己再造一遍。
 */
export function buildApplyPayload({ rawVehicle, jsrxx, jjrq, params, jjzzl = '02' }) {
  return {
    vId: rawVehicle.vId,
    hphm: rawVehicle.hphm,
    hpzl: rawVehicle.hpzl,
    ylzsfkb: rawVehicle.ylzsfkb,
    elzsfkb: rawVehicle.elzsfkb,
    elzqyms: rawVehicle.elzqyms,
    ylzqyms: rawVehicle.ylzqyms,
    elzmc: rawVehicle.elzmc,
    ylzmc: rawVehicle.ylzmc,
    cllx: rawVehicle.cllx,
    jjzzl,
    jsrxm: jsrxx.jsrxm,
    jszh: jsrxx.jszh,
    dabh: jsrxx.dabh || '',
    txrxx: [],
    jjrq,
    area: params.area,
    jjdq: params.jjdq || '010',
    xxdz: params.xxdz,
    jjdzgdwd: params.jjdzgdwd,
    jjdzgdjd: params.jjdzgdjd,
    jingState: '',
    jjmd: params.jjmd,
    jjmdmc: params.jjmdmc,
    sqdzgdjd: params.sqdzgdjd,
    sqdzgdwd: params.sqdzgdwd,
    sfzj: params.sfzj || '1',
    zjxxdz: params.zjxxdz,
    zjxxdzgdjd: params.zjxxdzgdjd,
    zjxxdzgdwd: params.zjxxdzgdwd,
    // 以下为行驶路线字段，六环外不需要填写
    jjlk: '',
    jjlkmc: '',
    jjlkgdjd: '',
    jjlkgdwd: '',
  };
}

/** 组装结果与基准报文的字段集合比对，防止漏字段或多字段 */
export function diffAgainstReference(payload) {
  const ref = referenceKeys();
  if (!ref) return { ok: true, skipped: true };
  const mine = Object.keys(payload);
  return {
    ok: ref.length === mine.length && ref.every((k) => mine.includes(k)),
    missing: ref.filter((k) => !mine.includes(k)),
    extra: mine.filter((k) => !ref.includes(k)),
    orderMatches: ref.every((k, i) => mine[i] === k),
  };
}
