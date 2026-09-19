// 抓包分析辅助脚本：从 HAR 中提取进京证接口的请求 / 响应细节
//
// 用法：
//   node tools/har-inspect.js <har文件> list              列出相关接口调用
//   node tools/har-inspect.js <har文件> show <索引>        打印某条请求的完整内容
//   node tools/har-inspect.js <har文件> find <路径关键字>  按路径筛选后打印
import fs from 'node:fs';
import { isJjzRequestUrl } from '../src/endpoints.js';

const [, , harPath, cmd = 'list', arg] = process.argv;
if (!harPath) {
  console.error('用法: node tools/har-inspect.js <har文件> [list|show <索引>|find <关键字>]');
  process.exit(1);
}

const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
const jjz = har.log.entries.filter((e) => isJjzRequestUrl(e.request.url));

function bodyOf(entry) {
  const c = entry.response.content || {};
  if (!c.text) return '';
  if (c.encoding === 'base64') {
    const buf = Buffer.from(c.text, 'base64');
    return `<base64 ${buf.length} bytes, mime=${c.mimeType}>`;
  }
  return c.text;
}

function show(entry, index) {
  const url = new URL(entry.request.url);
  console.log('='.repeat(80));
  console.log(`[${index}] ${entry.startedDateTime} ${entry.request.method} ${url.pathname}${url.search}`);
  console.log('--- request headers ---');
  for (const h of entry.request.headers) console.log(`${h.name}: ${h.value}`);
  if (entry.request.postData) {
    console.log(`--- request body (${entry.request.postData.mimeType}) ---`);
    console.log(entry.request.postData.text);
  }
  console.log(`--- response ${entry.response.status} ${entry.response.statusText} ---`);
  console.log(bodyOf(entry));
}

if (cmd === 'list') {
  jjz.forEach((e, i) => {
    const url = new URL(e.request.url);
    const reqLen = ((e.request.postData && e.request.postData.text) || '').length;
    const respLen = ((e.response.content && e.response.content.text) || '').length;
    console.log(`${i} | ${e.startedDateTime} | ${e.request.method} | ${e.response.status} | ${url.pathname} | req=${reqLen}B resp=${respLen}B`);
  });
} else if (cmd === 'show') {
  const i = Number(arg);
  if (!Number.isInteger(i) || !jjz[i]) {
    console.error(`索引无效: ${arg}`);
    process.exit(1);
  }
  show(jjz[i], i);
} else if (cmd === 'find') {
  jjz.forEach((e, i) => {
    if (e.request.url.includes(arg)) show(e, i);
  });
}
