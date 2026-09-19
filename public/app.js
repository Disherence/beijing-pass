const $ = (sel) => document.querySelector(sel);

/** 页面轮询间隔：需求固定为 1 分钟 */
const POLL_MS = 60000;
/** 后台正在回源时缩短间隔，以便尽快取到新数据 */
const POLL_FAST_MS = 10000;

const JJMD_NAME = { '01': '自驾旅游', '02': '看病就医', '03': '探亲访友', '04': '学习培训', '05': '公务差旅', '06': '其它' };

let pollTimer = null;
let tickTimer = null;
let nextPollAt = 0;
let autoRefresh = true;
let today = '';
let busy = false;
let currentView = 'dashboard';
let editing = { userId: null, vehicleId: null, owner: '' };

// ---------- 基础工具 ----------

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `请求失败（HTTP ${res.status}）`);
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function relTime(ts) {
  if (!ts) return '尚无数据';
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec} 秒前`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  return `${Math.floor(sec / 3600)} 小时前`;
}

function pretty(dateStr) {
  if (!dateStr) return '';
  const [, m, d] = dateStr.split('-');
  return `${Number(m)}月${Number(d)}日`;
}

function showError(el, message) {
  if (!el) return;
  if (!message) {
    el.hidden = true;
    return;
  }
  el.textContent = message;
  el.hidden = false;
}

// ---------- 仪表盘 ----------

function permitBlock(title, permit) {
  if (!permit.current) {
    return `<div class="permit none"><div><div class="label">${title}</div><div class="val">未办理</div></div></div>`;
  }
  const c = permit.current;
  const cls = c.isActive ? 'active' : 'pending';
  const days = c.remainingDays;
  // 未生效的证不显示「剩余天数」，那会让人误以为已经在用
  const pendingStart = c.validFrom && today && c.validFrom > today;
  let daysCls = '';
  let daysText = '';
  if (pendingStart) {
    daysText = `${pretty(c.validFrom)}生效`;
  } else if (days !== null && days !== undefined) {
    daysCls = days < 0 ? 'expired' : days <= 1 ? 'warn' : 'ok';
    daysText = days < 0 ? `已过期 ${Math.abs(days)} 天` : days === 0 ? '今天到期' : `剩余 ${days} 天`;
  }
  return `
    <div class="permit ${cls}">
      <div>
        <div class="label">${title} · ${esc(c.status || '')}</div>
        <div class="val">${esc(c.validFrom)} ~ ${esc(c.validTo)}</div>
        <div class="label">证号 ${esc(c.permitNo || '-')}　申请于 ${esc((c.appliedAt || '').slice(0, 16))}</div>
        ${c.rejectReason ? `<div class="label">原因：${esc(c.rejectReason)}</div>` : ''}
      </div>
      <div class="days ${daysCls}">${daysText}</div>
    </div>`;
}

/**
 * 年度办证次数：已办 / 总数，一行文字即可。
 * 这个 12 是六环内的年度额度（六环外不限次数），所以标题不写环数，
 * 避免被当成六环外的限制。
 */
function quotaBlock(counters) {
  const total = (counters.ylUsed ?? 0) + (counters.ylLeft ?? 0);
  if (!total) return '';
  const low = (counters.ylLeft ?? 0) <= 3;
  return `<div class="quota ${low ? 'low' : ''}">
      <span>年度次数</span><b>${counters.ylUsed ?? '-'} / ${total} 次</b>
    </div>`;
}

function vehicleCard(vehicle) {
  const stamp = vehicle.yl.current?.stampImage || vehicle.el.current?.stampImage;
  const live = vehicle.yl.current?.isActive || vehicle.el.current?.isActive;
  const todo = vehicle.yl.lastDay || vehicle.el.lastDay;
  const c = vehicle.counters;
  return `
    <div class="vehicle">
      <div class="vehicle-head">
        <div>
          <div class="plate">${esc(vehicle.plate)}</div>
          <div class="user-meta">车辆编号 ${esc(vehicle.vId)}</div>
        </div>
        ${stamp ? `<img class="stamp" src="${stamp}" alt="办证成功" />` : ''}
      </div>
      <div class="permits">
        ${permitBlock('六环内', vehicle.yl)}
        ${permitBlock('六环外', vehicle.el)}
      </div>
      ${quotaBlock(c)}
      <div class="vehicle-foot">
        ${live ? '<span class="tag live">生效中</span>' : ''}
        ${todo ? '<span class="tag todo">今天可续办</span>' : ''}
      </div>
      ${vehicle.rules.el || vehicle.rules.yl
        ? `<div class="rule"><details><summary>官方办理规则</summary>
             ${vehicle.rules.yl ? `<div>六环内：${esc(vehicle.rules.yl)}</div>` : ''}
             ${vehicle.rules.el ? `<div>六环外：${esc(vehicle.rules.el)}</div>` : ''}
           </details></div>`
        : ''}
    </div>`;
}

function dashboardUserCard(user) {
  const vehicles = user.state?.vehicles || [];
  const age = user.snapshotFetchedAt ? Date.now() - user.snapshotFetchedAt : null;
  const stale = age === null || age > 10 * 60 * 1000;
  return `
    <section class="user">
      <div class="user-head">
        <div>
          <div class="user-name">${esc(user.profile?.name || user.note || '未命名用户')}</div>
          <div class="user-meta">
            身份证 ${esc(user.profile?.idCardMasked || '-')}　凭证 ${esc(user.tokenMasked)}
          </div>
          <div class="fresh ${stale ? 'stale' : ''}">
            ${user.refreshing ? '<span class="spinner"></span>正在从官方接口更新…' : `数据 ${esc(relTime(user.snapshotFetchedAt))}更新`}
          </div>
        </div>
        <div class="user-actions">
          <button class="btn tiny" data-act="refresh" data-id="${user.id}">刷新</button>
        </div>
      </div>
      ${user.lastError ? `<div class="banner err">最近一次查询失败：${esc(user.lastError)}</div>` : ''}
      <div class="vehicles">
        ${vehicles.length ? vehicles.map(vehicleCard).join('') : '<div class="user-meta">该凭证下暂无车辆信息</div>'}
      </div>
    </section>`;
}

function renderSummary(s) {
  $('#summary').innerHTML = `
    <div class="cell"><b>${s.users}</b><span>用户</span></div>
    <div class="cell"><b>${s.vehicles}</b><span>车辆</span></div>
    <div class="cell"><b>${s.active}</b><span>证件生效中</span></div>
    <div class="cell"><b>${s.expiring}</b><span>即将到期</span></div>
    <div class="cell"><b>${s.error}</b><span>凭证异常</span></div>`;
}

// ---------- 定时任务 ----------

function autoStatus(auto) {
  if (!auto.enabled) return '<span class="tag">未开启</span>';
  if (!auto.warnAck) return '<span class="tag todo">待确认提示</span>';
  return `<span class="tag live">每天 ${esc(auto.time)}</span>`;
}

function taskRow(t) {
  const permit = t.permit
    ? `${esc(t.permit.validFrom)} ~ ${esc(t.permit.validTo)}`
    : '无六环外证件';
  return `
    <div class="task-row">
      <div class="task-main">
        <div class="plate">${esc(t.plate)} ${autoStatus(t.auto)}</div>
        <div class="user-meta">${esc(t.owner)}　六环外：${permit}</div>
        <div class="user-meta">
          ${t.auto.enabled && t.nextTrigger ? `下次触发 <b>${esc(t.nextTrigger)}</b>` : '未开启自动办理'}
          ${t.auto.lastResult ? `　上次：${esc(t.auto.lastResult)}` : ''}
          ${t.auto.lastRunAt ? `　执行于 ${esc(t.auto.lastRunAt)}` : ''}
        </div>
        ${!t.paramsReady || !t.notifyReady
          ? `<div class="user-meta warn-text">${!t.paramsReady ? '⚠️ 办理参数未填写完整　' : ''}${!t.notifyReady ? '⚠️ 未配置通知' : ''}</div>`
          : ''}
      </div>
      <div class="task-actions">
        <button class="btn tiny" data-act="edit-task" data-uid="${t.userId}" data-vid="${t.vehicleId}" data-plate="${esc(t.plate)}">设置</button>
      </div>
    </div>`;
}

function runRow(r) {
  const badge = { submit: 'live', confirm: 'live', fail: 'todo' }[r.kind] || '';
  return `<div class="run-row">
    <span class="tag ${badge}">${esc({ submit: '提交', confirm: '回查', fail: '失败' }[r.kind] || r.kind)}</span>
    <span class="run-plate">${esc(r.plate || '')}</span>
    <span class="run-msg">${esc(r.message || '')}</span>
    <span class="user-meta">${esc(r.at || '')}</span>
  </div>`;
}

function renderTasks(data) {
  $('#scheduler-bar').innerHTML = `
    <div class="bar">
      <div>
        <b>调度器${data.scheduler.enabled ? '运行中' : '已停用'}</b>
        <span class="user-meta">每 ${data.scheduler.tickSec} 秒检查一次　上次检查 ${esc(data.scheduler.lastTickAt || '尚未运行')}</span>
      </div>
      <button class="btn tiny" id="tick-now">立即检查</button>
    </div>`;
  $('#tasks').innerHTML = data.tasks.length
    ? data.tasks.map(taskRow).join('')
    : '<p class="hint">还没有车辆。请先在「用户管理」添加凭证。</p>';

  const rows = data.scheduler.history || [];
  $('#runs').innerHTML = rows.length
    ? rows.map((r) => runRow({ ...r, kind: r.kind || r.type })).join('')
    : '<p class="hint">暂无执行记录。到证件最后一天并到达设定时间后，这里会显示提交与回查结果。</p>';
}

// ---------- 用户管理 ----------

function adminUserCard(u) {
  const params = u.applyParams || {};
  const filled = ['area', 'xxdz', 'jjdzgdjd', 'jjdzgdwd', 'zjxxdz', 'zjxxdzgdjd', 'zjxxdzgdwd', 'sqdzgdjd', 'sqdzgdwd', 'jjmd', 'jjmdmc'].filter(
    (k) => params[k],
  ).length;
  const notify = u.notify?.serverchan || {};
  return `
    <section class="user">
      <div class="user-head">
        <div>
          <div class="user-name">${esc(u.profile?.name || '未命名用户')}${u.enabled ? '' : ' <span class="tag">已停用</span>'}</div>
          <div class="user-meta">身份证 ${esc(u.profile?.idCardMasked || '-')}　凭证 ${esc(u.tokenMasked)}${u.note ? `　备注 ${esc(u.note)}` : ''}</div>
          <div class="user-meta">车辆：${u.vehicles?.filter((v) => v.active !== false).map((v) => esc(v.plate)).join('、') || '无'}</div>
          <div class="user-meta">
            办理参数 ${filled}/11 ${filled === 11 ? '✅' : '⚠️'}　
            通知 ${notify.enabled && notify.sendKey ? '✅ Server酱' : '未配置'}
          </div>
        </div>
        <div class="user-actions">
          <button class="btn tiny" data-act="params" data-id="${u.id}">办理参数</button>
          <button class="btn tiny" data-act="notify" data-id="${u.id}">通知设置</button>
          <button class="btn tiny" data-act="notify-test" data-id="${u.id}">测试通知</button>
          <button class="btn tiny" data-act="refresh" data-id="${u.id}">刷新</button>
          <button class="btn tiny" data-act="raw" data-id="${u.id}">原始响应</button>
          <button class="btn tiny danger" data-act="delete" data-id="${u.id}">删除</button>
        </div>
      </div>
    </section>`;
}

// ---------- 视图切换与轮询 ----------

async function loadDashboard() {
  const data = await api('/api/dashboard');
  today = data.today || today;
  renderSummary(data.summary);
  $('#users').innerHTML = data.users.map(dashboardUserCard).join('');
  $('#subtitle').textContent = `共 ${data.summary.users} 个凭证 · ${data.summary.vehicles} 辆车`;
  return data;
}

async function loadTasks() {
  const data = await api('/api/tasks');
  renderTasks(data);
  const on = data.tasks.filter((t) => t.auto.enabled).length;
  $('#subtitle').textContent = `${data.tasks.length} 辆车 · ${on} 辆开启自动办理`;
  return data;
}

async function loadUserAdmin() {
  const { users } = await api('/api/users');
  $('#user-admin').innerHTML = users.length
    ? users.map(adminUserCard).join('')
    : '<p class="hint">还没有添加任何凭证。</p>';
  $('#subtitle').textContent = `共 ${users.length} 个凭证`;
  return users;
}

async function loadCurrent() {
  if (currentView === 'dashboard') return loadDashboard();
  if (currentView === 'tasks') return loadTasks();
  return loadUserAdmin();
}

function showView(name) {
  currentView = name;
  for (const el of document.querySelectorAll('.view')) el.hidden = el.id !== `view-${name}`;
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.view === name);
  location.hash = name;
  return loadCurrent();
}

// 支持浏览器前进/后退与直接改 hash 切页（showView 会写 hash，用当前视图判断避免循环）
window.addEventListener('hashchange', () => {
  const next = (location.hash || '#dashboard').slice(1);
  if (next !== currentView && ['dashboard', 'tasks', 'users'].includes(next)) {
    showView(next).catch((err) => alert(err.message));
  }
});

/** 轮询：命中后台正在回源时缩短间隔，尽快取到新快照 */
function schedulePoll(hasRefreshing) {
  clearTimeout(pollTimer);
  if (!autoRefresh || document.hidden) return;
  const delay = hasRefreshing ? POLL_FAST_MS : POLL_MS;
  nextPollAt = Date.now() + delay;
  pollTimer = setTimeout(async () => {
    try {
      const data = await loadCurrent();
      schedulePoll(Boolean(data?.summary?.refreshing || data?.running));
    } catch {
      schedulePoll(false);
    }
  }, delay);
}

function tickCountdown() {
  const el = $('#refresh-countdown');
  if (!el) return;
  if (!autoRefresh) {
    el.textContent = '已暂停';
    return;
  }
  if (document.hidden) {
    el.textContent = '后台';
    return;
  }
  el.textContent = `${Math.max(0, Math.ceil((nextPollAt - Date.now()) / 1000))}s`;
}

async function refreshNow({ click = false } = {}) {
  if (busy) return;
  busy = true;
  const btn = $('#refresh-all');
  if (click) {
    btn.disabled = true;
    btn.textContent = '刷新中…';
  }
  try {
    // 手动刷新才强制回源，自动轮询一律读快照
    if (click) {
      const { users } = await api('/api/users');
      for (const u of users) {
        await api(`/api/users/${u.id}/refresh`, { method: 'POST', body: JSON.stringify({ force: true }) }).catch(() => {});
      }
    }
    const data = await loadCurrent();
    schedulePoll(Boolean(data?.summary?.refreshing));
  } finally {
    busy = false;
    if (click) {
      btn.disabled = false;
      btn.textContent = '刷新全部';
    }
  }
}

// ---------- 自动办理设置 ----------

function openTaskDialog(task) {
  editing = { userId: task.userId, vehicleId: task.vehicleId, owner: task.owner };
  $('#task-plate').textContent = task.plate;
  $('#task-enabled').checked = Boolean(task.auto.enabled);
  $('#task-warn-ack').checked = Boolean(task.auto.warnAck);
  $('#task-time').value = task.auto.time || '09:00';
  $('#task-makeup').checked = task.auto.makeup !== false;
  $('#task-warn').hidden = !task.auto.enabled;
  $('#task-extra').textContent = task.permit
    ? `当前六环外证件有效期至 ${task.permit.validTo}，将在该日 ${task.auto.time || '09:00'} 自动办理。`
    : '当前没有六环外证件，不会触发自动办理（触发点要求存在有效证件）。';
  $('#task-dialog').showModal();
}

$('#task-enabled').addEventListener('change', (e) => {
  $('#task-warn').hidden = !e.target.checked;
});

$('#task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const enabled = $('#task-enabled').checked;
  const warnAck = $('#task-warn-ack').checked;
  if (enabled && !warnAck) {
    alert('请先勾选确认六环外行驶范围提示');
    return;
  }
  try {
    await api(`/api/users/${editing.userId}/vehicles/${editing.vehicleId}/auto`, {
      method: 'PATCH',
      body: JSON.stringify({
        el: { enabled, warnAck, time: $('#task-time').value, makeup: $('#task-makeup').checked },
      }),
    });
    $('#task-dialog').close();
    await loadCurrent();
  } catch (err) {
    alert(err.message);
  }
});

// ---------- 办理参数 ----------

function openParamsDialog(user) {
  editing = { userId: user.id, vehicleId: null, owner: user.profile?.name || user.note || '' };
  const p = user.applyParams || {};
  $('#params-owner').textContent = editing.owner;
  $('#p-area').value = p.area || '';
  $('#p-xxdz').value = p.xxdz || '';
  $('#p-jjdzgdjd').value = p.jjdzgdjd || '';
  $('#p-jjdzgdwd').value = p.jjdzgdwd || '';
  $('#p-zjxxdz').value = p.zjxxdz || '';
  $('#p-zjxxdzgdjd').value = p.zjxxdzgdjd || '';
  $('#p-zjxxdzgdwd').value = p.zjxxdzgdwd || '';
  $('#p-sqdzgdjd').value = p.sqdzgdjd || '116.4';
  $('#p-sqdzgdwd').value = p.sqdzgdwd || '39.9';
  $('#p-jjmd').value = p.jjmd || '06';
  $('#p-sfzj').value = p.sfzj || '1';
  $('#geo-jj-results').innerHTML = '';
  $('#geo-zj-results').innerHTML = '';
  showError($('#params-error'), '');
  $('#params-dialog').showModal();
}

async function geoSearch(kind) {
  const keyword = $(kind === 'jjdz' ? '#geo-jj-keyword' : '#geo-zj-keyword').value.trim();
  const box = $(kind === 'jjdz' ? '#geo-jj-results' : '#geo-zj-results');
  if (keyword.length < 2) {
    box.innerHTML = '<div class="user-meta">请输入至少 2 个字</div>';
    return;
  }
  box.innerHTML = '<div class="user-meta">搜索中…</div>';
  try {
    const { results } = await api('/api/geo/search', { method: 'POST', body: JSON.stringify({ keyword }) });
    box.innerHTML = results.length
      ? results
          .map(
            (r) =>
              `<button type="button" class="geo-item" data-kind="${kind}" data-full="${esc(r.full)}" data-lng="${esc(r.lng)}" data-lat="${esc(r.lat)}">
                 <b>${esc(r.name)}</b><span>${esc(r.address || r.type || '')}</span>
               </button>`,
          )
          .join('')
      : '<div class="user-meta">没有找到结果</div>';
  } catch (err) {
    box.innerHTML = `<div class="user-meta">${esc(err.message)}</div>`;
  }
}

async function pickGeo(kind, full, lng, lat) {
  if (kind === 'jjdz') {
    $('#p-xxdz').value = full;
    $('#p-jjdzgdjd').value = lng;
    $('#p-jjdzgdwd').value = lat;
  } else {
    $('#p-zjxxdz').value = full || $('#p-zjxxdz').value;
    $('#p-zjxxdzgdjd').value = lng;
    $('#p-zjxxdzgdwd').value = lat;
  }
  // 区县不在 POI 结果里，反查一次自动填上
  try {
    const { geo } = await api('/api/geo/reverse', { method: 'POST', body: JSON.stringify({ lng, lat }) });
    if (geo.district) $('#p-area').value = geo.district;
  } catch {
    /* 反查失败不影响主流程，用户可以手填区县 */
  }
}

$('#params-dialog').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-geo]');
  if (btn) {
    await geoSearch(btn.dataset.geo);
    return;
  }
  const item = e.target.closest('.geo-item');
  if (item) {
    await pickGeo(item.dataset.kind, item.dataset.full, item.dataset.lng, item.dataset.lat);
    item.parentElement.innerHTML = '';
  }
});

$('#params-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const applyParams = {
    area: $('#p-area').value.trim(),
    xxdz: $('#p-xxdz').value.trim(),
    jjdzgdjd: $('#p-jjdzgdjd').value.trim(),
    jjdzgdwd: $('#p-jjdzgdwd').value.trim(),
    zjxxdz: $('#p-zjxxdz').value.trim(),
    zjxxdzgdjd: $('#p-zjxxdzgdjd').value.trim(),
    zjxxdzgdwd: $('#p-zjxxdzgdwd').value.trim(),
    sqdzgdjd: $('#p-sqdzgdjd').value.trim(),
    sqdzgdwd: $('#p-sqdzgdwd').value.trim(),
    jjmd: $('#p-jjmd').value,
    jjmdmc: JJMD_NAME[$('#p-jjmd').value],
    sfzj: $('#p-sfzj').value,
    jjdq: '010',
  };
  try {
    await api(`/api/users/${editing.userId}`, { method: 'PATCH', body: JSON.stringify({ applyParams }) });
    $('#params-dialog').close();
    await loadCurrent();
  } catch (err) {
    showError($('#params-error'), err.message);
  }
});

// ---------- 通知设置 ----------

function openNotifyDialog(user) {
  editing = { userId: user.id, vehicleId: null, owner: user.profile?.name || user.note || '' };
  const cfg = user.notify?.serverchan || {};
  $('#notify-owner').textContent = editing.owner;
  $('#notify-enabled').checked = Boolean(cfg.enabled);
  $('#notify-key').value = cfg.sendKey || '';
  showError($('#notify-error'), '');
  $('#notify-dialog').showModal();
}

$('#notify-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const enabled = $('#notify-enabled').checked;
  const sendKey = $('#notify-key').value.trim();
  if (enabled && !sendKey) {
    showError($('#notify-error'), '启用推送必须填写 SendKey，否则不会收到任何通知');
    return;
  }
  const notify = { serverchan: { enabled, sendKey } };
  try {
    await api(`/api/users/${editing.userId}`, { method: 'PATCH', body: JSON.stringify({ notify }) });
    $('#notify-dialog').close();
    await loadCurrent();
  } catch (err) {
    showError($('#notify-error'), err.message);
  }
});

// ---------- 事件绑定 ----------

$('#add-user').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#add-error');
  showError(err, '');
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  btn.textContent = '解析中…';
  try {
    await api('/api/users', {
      method: 'POST',
      body: JSON.stringify({ token: $('#token').value.trim(), note: $('#note').value.trim() }),
    });
    $('#token').value = '';
    $('#note').value = '';
    await showView('users');
  } catch (e2) {
    showError(err, e2.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '添加并解析';
  }
});

document.querySelector('.tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab) showView(tab.dataset.view).catch((err) => alert(err.message));
});

$('#users').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  btn.disabled = true;
  try {
    await api(`/api/users/${btn.dataset.id}/refresh`, { method: 'POST', body: JSON.stringify({ force: true }) });
    await loadCurrent();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
});

$('#user-admin').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const { act, id } = btn.dataset;
  const { users } = await api('/api/users');
  const user = users.find((u) => u.id === id);
  if (!user) return;

  if (act === 'params') return openParamsDialog(user);
  if (act === 'notify') return openNotifyDialog(user);
  if (act === 'notify-test') {
    btn.disabled = true;
    try {
      await api(`/api/users/${id}/notify-test`, { method: 'POST', body: '{}' });
      alert('测试通知已发送，请查看微信');
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
    }
    return;
  }
  if (act === 'refresh') {
    btn.disabled = true;
    try {
      await api(`/api/users/${id}/refresh`, { method: 'POST', body: JSON.stringify({ force: true }) });
      await loadCurrent();
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
    }
    return;
  }
  if (act === 'raw') {
    const data = await api(`/api/users/${id}/raw`);
    $('#raw-meta').textContent = `抓取时间 ${new Date(data.fetchedAt).toLocaleString('zh-CN')}${data.cached ? '（命中缓存）' : ''}`;
    $('#raw-content').textContent = JSON.stringify(data.envelope, null, 2);
    $('#raw-dialog').showModal();
    return;
  }
  if (act === 'delete') {
    if (!confirm('确认删除该凭证？删除后其车辆与记录不再显示。')) return;
    await api(`/api/users/${id}`, { method: 'DELETE' });
    await loadCurrent();
  }
});

$('#tasks').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act="edit-task"]');
  if (!btn) return;
  const { tasks } = await api('/api/tasks');
  const task = tasks.find((t) => t.vehicleId === btn.dataset.vid);
  if (task) openTaskDialog(task);
});

$('#scheduler-bar').addEventListener('click', async (e) => {
  if (e.target.id !== 'tick-now') return;
  if (!confirm('立即检查一次？如果今天正好是某辆车六环外证件的最后一天且已过设定时间，会真实提交办理。')) return;
  e.target.disabled = true;
  e.target.textContent = '检查中…';
  try {
    const { events } = await api('/api/tasks/tick', { method: 'POST', body: '{}' });
    await loadCurrent();
    alert(events.length ? `本次产生 ${events.length} 条事件` : '本次没有需要处理的任务');
  } catch (err) {
    alert(err.message);
  } finally {
    e.target.disabled = false;
    e.target.textContent = '立即检查';
  }
});

$('#refresh-all').addEventListener('click', () => refreshNow({ click: true }));

$('#auto-refresh').addEventListener('change', (e) => {
  autoRefresh = e.target.checked;
  if (autoRefresh) refreshNow();
  else clearTimeout(pollTimer);
  tickCountdown();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(pollTimer);
  else refreshNow();
  tickCountdown();
});

window.addEventListener('online', () => refreshNow());

$('#open-settings').addEventListener('click', async () => {
  const { settings } = await api('/api/settings');
  $('#set-cacheTtlSec').value = settings.cacheTtlSec;
  $('#set-minIntervalMs').value = settings.minIntervalMs;
  $('#set-viewRefreshSec').value = settings.viewRefreshSec;
  $('#set-autoRefreshOnView').checked = Boolean(settings.autoRefreshOnView);
  $('#settings-dialog').showModal();
});

$('#save-settings').addEventListener('click', async (e) => {
  e.preventDefault();
  await api('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({
      cacheTtlSec: Number($('#set-cacheTtlSec').value),
      minIntervalMs: Number($('#set-minIntervalMs').value),
      viewRefreshSec: Number($('#set-viewRefreshSec').value),
      autoRefreshOnView: $('#set-autoRefreshOnView').checked,
    }),
  });
  $('#settings-dialog').close();
  await refreshNow();
  $('#subtitle').textContent = '设置已保存';
});

// ---------- 启动 ----------

tickTimer = setInterval(tickCountdown, 1000);
const initialView = (location.hash || '#dashboard').slice(1);
showView(['dashboard', 'tasks', 'users'].includes(initialView) ? initialView : 'dashboard').catch((e) => {
  $('#subtitle').textContent = `加载失败：${e.message}`;
  schedulePoll(false);
});
