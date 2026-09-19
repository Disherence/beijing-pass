# 进京证管理平台

自用的进京证（外埠车辆进京通行证）管理台：**多凭证集中查询**、车辆证件看板，以及**六环外证件到期自动办理**。

浏览器无法直连交管接口（跨域限制，且凭证会暴露在前端），所以这里是一个本地服务：后端代理官方接口并保管凭证，前端只与本机服务通信。全部用 Node 内置模块实现，**零第三方依赖**，`node server.js` 就能跑。

> 个人自用工具。需要你自己抓包取得 `Authorization`，请遵守相关法律法规，仅用于本人名下车辆。

## 功能

| 页面 | 内容 |
| --- | --- |
| 仪表盘 | 名下所有车辆与证件状态、有效期倒计时、年度次数、办证印章图、原始报文回看 |
| 定时任务 | 每辆车独立的自动办理开关、办理时间、错过补办，以及提交/回查记录 |
| 用户管理 | 粘贴 Authorization 自动解析身份与车辆；办理参数表单（支持按地点名搜索自动填地址与经纬度）；Server酱通知配置 |

其他：

- 网页打开即刷新，之后每 60 秒自动轮询；切到后台标签页暂停，回到前台立刻补一次
- 所有查询结果落盘快照，服务重启后仪表盘不会空白
- 办理成功、审核未通过、结果未确认、提交失败都会推送通知

## 快速开始

需要 Node.js 20 或更高版本。

```bash
node server.js                 # 启动，默认端口 3000，数据目录 ./data
node server.js --port=8080     # 换端口
node server.js --data=/var/lib/jjz   # 换数据目录
node server.js --mock          # 用内置脱敏样本运行，完全不请求真实接口
```

打开 `http://127.0.0.1:3000`，把抓包得到的 `Authorization`（请求头里的那串 UUID）粘进「用户管理 → 添加用户」即可。服务默认监听所有网卡，局域网内其他设备可直接访问。

## 目录结构

```
server.js              HTTP 服务、API 路由、静态资源托管
src/
  jjz.js               交管接口客户端：鉴权、串行限流、TTL 缓存、错误归一化
  scheduler.js         自动办理调度器：触发判断、前置校验、提交、结果回查
  apply.js             办理报文组装（与真实抓包逐字段对齐）
  normalize.js         接口原始响应 → 界面视图模型
  store.js             JSON 持久化（原子写、历史轮转、快照恢复）
  notify.js            通知适配层（当前实现 Server酱）
  geo.js               地址搜索与逆地理编码（办理参数表单用）
  validate.js          接口入参校验白名单
  date.js              北京时间日期工具（不依赖容器/主机时区）
public/                前端页面（原生 HTML/CSS/JS，无构建步骤）
deploy/                systemd 服务定义
tools/                 抓包分析、样本生成、冒烟测试、部署脚本
test/                  调度器回归测试 + 脱敏样本
data/                  运行时数据（凭证、快照、历史），已被 .gitignore 排除
```

## 数据与配置

运行时数据都在 `data/` 目录，权限为 `600`（仅属主可读写），**不会提交到仓库**：

| 文件 | 内容 |
| --- | --- |
| `config.json` | 全局设置、用户凭证、办理参数、车辆自动办理规则 |
| `state.json` | 最近一次查询快照，重启后仪表盘靠它恢复 |
| `history.jsonl` | 查询快照与办理事件，超过 5MB 自动轮转为 `history.jsonl.1` |

全局设置可以在页面的「设置」里改，也可以在 `config.json` 里直接编辑：

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `baseUrl` | 空（用内置地址） | 接口地址。留空即用程序内置地址；需要覆盖时填这里，或设置环境变量 `JJZ_BASE_URL` |
| `cacheTtlSec` | `300` | 查询缓存时长，**决定请求官方接口的频率下限** |
| `viewRefreshSec` | `300` | 页面快照超过这个时长才回源 |
| `minIntervalMs` | `1200` | 两次请求官方接口之间的最小间隔 |
| `scheduler.tickSec` | `60` | 调度器检查间隔 |

## 自动办理

**只自动办理六环外证件。** 触发条件有两个：

1. 当前六环外证件的**最后一天**到达你设定的时间（例如 6.10–6.16 的证，在 6.16 当天办）
2. 六环外证件**已过期或不存在**时补办一张，避免某天服务停机导致断档

提交不可撤销，所以流程设计为「宁可漏办，不可错办」：

```
到点（当天只评估一次）
 └─ 拉实时状态（绕过缓存）
     ├─ 已有待生效证件 / 证件还有效 → 跳过
     └─ 需要办理 → 前置校验链
           applyVehicleCheck → getJsrxx → applyCheckNum
           → checkHandle（取生效日期）→ checkInputRoadInfo
           → 提交前最后一次实时确认，并用这份数据组装报文
           → insertApplyRecord
           → 登记回查 → 通知
```

几条保护：

- 同一个到期窗口只提交一次（幂等键 `车辆:el:到期日`）
- 提交失败后按 20 分钟间隔重试，每天最多 3 次
- 提交请求报错时会立刻回查状态，确认是否其实已被受理，避免重复提交
- 办理参数不完整时直接中止并通知，不会带着残缺参数提交
- 办理报文与真实抓包逐字段对齐，测试里有断言（34 个字段，集合与顺序都校验）

### 结果回查与通知

提交后每 10 分钟回查一次，最多 6 次（约一小时的观察窗口）。判定「办成」需要**同时**满足：

- 新证有效期覆盖到提交日之后 —— 否则可能拿到今天到期的旧证
- 状态码属于审核通过 —— 否则会把仍在「审核中」的申请误判成办成

| 情况 | 推送内容 |
| --- | --- |
| 提交成功 | 「已提交」，让你知道自动办理确实跑了 |
| 审核通过 | 「办理成功」，附有效期与证号；每个续办周期只推一次 |
| 审核通过后被改判为未通过 | 「被改判为未通过」，并说明以本条为准 |
| 审核未通过 | 失败原因与到期日 |
| 回查一小时仍未见审核通过 | 「结果未确认」，提示手动确认 |
| 提交失败 | 失败原因与剩余重试次数 |

## 网页刷新与请求频率

网页打开时立即刷新一次，之后每 60 秒轮询一次。**页面刷新不等于请求官方接口**，两者是分开的：

```
浏览器 60s 轮询  →  /api/dashboard  →  只读后端快照（不联网）
                         └─ 快照超过 viewRefreshSec → 后台异步回源
                                └─ 客户端缓存未过期 → 直接复用，仍不联网
```

`cacheTtlSec` 是上游调用次数的最终兜底，页面轮询、手动刷新、定时任务都无法击穿它。因此页面一直开着也不会把接口打爆。

## 接口地址说明

**接口地址不写在源码里。** 全部集中在 `src/endpoints.js`，以编码形式存放，源码与文档中都不出现完整 URL；代码里按逻辑名调用（`apiPath('stateList')`、`apiPath('checkHandle')` 等），路径由该模块在运行时拼装。

这样做的目的是：仓库被爬取或做代码搜索时，拿不到可以直接使用的地址，减少被批量恶意调用的可能。**但这不等同于加密**——程序运行时必须知道真实地址，任何能运行它的人都能通过抓包或读配置还原。真正的访问控制仍然在凭证上：没有有效的 `Authorization`，请求不会成功。

需要覆盖地址时（官方换了域名，或你想用自己的抓包结果）：

```bash
export JJZ_BASE_URL=https://<你的抓包域名>
export JJZ_GEO_BASE_URL=https://<地址搜索服务域名>
```

或者直接改 `data/config.json` 里的 `settings.baseUrl`。页面上的「设置」不提供这一项，普通使用者看不到也改不了。

### 几个必须记住的坑

- **鉴权失败时 HTTP 仍是 200**，业务码在响应体的 `code` 字段（401 = 令牌失效）。判断成败只能看 `code`。
- 车辆对象里待生效记录的字段名是六个字母 `e c b z x x`，其中 `b` 在 `z` 前面。这个顺序极易看错，写反会静默丢数据；代码里统一引用 `src/normalize.js` 导出的 `PENDING_RECORDS` 常量，不要在别处手打。
- 空数组时接口会**直接省略整个字段**，解析必须容错。
- `bzxx[]` 是已通过的证件记录，待生效记录在另一个字段里，两者都可能含六环内或六环外，**要按 `jjzzl` 分组，不能按数组名判断**。
- 办证有效期固定 7 天；六环内全年 12 次、六环外不限次数；办证日期必须取自 `/checkHandle` 返回的 `jjrqs`。
- 办理报文的字段与其他开源实现不同，以实际抓包为准。

## 部署

### systemd

仓库里带了 `deploy/beijing-pass.service`，改好路径后：

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin jjz
mkdir -p /opt/beijing-pass/data && chown -R jjz:jjz /opt/beijing-pass
cp deploy/beijing-pass.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now beijing-pass
journalctl -u beijing-pass -f
```

### 容器

本地构建与运行：

```bash
docker build -t beijing-pass .
docker run -d --name beijing-pass -p 3000:3000 \
  -v /path/to/data:/app/data \
  -e TZ=Asia/Shanghai \
  beijing-pass
```

凭证与快照都写在挂载出来的 `/app/data` 里，容器重建不丢。应用内部按北京时间计算日期，`TZ` 只影响日志可读性。

### 用 GitHub 构建镜像

推送到 `main` 或打 `v*` 标签时，`.github/workflows/ci.yml` 会自动：

1. 跑调度器回归测试与接口冒烟测试（mock 模式，不请求真实接口）
2. 构建镜像，导出为工作流产物 `beijing-pass-image`（可直接 `docker load`）
3. 尝试推送到 GHCR：`ghcr.io/disherence/beijing-pass`

第 3 步是尽力而为。如果日志里出现「推送失败，请检查仓库的 Packages 权限设置」的 warning，说明当前账号的包命名空间策略不允许 `GITHUB_TOKEN` 写入，此时用产物部署即可：

```bash
# 从该次运行的 Artifacts 下载 beijing-pass-image.tar.gz
docker load < beijing-pass-image.tar.gz
docker run -d --name beijing-pass -p 3000:3000 \
  -v /path/to/data:/app/data \
  ghcr.io/disherence/beijing-pass:main
```

想启用 GHCR 推送，需要在 GitHub 上确认：仓库 `Settings → Actions → General → Workflow permissions` 允许读写，以及账号层面允许 Actions 创建包。

## 开发与测试

```bash
node test/scheduler.test.mjs   # 调度器回归测试（离线假客户端，无需网络）
bash tools/smoke.sh 3113       # 冒烟测试：以 mock 模式起服务，逐项校验接口
```

抓包分析辅助：

```bash
node tools/har-inspect.js <har文件> list        # 列出进京证相关请求
node tools/har-inspect.js <har文件> show 6      # 打印某条请求的完整内容
node tools/make-fixture.js <har文件>            # 从抓包生成脱敏测试样本
```

## 安全须知

- 抓包文件（`*.har`）和 `data/` 已在 `.gitignore` 中排除。抓包文件含身份证、手机号、车牌、住址与 Authorization，**绝对不要提交**。
- `Authorization` 等同于身份凭证，明文存放在 `data/config.json`（权限 600）。不要把该目录同步到网盘或云端。
- 本项目按「局域网内默认可信」设计，不带登录鉴权。**不要直接暴露到公网**，需要外网访问请自行加反向代理与认证。
- 接口地址被限制为 `https` + `beijing.gov.cn` 域名，避免凭证被改到其他主机。
- `src/geo.js` 中的高德 key 来自官方 H5 页面（浏览器网络面板可见），仅用于地址搜索。如失效可设置环境变量 `AMAP_AK` 换成自己的。

## 免责声明

本项目为个人自用工具，通过公开网页接口完成查询与办理，与任何官方机构无关。使用前请确认符合相关法律法规与平台规则；因使用本项目产生的任何后果由使用者自行承担。办理申请提交后官方不支持撤销，请务必确认办理参数无误后再开启自动办理。
