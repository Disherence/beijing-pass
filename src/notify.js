// 通知适配层。目前实现 Server酱，后续要加企微/钉钉只需在此扩展。
import https from 'node:https';

function postForm(url, form, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(new URLSearchParams(form).toString(), 'utf8');
    const target = new URL(url);
    const req = https.request(
      {
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
          'Content-Length': payload.length,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode, json: JSON.parse(text) });
          } catch {
            reject(new Error(`通知接口返回非 JSON（HTTP ${res.statusCode}）：${text.slice(0, 200)}`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('通知请求超时')));
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * Server酱推送
 * @param {string} sendKey SendKey，形如 SCTxxxxx
 * @param {{title: string, desp?: string}} message
 */
export async function sendServerChan(sendKey, { title, desp = '' }) {
  if (!sendKey) throw new Error('未配置 Server酱 SendKey');
  const { json } = await postForm(`https://sctapi.ftqq.com/${encodeURIComponent(sendKey)}.send`, {
    title,
    desp,
  });
  // Server酱成功返回 code=0
  if (json?.code !== 0) {
    throw new Error(json?.message || `Server酱返回 code=${json?.code}`);
  }
  return json.data || {};
}

export function isNotifyConfigured(user) {
  const cfg = user?.notify?.serverchan;
  return Boolean(cfg?.enabled && cfg?.sendKey);
}

/** 统一的推送入口：未配置时静默跳过，不打断主流程 */
export async function notifyUser(user, { title, desp }) {
  if (!isNotifyConfigured(user)) return { skipped: true, reason: '未配置通知' };
  try {
    await sendServerChan(user.notify.serverchan.sendKey, { title, desp });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
