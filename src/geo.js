// 地址搜索：复用交管 H5 使用的高德 POI 接口（公开 ak，无需鉴权）
// 用于办理参数表单——用户只输入地点名，区县/详细地址/经纬度自动填好
import https from 'node:https';
import { geoBaseUrl, geoPath } from './endpoints.js';

// 这是官方 H5 页面里公开使用的高德 key（浏览器开发者工具的网络面板即可看到），
// 只用于「输入地点名 → 自动填地址与经纬度」这一个便利功能。
// 如果它哪天被限流或失效，设置环境变量 AMAP_AK 换成自己的 key 即可。
const AK = process.env.AMAP_AK || '907cd02062c34d8b9e2cabc2f4f5cab8';
function getJson(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request(
      {
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: { Accept: 'application/json' },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error(`地址服务返回异常（HTTP ${res.statusCode}）`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('地址搜索超时')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * 按关键字搜索地点
 * 返回 [{ name, address, district, lng, lat }]
 */
export async function searchPoi(keyword) {
  const params = new URLSearchParams({
    query: keyword,
    scope: '1',
    region: '北京市',
    page_size: '10',
    page_num: '1',
    ak: AK,
  });
  const json = await getJson(`${geoBaseUrl()}${geoPath('poiSearch')}?${params}`);
  if (json.status !== '0') throw new Error(json.message || '地址搜索失败');
  return (json.results || [])
    .filter((r) => r.location?.lng && r.location?.lat)
    .map((r) => ({
      name: r.name,
      address: r.address || '',
      // 官方 H5 提交的详细地址就是「地址 + 名称」拼接
      full: `${r.address || ''}${r.name || ''}`,
      lng: r.location.lng,
      lat: r.location.lat,
      type: r.type || '',
    }));
}

/**
 * 逆地理编码：由经纬度反查区县。
 * 办理报文的 area 字段就是区县名（如「顺义区」），POI 搜索结果里没有，只能反查。
 */
export async function reverseGeocode(lng, lat) {
  const params = new URLSearchParams({ location: `${lng},${lat}`, ak: AK });
  const json = await getJson(`${geoBaseUrl()}${geoPath('reverseGeocode')}?${params}`);
  const first = json.result?.[0];
  if (!first) throw new Error('未能解析该坐标所属区县');
  return {
    district: first.addressComponent?.district || '',
    street: first.addressComponent?.street || '',
    formatted: first.formatted_address || '',
  };
}
