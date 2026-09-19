// 接口地址集中在本模块，且不以可直接检索的明文形式存放。
//
// 先说明清楚：这不是加密，也不构成安全边界。程序运行时必须知道真实地址，
// 所以任何能运行它的人——抓包、读进程内存、看 data/config.json——都能还原出来。
// 这里做的是让地址不出现在源码、README 和代码搜索结果里，挡掉「爬仓库拿地址」
// 这类顺手抓取。真正决定能否调用成功的仍然是 Authorization 凭证。
//
// 需要覆盖时（官方换域名，或你用的是自己抓的包）：
//   环境变量 JJZ_BASE_URL / JJZ_GEO_BASE_URL
//   或 data/config.json 的 settings.baseUrl

/** 解码后的结构：{ baseUrl, geoBase, ctrl, dic, cfgRec, auth, poi, geocode } */
const SPEC =
  'eyJiYXNlVXJsIjoiaHR0cHM6Ly9qanouanRnbC5iZWlqaW5nLmdvdi5jbjoyNDQzIiwiZ2VvQmFzZSI6Imh0dHBzOi8vd2ZjbC5qdGdsLmJlaWppbmcuZ292LmNuIiwiY3RybCI6Ii9wcm8vL2FwcGx5UmVjb3JkQ29udHJvbGxlci8iLCJkaWMiOiIvcHJvLy91Y0RpY0NvbnRyb2xsZXIvIiwiY2ZnUmVjIjoiL3Byby8vY29uZmlnUmVjb3JkQ29udHJvbGxlci8iLCJhdXRoIjoiL2F1dGgvL3VzZXJDb250cm9sbGVyLyIsInBvaSI6Ii9hcy9zZWFyY2gvcG9pIiwiZ2VvY29kZSI6Ii9nc3MvZ2VvY29kZS92MiJ9';

let decoded = null;

function spec() {
  if (!decoded) {
    try {
      decoded = JSON.parse(Buffer.from(SPEC, 'base64').toString('utf8'));
    } catch {
      decoded = {};
    }
  }
  return decoded;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** 交管业务接口基址。优先环境变量，其次内置值。 */
export function defaultBaseUrl() {
  return String(process.env.JJZ_BASE_URL || spec().baseUrl || '').replace(/\/+$/, '');
}

/** 地址搜索服务基址 */
export function geoBaseUrl() {
  return String(process.env.JJZ_GEO_BASE_URL || spec().geoBase || '').replace(/\/+$/, '');
}

/**
 * 按逻辑名取接口路径。
 * 用逻辑名调用，源码里就不会散落完整路径。
 */
const PATHS = {
  stateList: (s) => `${s.ctrl}stateList`,
  getJsrxx: (s) => `${s.ctrl}getJsrxx`,
  applyVehicleCheck: (s) => `${s.ctrl}applyVehicleCheck`,
  applyCheckNum: (s) => `${s.ctrl}applyCheckNum`,
  checkHandle: (s) => `${s.ctrl}checkHandle`,
  checkInputRoadInfo: (s) => `${s.ctrl}checkInputRoadInfo`,
  insertApplyRecord: (s) => `${s.ctrl}insertApplyRecord`,
  queryDic: (s) => `${s.dic}queryDic`,
  getConfigRecordInfo: (s) => `${s.cfgRec}getConfigRecordInfo`,
  getLoginType: (s) => `${s.auth}getLoginType`,
};

export function apiPath(name) {
  const build = PATHS[name];
  if (!build) throw new Error(`未知接口：${name}`);
  const value = build(spec());
  if (!value) throw new Error(`接口路径未配置：${name}`);
  return value;
}

/** 地址搜索 / 逆地理编码路径 */
export function geoPath(name) {
  const s = spec();
  if (name === 'poiSearch') return s.poi;
  if (name === 'reverseGeocode') return s.geocode;
  throw new Error(`未知地理接口：${name}`);
}

/** 判断一条抓包记录是否属于交管接口，供 tools/ 下的分析脚本使用 */
export function isJjzRequestUrl(url) {
  const host = hostOf(defaultBaseUrl());
  return Boolean(host) && String(url).includes(host);
}
