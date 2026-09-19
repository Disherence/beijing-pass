// 调度器回归测试：用假客户端离线验证触发条件、提交行为与回查判定
// 运行：node test/scheduler.test.mjs
import assert from 'node:assert/strict';
import { Scheduler, defaultAutoConfig } from '../src/scheduler.js';
import { referenceKeys } from '../src/apply.js';
import { PENDING_RECORDS } from '../src/normalize.js';
import { today, addDays, toMinutes } from '../src/date.js';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
    pass += 1;
  } catch (err) {
    console.log(`  FAIL ${name}\n       ${err.message}`);
    fail += 1;
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    pass += 1;
  } catch (err) {
    console.log(`  FAIL ${name}\n       ${err.message}`);
    fail += 1;
  }
}

const T = today();

function permitRecord({ validTo, jjzzl = '02', blzt = 1, blztmc = '审核通过(生效中)', shsbyy = null }) {
  const from = addDays(validTo, -6);
  return {
    vId: 'V1',
    applyId: 'A1',
    blzt,
    blztmc,
    sxrqmc: '',
    sxrzmc: '',
    yxqs: from,
    yxqz: validTo,
    sxsyts: null,
    jjzzl,
    jjzzlmc: jjzzl === '02' ? '进京证（六环外）' : '进京证（六环内）',
    jjzh: 'J1',
    sqsj: `${from} 09:00:00`,
    jsrxm: '张三',
    jszh: '110101199001011234',
    shsbyy,
    shsbyyms: null,
    tphtml: null,
    hphm: '京A12345',
    hpzl: '02',
    vid: 1,
  };
}

/**
 * @param {object} opts
 *   validTo      六环外证件有效期止（null 表示没有六环外记录）
 *   pending      是否有待生效的六环外证
 *   rejected     当前证是否为被拒记录
 */
function envelope({ validTo, pending = false, rejected = false, reviewing = false }) {
  const records = [];
  if (validTo) {
    records.push(
      permitRecord({
        validTo,
        blzt: reviewing ? 2 : rejected ? 5 : 1,
        blztmc: reviewing ? '审核中' : rejected ? '失败(审核不通过)' : '审核通过(生效中)',
        shsbyy: rejected ? '证件已过期' : null,
      }),
    );
  }
  const vehicle = {
    vId: 'V1',
    hpzl: '02',
    hphm: '京A12345',
    ybcs: 6,
    bzts: 42,
    kjts: 0,
    sycs: '6',
    syts: '42',
    ylzsfkb: true,
    elzsfkb: true,
    bnbzyy: null,
    qyzt: 1,
    cllx: '01',
    bzxx: records,
    // 字段名是六字母 e c b z x x，统一从 normalize.js 引入，不在测试里手打
    [PENDING_RECORDS]: pending
      ? [permitRecord({ validTo: addDays(T, 8), blzt: 6, blztmc: '审核通过(待生效)' })]
      : null,
    sfyecbzxx: pending,
    ecztbz: pending ? '1' : null,
  };
  return {
    code: 200,
    msg: 'ok',
    data: {
      sfzmhm: '110101199001011234',
      ylzqyms: '六环内规则',
      ylzmc: '进京证(六环内)',
      elzqyms: '六环外规则',
      elzmc: '进京证(六环外)',
      bzclxx: [vehicle],
    },
  };
}

const FULL_PARAMS = {
  area: '顺义区',
  xxdz: '北京市顺义区某路1号',
  jjdzgdjd: '116.8',
  jjdzgdwd: '40.16',
  zjxxdz: '某小区',
  zjxxdzgdjd: '116.8',
  zjxxdzgdwd: '40.16',
  sqdzgdjd: '116.4',
  sqdzgdwd: '39.9',
  jjmd: '06',
  jjmdmc: '其它',
  sfzj: '1',
};

/** 构造一次调度环境；calls 记录所有接口调用，state 可在测试中改写 */
function setup({ validTo = T, pending = false, rejected = false, params = FULL_PARAMS, auto = {}, nowAt = '10:00' } = {}) {
  const calls = [];
  const state = { validTo, pending, rejected };
  let clock = 1_700_000_000_000;

  const client = {
    async stateList() {
      calls.push('stateList');
      return envelope(state);
    },
    async applyVehicleCheck() {
      calls.push('applyVehicleCheck');
      return { code: 200, data: '200' };
    },
    async getJsrxx() {
      calls.push('getJsrxx');
      return { code: 200, data: { jsrxm: '张三', jszh: '110101199001011234', dabh: '' } };
    },
    async applyCheckNum() {
      calls.push('applyCheckNum');
      return { code: 200, data: '校验通过!' };
    },
    async checkHandle() {
      calls.push('checkHandle');
      return { code: 200, data: { jjrqs: [addDays(T, 1), addDays(T, 2)], kbyxts: 7 } };
    },
    async checkInputRoadInfo() {
      calls.push('checkInputRoadInfo');
      return { code: 200, data: '0' };
    },
    async insertApplyRecord(_token, payload) {
      calls.push('insertApplyRecord');
      calls.payload = payload;
      // 模拟「请求已经到达服务端并被受理」，但响应在回程丢了
      if (state.beforeSubmit) Object.assign(state, state.beforeSubmit);
      if (state.failSubmit) throw new Error(state.failSubmit);
      return { code: 200, msg: '信息已提交，正在审核!', data: { cgts: ['温馨提示'] } };
    },
  };

  const vehicle = {
    id: 'VEH1',
    vId: 'V1',
    plate: '京A12345',
    plateType: '02',
    active: true,
    auto: { el: { ...defaultAutoConfig('09:00'), enabled: true, warnAck: true, ...auto } },
  };
  const user = {
    id: 'U1',
    token: 'token',
    enabled: true,
    applyParams: params,
    vehicles: [vehicle],
    notify: { serverchan: { enabled: true, sendKey: 'SCT_test' } },
  };
  const store = {
    config: { settings: { scheduler: { enabled: true, tickSec: 60 } } },
    users: [user],
    save() {},
  };

  const notifications = [];
  const records = [];
  const scheduler = new Scheduler({
    store,
    getClient: () => client,
    setSnapshot: () => {},
    notify: async (_user, message) => {
      notifications.push(message);
      return { ok: true };
    },
    record: (entry) => records.push(entry),
    log: () => {},
    today: () => T,
    nowMinutes: () => toMinutes(nowAt),
    now: () => clock,
  });

  return {
    scheduler,
    calls,
    state,
    vehicle,
    user,
    notifications,
    records,
    auto: vehicle.auto.el,
    /** 推进测试用的虚拟时钟 */
    advance: (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
}

const submits = (calls) => calls.filter((c) => c === 'insertApplyRecord').length;

console.log('== 调度器回归测试 ==');
console.log(`   今天 ${T}\n`);

console.log('-- 触发条件 --');

await checkAsync('非最后一天且仍有效：不提交', async () => {
  const { scheduler, calls } = setup({ validTo: addDays(T, 3) });
  await scheduler.tick();
  assert.equal(submits(calls), 0);
});

await checkAsync('已是最后一天但未到设定时间：不提交', async () => {
  const { scheduler, calls } = setup({ validTo: T, nowAt: '08:00', auto: { time: '09:00' } });
  await scheduler.tick();
  assert.equal(calls.length, 0);
});

await checkAsync('已有待生效证件：不提交', async () => {
  const { scheduler, calls } = setup({ validTo: T, pending: true });
  await scheduler.tick();
  assert.equal(submits(calls), 0);
});

await checkAsync('关闭补办且已过窗口：不提交', async () => {
  const { scheduler, calls } = setup({ validTo: T, nowAt: '14:00', auto: { time: '09:00', makeup: false } });
  await scheduler.tick();
  assert.equal(calls.length, 0);
});

await checkAsync('关闭补办但在窗口内：提交', async () => {
  const { scheduler, calls } = setup({ validTo: T, nowAt: '09:20', auto: { time: '09:00', makeup: false } });
  await scheduler.tick();
  assert.equal(submits(calls), 1);
});

console.log('-- 兜底补办 --');

await checkAsync('证件昨天到期（仍有效期内漏办）：今天补办', async () => {
  const { scheduler, calls, auto } = setup({ validTo: addDays(T, -1) });
  await scheduler.tick();
  assert.equal(submits(calls), 1);
  assert.match(auto.lastResult, /已提交/);
});

await checkAsync('完全没有六环外证件：按补办提交', async () => {
  const { scheduler, calls } = setup({ validTo: null });
  await scheduler.tick();
  assert.equal(submits(calls), 1);
});

await checkAsync('补办提交时给出补办原因', async () => {
  const { scheduler, notifications } = setup({ validTo: addDays(T, -2) });
  await scheduler.tick();
  assert.match(notifications.at(-1).desp, /补办/);
});

console.log('-- 提交行为 --');

await checkAsync('最后一天 + 到点：走完整校验链并提交一次', async () => {
  const { scheduler, calls } = setup({ validTo: T });
  await scheduler.tick();
  assert.deepEqual(calls.filter((c) => c !== 'stateList'), [
    'applyVehicleCheck',
    'getJsrxx',
    'applyCheckNum',
    'checkHandle',
    'checkInputRoadInfo',
    'insertApplyRecord',
  ]);
});

await checkAsync('提交报文与真实抓包字段完全一致', async () => {
  const { scheduler, calls } = setup({ validTo: T });
  await scheduler.tick();
  assert.deepEqual(Object.keys(calls.payload), referenceKeys());
  assert.equal(calls.payload.jjzzl, '02', '必须是六环外');
  assert.equal(calls.payload.jjrq, addDays(T, 1), '生效日期取官方返回的第一个可选日期');
  assert.equal(calls.payload.jjlk, '', '六环外不填行驶路线');
});

await checkAsync('同一天重复 tick：不重复提交', async () => {
  const { scheduler, calls } = setup({ validTo: T });
  await scheduler.tick();
  await scheduler.tick();
  await scheduler.tick();
  assert.equal(submits(calls), 1);
});

await checkAsync('办理参数不完整：不提交但通知', async () => {
  const { scheduler, calls, notifications } = setup({ validTo: T, params: { area: '顺义区' } });
  await scheduler.tick();
  assert.equal(submits(calls), 0);
  assert.match(notifications[0].title, /办理参数不完整/);
});

await checkAsync('提交后登记回查排期', async () => {
  const { scheduler, auto, now } = setup({ validTo: T });
  await scheduler.tick();
  assert.ok(auto.pendingConfirm, '应登记回查');
  assert.ok(auto.pendingConfirm.at > now(), '回查时间应在未来');
  assert.equal(auto.pendingConfirm.since, T, '记录提交日期用于判定新证');
  assert.equal(auto.idempotencyKey, `V1:el:${T}`);
});

console.log('-- 提交失败与重试 --');

await checkAsync('提交失败：记录失败并通知', async () => {
  const { scheduler, auto, notifications, state } = setup({ validTo: T });
  state.failSubmit = '网络错误：超时';
  await scheduler.tick();
  assert.match(auto.lastResult, /失败/);
  assert.match(notifications.at(-1).title, /失败/);
});

await checkAsync('提交失败后 20 分钟内不重试', async () => {
  const { scheduler, calls, state } = setup({ validTo: T });
  state.failSubmit = '网络错误：超时';
  await scheduler.tick();
  const afterFirst = submits(calls);
  assert.equal(afterFirst, 1, '首次应尝试提交');
  await scheduler.tick();
  assert.equal(submits(calls), afterFirst, '间隔未到不应重试');
});

await checkAsync('提交失败 20 分钟后自动重试', async () => {
  const { scheduler, calls, advance, state } = setup({ validTo: T });
  state.failSubmit = '网络错误：超时';
  await scheduler.tick();
  assert.equal(submits(calls), 1);
  advance(21 * 60 * 1000);
  await scheduler.tick();
  assert.equal(submits(calls), 2, '超过间隔应重试');
});

await checkAsync('提交抛错但回查已有待生效：认定为已受理', async () => {
  const { scheduler, auto, state } = setup({ validTo: T });
  state.failSubmit = 'socket hang up';
  // 服务端其实已经受理，只是响应没回来
  state.beforeSubmit = { pending: true };
  await scheduler.tick();
  assert.match(auto.lastResult, /回查确认已受理/);
  assert.ok(auto.pendingConfirm, '仍应登记回查');
});

console.log('-- 回查判定 --');

await checkAsync('回查看到覆盖到明天之后的新证：判定成功', async () => {
  const { scheduler, auto, state, notifications } = setup({ validTo: T });
  await scheduler.tick(); // 提交，产生 1 条「已提交」通知
  state.validTo = addDays(T, 7); // 新证下发
  auto.pendingConfirm.at = 0;
  await scheduler.tick();
  assert.match(auto.lastResult, new RegExp(addDays(T, 7)));
  assert.match(notifications.at(-1).title, /办理成功/);
  assert.ok(auto.pendingConfirm, '仍要继续观察，防止之后被改判');
});

await checkAsync('办理成功只推一次，后续回查不重复推送', async () => {
  const { scheduler, auto, state, notifications } = setup({ validTo: T });
  await scheduler.tick();
  state.validTo = addDays(T, 7);
  auto.pendingConfirm.at = 0;
  await scheduler.tick(); // 第一次看到通过 → 推「办理成功」
  const afterSuccess = notifications.filter((n) => /办理成功/.test(n.title)).length;
  auto.pendingConfirm.at = 0;
  await scheduler.tick(); // 再查一次，状态没变
  auto.pendingConfirm.at = 0;
  await scheduler.tick();
  assert.equal(notifications.filter((n) => /办理成功/.test(n.title)).length, afterSuccess, '不应重复推送成功');
});

await checkAsync('观察期内被改判为审核不通过：推送失败更正通知', async () => {
  const { scheduler, auto, state, notifications } = setup({ validTo: T });
  await scheduler.tick();
  state.validTo = addDays(T, 7);
  auto.pendingConfirm.at = 0;
  await scheduler.tick(); // 第一次看到「审核通过(待生效)」→ 推成功
  assert.ok(auto.pendingConfirm);
  state.rejected = true; // 十几分钟后被改判
  auto.pendingConfirm.at = 0;
  await scheduler.tick();
  assert.equal(auto.pendingConfirm, null, '已下结论，不再观察');
  assert.match(notifications.at(-1).title, /改判为未通过/);
  assert.match(notifications.at(-1).desp, /以本条为准/);
});

await checkAsync('观察窗口结束全程正常：只有一条成功通知', async () => {
  const { scheduler, auto, state, notifications } = setup({ validTo: T });
  await scheduler.tick();
  state.validTo = addDays(T, 7);
  auto.pendingConfirm.at = 0;
  await scheduler.tick(); // 首次确认成功
  auto.pendingConfirm.checks = 5; // 下一次即最后一次
  auto.pendingConfirm.at = 0;
  await scheduler.tick();
  assert.equal(auto.pendingConfirm, null);
  const success = notifications.filter((n) => /办理成功/.test(n.title));
  assert.equal(success.length, 1, '成功只推一条');
  assert.equal(notifications.filter((n) => /未确认|未通过/.test(n.title)).length, 0, '不该有异常通知');
});

await checkAsync('状态仍是审核中：不算办成，继续观察', async () => {
  const { scheduler, auto, state } = setup({ validTo: T });
  await scheduler.tick();
  state.validTo = addDays(T, 7);
  state.reviewing = true;
  auto.pendingConfirm.at = 0;
  await scheduler.tick();
  assert.ok(auto.pendingConfirm, '审核中不能提前收工');
  assert.match(auto.lastResult, /等待审核结果/);
});

await checkAsync('回查仍只有今天到期的旧证：不误报成功，继续等待', async () => {
  const { scheduler, auto, notifications } = setup({ validTo: T });
  await scheduler.tick();
  auto.pendingConfirm.at = 0;
  await scheduler.tick();
  assert.ok(auto.pendingConfirm, '未出结果应保留排期继续查');
  assert.doesNotMatch(notifications.at(-1).title, /办理成功/);
  assert.match(auto.lastResult, /等待审核结果/);
});

await checkAsync('回查发现被拒：通知审核未通过', async () => {
  const { scheduler, auto, state, notifications } = setup({ validTo: T });
  await scheduler.tick();
  state.validTo = addDays(T, 7);
  state.rejected = true;
  auto.pendingConfirm.at = 0;
  await scheduler.tick();
  assert.equal(auto.pendingConfirm, null);
  assert.match(notifications.at(-1).title, /审核未通过/);
});

await checkAsync('回查请求失败：保留排期稍后重试', async () => {
  const { scheduler, auto } = setup({ validTo: T });
  await scheduler.tick();
  const client = scheduler.ctx.getClient();
  const original = client.stateList;
  client.stateList = async () => {
    throw new Error('网络错误：连接被重置');
  };
  auto.pendingConfirm.at = 0;
  await scheduler.tick();
  assert.ok(auto.pendingConfirm, '回查失败也必须保留排期，否则永远收不到结果');
  assert.match(auto.lastResult, /回查失败/);
  client.stateList = original;
});

await checkAsync('回查连续未确认达到上限：给出明确结论', async () => {
  const { scheduler, auto, notifications } = setup({ validTo: T });
  await scheduler.tick();
  auto.pendingConfirm.checks = 5; // 下一次即达到上限
  auto.pendingConfirm.at = 0;
  await scheduler.tick();
  assert.equal(auto.pendingConfirm, null);
  assert.match(notifications.at(-1).title, /结果未确认/);
});

await checkAsync('关闭开关后仍会把待回查的结果查完', async () => {
  const { scheduler, auto, state } = setup({ validTo: T });
  await scheduler.tick();
  auto.enabled = false; // 用户中途关掉开关
  state.validTo = addDays(T, 7);
  auto.pendingConfirm.at = 0;
  await scheduler.tick();
  assert.match(auto.lastResult, new RegExp(addDays(T, 7)));
});

check('日期工具输出北京时间的今天', () => assert.match(T, /^\d{4}-\d{2}-\d{2}$/));

console.log(`\n== 通过 ${pass} 项，失败 ${fail} 项 ==`);
process.exit(fail === 0 ? 0 : 1);
