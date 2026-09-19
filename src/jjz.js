// 北京交管进京证接口客户端
// 只负责协议层：鉴权头、限流、缓存、错误归一化。业务判断放在调用方。
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { apiPath, defaultBaseUrl } from './endpoints.js';

/** 业务码非 200 时抛出，便于上层区分「凭证失效」和「其他失败」 */
export class JjzError extends Error {
  constructor(message, { code, msg, path: reqPath, body } = {}) {
    super(message);
    this.name = 'JjzError';
    this.bizCode = code;
    this.bizMsg = msg;
    this.reqPath = reqPath;
    this.body = body;
  }

  get isAuthFailure() {
    return this.bizCode === 401;
  }
}

/** 只读接口才允许命中缓存，写接口永远直连 */
const READ_OPS = new Set([
  'stateList',
  'getJsrxx',
  'checkHandle',
  'checkInputRoadInfo',
  'applyVehicleCheck',
  'queryDic',
  'getConfigRecordInfo',
  'getLoginType',
]);

/** mock 模式下把逻辑名映射到样本文件 */
const MOCK_FILES = {
  stateList: 'stateList',
  getJsrxx: 'getJsrxx',
  checkHandle: 'checkHandle',
  checkInputRoadInfo: 'checkInputRoadInfo',
  applyVehicleCheck: 'applyVehicleCheck',
  applyCheckNum: 'applyCheckNum',
  insertApplyRecord: 'insertApplyRecord',
  getConfigRecordInfo: 'getConfigRecordInfo',
  queryDic: 'queryDic',
};

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export class JjzClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || defaultBaseUrl();
    this.timeoutMs = options.timeoutMs ?? 25000;
    this.minIntervalMs = options.minIntervalMs ?? 1200;
    this.cacheTtlMs = options.cacheTtlMs ?? 300000;
    this.insecureTLS = Boolean(options.insecureTLS);
    this.mockDir = options.mockDir || null;

    this.cache = new Map();
    this.queue = Promise.resolve();
    this.lastRequestAt = 0;
    this.stats = { requests: 0, cacheHits: 0, failures: 0 };
    this.agent = new https.Agent({ keepAlive: true, rejectUnauthorized: !this.insecureTLS });
  }

  /** 串行化 + 最小间隔，避免多用户并发时把接口打爆 */
  #schedule(task) {
    const run = this.queue.then(async () => {
      const wait = this.minIntervalMs - (Date.now() - this.lastRequestAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastRequestAt = Date.now();
      return task();
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * @param {string} op 逻辑接口名（见 endpoints.js 的 PATHS），源码里不出现完整路径
   */
  async post(op, { token, body = {}, cache = false } = {}) {
    const cacheKey = `${token}:${op}:${canonicalJson(body)}`;
    if (cache && READ_OPS.has(op)) {
      const hit = this.cache.get(cacheKey);
      if (hit && hit.expiresAt > Date.now()) {
        this.stats.cacheHits += 1;
        return { ...hit.envelope, cached: true, cachedAt: hit.cachedAt };
      }
    }

    const envelope = this.mockDir
      ? await this.#mock(op, body)
      : await this.#schedule(() => this.#request(op, token, body));

    if (cache && READ_OPS.has(op) && envelope.code === 200) {
      const cachedAt = Date.now();
      this.cache.set(cacheKey, { envelope, expiresAt: cachedAt + this.cacheTtlMs, cachedAt });
    }
    return envelope;
  }

  /** 凭证是否有效：只请求一个轻量只读接口判断 */
  stateList(token, { cache = true } = {}) {
    return this.post('stateList', { token, body: {}, cache });
  }

  getJsrxx(token, { cache = true } = {}) {
    return this.post('getJsrxx', { token, body: {}, cache });
  }

  applyVehicleCheck(token, { hphm, hpzl }) {
    return this.post('applyVehicleCheck', { token, body: { hphm, hpzl } });
  }

  applyCheckNum(token, { jsrxm, jszh, dabh = '', txrxx = [], txrkg = '0', wtxr = '' }) {
    return this.post('applyCheckNum', {
      token,
      body: { jsrxm, jszh, dabh, txrxx, txrkg, wtxr },
    });
  }

  checkHandle(token, { vId, jjzzl, hphm }, { cache = true } = {}) {
    return this.post('checkHandle', { token, body: { vId, jjzzl, hphm }, cache });
  }

  checkInputRoadInfo(token, { vId }, { cache = true } = {}) {
    return this.post('checkInputRoadInfo', { token, body: { vId }, cache });
  }

  /** 提交办理。不可撤销，调用前必须自行完成全部前置校验。 */
  insertApplyRecord(token, payload) {
    return this.post('insertApplyRecord', { token, body: payload });
  }

  queryDic(token, { type, vId }, { cache = true } = {}) {
    const body = vId ? { type, vId } : { type };
    return this.post('queryDic', { token, body, cache });
  }

  getConfigRecordInfo(token, { cache = true } = {}) {
    return this.post('getConfigRecordInfo', { token, body: {}, cache });
  }

  getLoginType(token) {
    return this.post('getLoginType', { token, body: {}, cache: true });
  }

  clearCache() {
    this.cache.clear();
  }

  #mock(op, body) {
    const file = MOCK_FILES[op];
    if (!file) throw new JjzError(`mock 模式未覆盖接口 ${op}`, { path: op });
    let target = path.join(this.mockDir, `${file}.json`);
    if (op === 'queryDic') target = path.join(this.mockDir, `queryDic.${body.type}.json`);
    if (!fs.existsSync(target)) throw new JjzError(`mock 文件缺失 ${target}`, { path: op });
    this.stats.requests += 1;
    return Promise.resolve(JSON.parse(fs.readFileSync(target, 'utf8')));
  }

  #request(op, token, body) {
    const reqPath = apiPath(op);
    return new Promise((resolve, reject) => {
      const url = new URL(reqPath, this.baseUrl);
      const payload = Buffer.from(JSON.stringify(body), 'utf8');
      const headers = {
        'Content-Type': 'application/json',
        Accept: '*/*',
        'Content-Length': payload.length,
      };
      if (token) headers.Authorization = token;

      const req = https.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers,
          agent: this.agent,
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json;
            try {
              json = JSON.parse(text);
            } catch {
              this.stats.failures += 1;
              reject(new JjzError(`接口返回非 JSON（HTTP ${res.statusCode}）`, { path: reqPath, body: text.slice(0, 500) }));
              return;
            }
            if (json.code !== 200) {
              this.stats.failures += 1;
              reject(new JjzError(json.msg || `业务码 ${json.code}`, { code: json.code, msg: json.msg, path: reqPath, body: json }));
              return;
            }
            resolve(json);
          });
        },
      );

      this.stats.requests += 1;
      req.on('timeout', () => req.destroy(new JjzError('请求超时', { path: reqPath })));
      req.on('error', (err) => {
        this.stats.failures += 1;
        reject(err instanceof JjzError ? err : new JjzError(`网络错误：${err.message}`, { path: reqPath }));
      });
      req.end(payload);
    });
  }
}
