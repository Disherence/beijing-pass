// 所有日期时间都按北京时间计算，不依赖容器/主机的 TZ 设置
const TZ = 'Asia/Shanghai';

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const stampFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function parts(format, date) {
  const out = {};
  for (const p of format.formatToParts(date)) out[p.type] = p.value;
  return out;
}

/** 北京时间的今天，格式 YYYY-MM-DD */
export function today(date = new Date()) {
  return dateFmt.format(date);
}

/** 北京时间的时间戳，格式 YYYY-MM-DD HH:MM:SS */
export function stamp(date = new Date()) {
  const p = parts(stampFmt, date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function toUTC(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** YYYY-MM-DD 加减天数 */
export function addDays(dateStr, days) {
  const dt = new Date(toUTC(dateStr) + days * 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** b - a 的天数差，按自然日计算 */
export function diffDays(a, b) {
  return Math.round((toUTC(b) - toUTC(a)) / 86400000);
}

/** HH:MM → 当天第几分钟 */
export function toMinutes(hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** 当前北京时间处于当天第几分钟 */
export function nowMinutes(date = new Date()) {
  const p = parts(stampFmt, date);
  return Number(p.hour) * 60 + Number(p.minute);
}
