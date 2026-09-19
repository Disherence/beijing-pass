// 自动办理调度器
//
// 触发条件：
//   1) 当前六环外证件的最后一天到达用户设定时间（正常续办）
//   2) 六环外证件已过期或不存在（兜底补办）——避免某天服务停机导致证件断档
//
// 提交不可撤销，因此原则是「宁可漏办，不可错办」：
//   · 提交前走完整前置校验链，任一环失败立即中止
//   · 提交前最后一次实时确认，并用这份最新数据组装报文
//   · 提交后 10 分钟开始回查，每 10 分钟一次、最多 6 次（约一小时的观察窗口）
//   · 同一到期窗口只提交一次；失败最多重试 3 次且间隔 20 分钟
//
// 通知策略：提交、办成、出问题都会推送。
//   · 提交成功 → 推一条「已提交」，让你知道自动办理确实跑了
//   · 审核通过 → 推一条「办理成功」（每个续办周期只推一次）
//   · 审核未通过、结果始终未确认、提交失败 → 都推送
//   · 若推过成功之后又被改判为未通过，再推一条更正通知并说明以本条为准
import { today, nowMinutes, toMinutes, stamp } from './date.js';
import { normalizeStateList } from './normalize.js';
import { buildApplyPayload, missingParams, diffAgainstReference } from './apply.js';

/** 提交后首次回查间隔：官方约 10 分钟下发 */
const CONFIRM_DELAY_MS = 10 * 60 * 1000;
/**
 * 回查间隔与最多次数。
 * 不只看一次的原因：「审核通过(待生效)」这个状态在提交后几秒就会出现，
 * 它只代表申请被受理，不代表最终审核通过；只看一次会把之后才出的失败漏掉。
 * 6 次 × 10 分钟 = 约一小时的观察窗口。
 */
const CONFIRM_INTERVAL_MS = 10 * 60 * 1000;
const CONFIRM_MAX_CHECKS = 6;
/** 同一天最多提交尝试次数与重试间隔 */
const MAX_ATTEMPTS_PER_DAY = 3;
const RETRY_GAP_MS = 20 * 60 * 1000;
/** 关闭「错过补办」时，只在设定时间后这么久内执行 */
const MAKEUP_WINDOW_MIN = 30;
/** 官方审核通过的状态码：1 生效中、6 待生效 */
const APPROVED_CODES = new Set([1, 6]);
const REJECTED_RE = /(不通过|失败)/;

export function defaultAutoConfig(time = '09:00') {
  return {
    enabled: false,
    warnAck: false,
    time,
    makeup: true,
    lastEvalDate: null,
    lastRunAt: null,
    lastCheckedAt: null,
    lastResult: null,
    /** 已成功提交的到期窗口，格式 `${vId}:el:${日期}`，用于防重复提交 */
    idempotencyKey: null,
    /** 待回查的办理结果 { at, attempts, since } */
    pendingConfirm: null,
    /** 当天的提交尝试计数 { date, count, lastAt } */
    attempt: null,
  };
}

export class Scheduler {
  constructor(ctx) {
    this.ctx = ctx;
    this.timer = null;
    this.busy = false;
    this.lastTickAt = null;
  }

  get tickSec() {
    return Number(this.ctx.store.config.settings.scheduler?.tickSec) || 60;
  }

  // 时间来源可注入，便于测试固定「今天」与「当前时刻」
  #today() {
    return this.ctx.today ? this.ctx.today() : today();
  }

  #nowMinutes() {
    return this.ctx.nowMinutes ? this.ctx.nowMinutes() : nowMinutes();
  }

  // 当前时间戳同样可注入，便于测试重试间隔与回查排期
  #now() {
    return this.ctx.now ? this.ctx.now() : Date.now();
  }

  /**
   * @param {{immediate?: boolean}} options
   *   immediate 为 true 时启动后立即检查一次（进程启动场景）；
   *   修改设置等场景应传 false，避免顺手触发一次办理。
   */
  start({ immediate = true } = {}) {
    this.stop();
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.ctx.log(`[调度] tick 异常：${err.message}`));
    }, this.tickSec * 1000);
    if (this.timer.unref) this.timer.unref();
    if (immediate) this.tick().catch(() => {});
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.busy) return [];
    this.busy = true;
    try {
      return await this.runOnce();
    } finally {
      this.busy = false;
    }
  }

  async runOnce() {
    if (!this.ctx.store.config.settings.scheduler?.enabled) return [];
    const t = this.#today();
    const events = [];
    let dirty = false;

    for (const user of this.ctx.store.users) {
      if (!user.enabled) continue;
      for (const vehicle of user.vehicles || []) {
        if (!vehicle.active) continue;
        const auto = vehicle.auto?.el;
        if (!auto) continue;
        // 待回查的车辆即使已经关掉开关，也要把结果查完并通知
        const armed = auto.enabled && auto.warnAck;
        if (!armed && !auto.pendingConfirm) continue;
        try {
          const event = await this.#handleVehicle({ user, vehicle, auto, t, armed });
          if (event) {
            dirty = true;
            if (event.type !== 'skip') events.push(event);
            if (event.reason) this.ctx.log(`[调度] ${vehicle.plate}：${event.reason}`);
          }
        } catch (err) {
          auto.lastResult = `异常：${err.message}`;
          dirty = true;
          this.ctx.log(`[调度] ${vehicle.plate} 处理异常：${err.message}`);
        }
      }
    }

    this.lastTickAt = stamp();
    if (dirty) this.ctx.store.save();
    return events;
  }

  async #handleVehicle({ user, vehicle, auto, t, armed }) {
    // 1) 有待回查的办理结果，优先处理
    if (auto.pendingConfirm && this.#now() >= auto.pendingConfirm.at) {
      return this.#confirm({ user, vehicle, auto });
    }
    if (!armed) return null;

    // 2) 时间判断：未到设定时间不动作
    const startAt = toMinutes(auto.time || '09:00');
    const nowMin = this.#nowMinutes();
    if (nowMin < startAt) return null;
    if (!auto.makeup && nowMin > startAt + MAKEUP_WINDOW_MIN) {
      if (auto.lastEvalDate !== t) {
        auto.lastEvalDate = t;
        auto.lastResult = `已过设定时间（${auto.time}），错过补办未开启`;
        return { type: 'skip', reason: auto.lastResult };
      }
      return null;
    }

    // 3) 同一天只评估一次；但提交失败后要允许按间隔重试
    if (auto.lastEvalDate === t && !this.#wantsRetry(auto, t)) return null;

    // 4) 主动回源取最新状态（判断依据必须是实时数据，不能吃缓存）
    const env = await this.ctx.getClient().stateList(user.token, { cache: false });
    const view = normalizeStateList(env);
    this.ctx.setSnapshot(user.id, env, view);
    auto.lastEvalDate = t;
    auto.lastCheckedAt = stamp();

    const v = view.vehicles.find((x) => x.vId === vehicle.vId);
    const current = v?.el?.current;

    // 已有待生效证件 → 什么都不做
    if (v?.el?.records?.some((r) => r.validFrom > t)) {
      auto.lastResult = '已有待生效证件，跳过';
      return { type: 'skip', reason: auto.lastResult };
    }

    const lastDay = Boolean(current && current.validTo === t);
    const expired = !current || current.validTo < t;
    if (!lastDay && !expired) {
      auto.lastResult = `六环外证有效至 ${current.validTo}，未到触发条件`;
      return { type: 'skip', reason: auto.lastResult };
    }

    const reason = lastDay ? '今天是证件最后一天' : `证件已失效（${current ? `有效至 ${current.validTo}` : '无六环外证'}），执行补办`;
    return this.#submit({ user, vehicle, auto, t, reason });
  }

  #wantsRetry(auto, t) {
    const a = auto.attempt;
    if (!a || a.date !== t) return false;
    if (a.count <= 0 || a.count >= MAX_ATTEMPTS_PER_DAY) return false;
    return this.#now() - a.lastAt >= RETRY_GAP_MS;
  }

  async #submit({ user, vehicle, auto, t, reason }) {
    const client = this.ctx.getClient();
    const key = `${vehicle.vId}:el:${t}`;

    if (auto.idempotencyKey === key) {
      auto.lastResult = '该到期窗口已提交过，跳过';
      return { type: 'skip', reason: auto.lastResult };
    }

    const attempt = auto.attempt?.date === t ? auto.attempt : { date: t, count: 0, lastAt: 0 };
    auto.attempt = attempt;
    if (attempt.count >= MAX_ATTEMPTS_PER_DAY) {
      auto.lastResult = `今日已尝试 ${attempt.count} 次，停止重试`;
      return { type: 'skip', reason: auto.lastResult };
    }
    if (attempt.lastAt && this.#now() - attempt.lastAt < RETRY_GAP_MS) {
      return null;
    }

    const params = user.applyParams || {};
    const missing = missingParams(params);
    if (missing.length) {
      auto.lastResult = `办理参数不完整：${missing.join('、')}`;
      this.#log(user, vehicle, 'fail', auto.lastResult, {});
      await this.#notify(
        user,
        vehicle,
        '自动办理中止：办理参数不完整',
        `缺少：${missing.join('、')}\n\n请到「用户管理」补全后重新开启。`,
      );
      return { type: 'fail', reason: auto.lastResult };
    }

    attempt.count += 1;
    attempt.lastAt = this.#now();
    auto.lastRunAt = stamp();
    auto.lastResult = `准备提交（${reason}）`;

    try {
      // 前置校验链，顺序与官方 H5 一致
      await client.applyVehicleCheck(user.token, { hphm: vehicle.plate, hpzl: vehicle.plateType });
      const jsr = await client.getJsrxx(user.token, { cache: false });
      await client.applyCheckNum(user.token, {
        jsrxm: jsr.data.jsrxm,
        jszh: jsr.data.jszh,
        dabh: jsr.data.dabh || '',
      });
      const handle = await client.checkHandle(
        user.token,
        { vId: vehicle.vId, jjzzl: '02', hphm: vehicle.plate },
        { cache: false },
      );
      const jjrq = handle.data?.jjrqs?.[0];
      if (!jjrq) throw new Error('官方未返回可办日期');
      await client.checkInputRoadInfo(user.token, { vId: vehicle.vId }, { cache: false });

      // 提交前最后一次实时确认：既用于安全检查，也是报文的字段来源
      const freshEnv = await client.stateList(user.token, { cache: false });
      const freshView = normalizeStateList(freshEnv);
      this.ctx.setSnapshot(user.id, freshEnv, freshView);
      const fv = freshView.vehicles.find((x) => x.vId === vehicle.vId);
      if (fv?.el?.records?.some((r) => r.validFrom > t)) {
        auto.lastResult = '已存在待生效证件，跳过提交';
        return { type: 'skip', reason: auto.lastResult };
      }
      const freshCurrent = fv?.el?.current;
      if (freshCurrent && freshCurrent.validTo > t) {
        auto.lastResult = '状态已变化（证件已被续期），跳过提交';
        return { type: 'skip', reason: auto.lastResult };
      }
      const rawVehicle = (freshEnv.data?.bzclxx || []).find((x) => x.vId === vehicle.vId);
      if (!rawVehicle) throw new Error('状态接口未返回该车辆');

      const payload = buildApplyPayload({ rawVehicle, jsrxx: jsr.data, jjrq, params });
      const diff = diffAgainstReference(payload);
      if (diff.ok === false) {
        this.ctx.log(`[调度] 报文与基准不一致：缺少 ${JSON.stringify(diff.missing)} 多余 ${JSON.stringify(diff.extra)}`);
      }

      const res = await client.insertApplyRecord(user.token, payload);
      auto.idempotencyKey = key;
      auto.lastResult = `已提交，${jjrq} 起生效`;
      auto.pendingConfirm = { at: this.#now() + CONFIRM_DELAY_MS, checks: 0, since: t };
      auto.attempt = null;

      const tips = (res.data?.cgts || []).join('\n');
      this.#log(user, vehicle, 'submit', auto.lastResult, { jjrq, reason, payload });
      await this.#notify(
        user,
        vehicle,
        '进京证自动办理已提交',
        `车牌：${vehicle.plate}\n办理原因：${reason}\n生效日期：${jjrq}\n提交时间：${auto.lastRunAt}\n\n审核结果约 10 分钟后自动回查并推送。${
          tips ? `\n\n${tips}` : ''
        }`,
      );
      return { type: 'submit', ok: true, plate: vehicle.plate, jjrq };
    } catch (err) {
      // 提交报错未必等于没提交成功（例如响应超时），先回查状态再定性
      const settled = await this.#hasPendingPermit(user, vehicle, t);
      if (settled) {
        auto.idempotencyKey = key;
        auto.lastResult = '提交请求异常，但回查确认已受理';
        auto.pendingConfirm = { at: this.#now() + CONFIRM_DELAY_MS, checks: 0, since: t };
        auto.attempt = null;
        this.#log(user, vehicle, 'submit', auto.lastResult, { error: err.message });
        return { type: 'submit', ok: true, plate: vehicle.plate };
      }

      auto.lastResult = `失败：${err.message}`;
      this.#log(user, vehicle, 'fail', auto.lastResult, { error: err.message });
      const left = MAX_ATTEMPTS_PER_DAY - attempt.count;
      await this.#notify(
        user,
        vehicle,
        '进京证自动办理失败',
        `车牌：${vehicle.plate}\n时间：${stamp()}\n原因：${err.message}\n\n${
          left > 0 ? `将在约 20 分钟后重试，今日还剩 ${left} 次机会。` : '今日重试次数已用完，请手动办理。'
        }`,
      );
      return { type: 'fail', plate: vehicle.plate, reason: err.message };
    }
  }

  /** 回查是否已经存在待生效的六环外证件 */
  async #hasPendingPermit(user, vehicle, t) {
    try {
      const env = await this.ctx.getClient().stateList(user.token, { cache: false });
      const view = normalizeStateList(env);
      this.ctx.setSnapshot(user.id, env, view);
      const v = view.vehicles.find((x) => x.vId === vehicle.vId);
      return Boolean(v?.el?.records?.some((r) => r.validFrom > t));
    } catch {
      return false;
    }
  }

  /**
   * 回查审核结果。
   *
    * 通知策略（按需求）：提交、办成、出问题都会推送一条。
    * 判定必须同时满足两点，缺一不可：
   *   1) 证件有效期覆盖到提交日之后 → 确认是新办下来的证，而不是今天到期的旧证
   *   2) 状态码属于「审核通过」→ 排除仍在「审核中」的情况，
   *      否则会把还在审核的申请当成办成，之后真失败就再也不会被发现
   */
  async #confirm({ user, vehicle, auto }) {
    const client = this.ctx.getClient();
    const pc = auto.pendingConfirm;
    const since = pc.since;

    const checks = (pc.checks || 0) + 1;
    const lastCheck = checks >= CONFIRM_MAX_CHECKS;

    /** 返回 true 表示还要继续观察 */
    const keepWatching = () => {
      if (lastCheck) {
        auto.pendingConfirm = null;
        return false;
      }
      auto.pendingConfirm = { ...pc, checks, at: this.#now() + CONFIRM_INTERVAL_MS };
      return true;
    };

    try {
      const env = await client.stateList(user.token, { cache: false });
      const view = normalizeStateList(env);
      this.ctx.setSnapshot(user.id, env, view);
      auto.lastCheckedAt = stamp();

      const v = view.vehicles.find((x) => x.vId === vehicle.vId);
      const rec = v?.el?.current;

      // 1) 明确被拒
      const rejected = rec && (rec.rejectReason || REJECTED_RE.test(rec.status || ''));
      if (rejected) {
        auto.pendingConfirm = null;
        auto.lastResult = `审核未通过：${rec.rejectReason || rec.status}`;
        this.#log(user, vehicle, 'fail', auto.lastResult, {});
        // 之前已经推过「办理成功」的话，这条必须说清楚是被改判，
        // 否则你收到的最后一条消息还是"成功"
        const corrected = pc.successNotified
          ? '⚠️ 本次回查前曾显示「审核通过」，随后被官方改判为未通过，请以本条为准。\n\n'
          : '';
        await this.#notify(
          user,
          vehicle,
          pc.successNotified ? '进京证审核被改判为未通过' : '进京证审核未通过',
          corrected +
            `车牌：${vehicle.plate}\n状态：${rec.status}\n原因：${rec.rejectReason || '官方未给出原因'}\n\n` +
            `证件将于 ${pc.since} 到期，请尽快手动重新办理。`,
        );
        return { type: 'confirm', ok: false, plate: vehicle.plate, reason: auto.lastResult };
      }

      // 2) 审核通过且新证覆盖到提交日之后 → 办成了，推一条
      // 但不在这里收工：这个状态提交后几秒就会出现，只代表申请被受理，
      // 继续观察到窗口结束，万一之后被改判还能补一条更正通知
      const approved = rec && APPROVED_CODES.has(rec.statusCode);
      if (approved && rec.validTo > since) {
        auto.lastResult = `${rec.status} ${rec.validFrom}~${rec.validTo}`;
        if (!pc.successNotified) {
          this.#log(user, vehicle, 'confirm', auto.lastResult, { checks });
          await this.#notify(
            user,
            vehicle,
            '进京证办理成功',
            `车牌：${vehicle.plate}\n状态：${rec.status}\n有效期：${rec.validFrom} ~ ${rec.validTo}\n证号：${rec.permitNo || '-'}\n\n` +
              `将继续观察到 ${CONFIRM_MAX_CHECKS} 次回查结束，若被改判会再通知你。`,
          );
          pc.successNotified = true;
        }
        const stillWatching = keepWatching();
        return { type: 'confirm', ok: true, pending: stillWatching, plate: vehicle.plate };
      }

      // 3) 还在审核中、只有旧证、或记录缺失：继续等，不能算办成
      auto.lastResult = approved
        ? '等待审核结果（尚未看到覆盖到期日之后的新证件）'
        : `等待审核结果（当前状态：${rec?.status || '无六环外证件记录'}）`;
      const stillWatching = keepWatching();
      if (!stillWatching) {
        auto.lastResult = `结果未确认：回查 ${CONFIRM_MAX_CHECKS} 次仍未看到审核通过的新证件`;
        this.#log(user, vehicle, 'fail', auto.lastResult, {});
        await this.#notify(
          user,
          vehicle,
          '进京证结果未确认',
          `车牌：${vehicle.plate}\n已回查 ${CONFIRM_MAX_CHECKS} 次（约一小时）仍未看到审核通过的新证件，` +
            `证件将于 ${since} 到期，请手动登录官方渠道确认。`,
        );
      }
      return { type: 'confirm', ok: false, pending: stillWatching, plate: vehicle.plate, reason: auto.lastResult };
    } catch (err) {
      // 回查请求失败：保留标记按间隔重试，绝不静默丢弃
      const stillWatching = keepWatching();
      if (stillWatching) {
        auto.lastResult = `回查失败，${Math.round(CONFIRM_INTERVAL_MS / 60000)} 分钟后重试：${err.message}`;
      } else {
        auto.lastResult = `回查连续失败：${err.message}`;
        this.#log(user, vehicle, 'fail', auto.lastResult, {});
        await this.#notify(
          user,
          vehicle,
          '进京证结果未确认',
          `车牌：${vehicle.plate}\n回查连续失败 ${CONFIRM_MAX_CHECKS} 次：${err.message}\n` +
            `证件将于 ${since} 到期，请手动登录官方渠道确认。`,
        );
      }
      return { type: 'confirm', ok: false, pending: stillWatching, plate: vehicle.plate, reason: auto.lastResult };
    }
  }

  #log(user, vehicle, kind, message, extra) {
    this.ctx.record({
      at: stamp(),
      type: 'apply',
      kind,
      userId: user.id,
      plate: vehicle.plate,
      message,
      ...extra,
    });
  }

  #notify(user, vehicle, title, body) {
    return this.ctx.notify(user, { title: `${title} · ${vehicle.plate}`, desp: body });
  }
}
