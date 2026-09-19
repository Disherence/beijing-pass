// 从抓包文件生成脱敏测试样本
// 用途：开发与回归测试全程不再请求真实接口
// 用法：node tools/make-fixture.js [har文件]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { isJjzRequestUrl } from '../src/endpoints.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'test', 'fixtures');
const FAKE_TOKEN = '00000000-0000-0000-0000-000000000001';

const harPath =
  process.argv[2] ||
  fs.readdirSync(ROOT).find((f) => f.endsWith('.har'));

if (!harPath) {
  console.error('未找到 .har 文件，请把抓包文件放到项目根目录后重试');
  process.exit(1);
}

/** 按字段名脱敏，凡是能定位到个人的字段统一替换成假数据 */
const KEY_MAP = {
  hphm: '京A12345',
  jsrxm: '张三',
  jszh: '110101199001011234',
  sfzmhm: '110101199001011234',
  certNo: '110101199001011234',
  certName: '张三',
  mobile: '13800138000',
  xxdz: '北京市朝阳区建国路1号示例大厦',
  zjxxdz: '示例大厦',
  jjzh: 'A260101123456789',
  vId: '1000000000000000001',
  applyId: '1000000000000000002',
  vid: 1000000000000000001,
  userId: '1000000000000000003',
  token: FAKE_TOKEN,
  accessToken: FAKE_TOKEN,
  bjtToken: FAKE_TOKEN,
  toonNo: '315601396000',
  ip: '127.0.0.1',
  source: 'mock-source-id',
  jjdzgdjd: '116.400000',
  jjdzgdwd: '39.900000',
  zjxxdzgdjd: '116.400000',
  zjxxdzgdwd: '39.900000',
  sqdzgdjd: '116.400000',
  sqdzgdwd: '39.900000',
};

/** 递归脱敏；Array 保持长度以便前端分页逻辑照常工作 */
function scrub(value, key = '') {
  if (Object.prototype.hasOwnProperty.call(KEY_MAP, key)) return KEY_MAP[key];
  if (Array.isArray(value)) return value.map((v) => scrub(v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrub(v, k);
    return out;
  }
  return value;
}

const har = JSON.parse(fs.readFileSync(path.join(ROOT, harPath), 'utf8'));
const jjz = har.log.entries.filter((e) => isJjzRequestUrl(e.request.url));

function parseResponse(index) {
  return JSON.parse(jjz[index].response.content.text);
}

function parseRequest(index) {
  const text = jjz[index].request.postData?.text;
  return text ? JSON.parse(text) : null;
}

function write(name, data) {
  const file = path.join(OUT_DIR, `${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`  写入 ${path.relative(ROOT, file)}`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
console.log(`数据来源：${harPath}`);

// 办理前后的两份状态，用于验证自动办理的触发判断
write('stateList.initial', scrub(parseResponse(64)));
write('stateList.afterApply', scrub(parseResponse(0)));

// 优先使用最近一次真实查询作为主样本（同时含六环内与六环外记录）
const liveSample = path.join(os.tmpdir(), 'jjz_state_raw.json');
let mainSource = 'stateList.afterApply';
if (fs.existsSync(liveSample)) {
  try {
    write('stateList', scrub(JSON.parse(fs.readFileSync(liveSample, 'utf8'))));
    mainSource = '本地最近一次真实查询';
  } catch {
    /* 解析失败则退回抓包样本 */
  }
}
if (mainSource !== '本地最近一次真实查询') {
  fs.copyFileSync(path.join(OUT_DIR, 'stateList.afterApply.json'), path.join(OUT_DIR, 'stateList.json'));
  console.log('  写入 test/fixtures/stateList.json');
}

write('getJsrxx', scrub(parseResponse(34)));
write('applyVehicleCheck', scrub(parseResponse(48)));
write('applyCheckNum', scrub(parseResponse(32)));
write('checkHandle', scrub(parseResponse(28)));
write('checkInputRoadInfo', scrub(parseResponse(29)));
write('getConfigRecordInfo', scrub(parseResponse(63)));
write('insertApplyRecord', scrub(parseResponse(6)));
write('queryDic.jjmd', scrub(parseResponse(30)));
write('queryDic.qjxz', scrub(parseResponse(11)));
write('queryDic.jjlk', scrub(parseResponse(9)));

// 真实办理报文留作基准，P3 组装逻辑要与它逐字段对齐
write('insertApplyRecord.request', scrub(parseRequest(6)));

console.log(`完成。主样本来源：${mainSource}`);
