#!/usr/bin/env bash
# 冒烟测试：在目标机器上以 mock 模式启动服务并逐项校验
# 用法：bash tools/smoke.sh [端口]
set -u

PORT="${1:-3113}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$(mktemp -d)"
PASS=0
FAIL=0

cd "$ROOT"
node server.js --mock --port="$PORT" --data="$DATA" >/tmp/jjz-smoke.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; wait $PID 2>/dev/null; rm -rf "$DATA"' EXIT

for _ in $(seq 1 30); do
  curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/health" && break
  sleep 0.3
done

check() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    printf '  ok   %-42s %s\n' "$name" "$actual"
    PASS=$((PASS + 1))
  else
    printf '  FAIL %-42s 期望 %s 实际 %s\n' "$name" "$expected" "$actual"
    FAIL=$((FAIL + 1))
  fi
}

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "== 冒烟测试 port=$PORT =="

echo "-- 调度器单元测试 --"
if node test/scheduler.test.mjs >/tmp/jjz-unit.log 2>&1; then
  printf '  ok   %-42s %s\n' "调度器回归测试" "$(tail -1 /tmp/jjz-unit.log)"
  PASS=$((PASS + 1))
else
  printf '  FAIL %-42s\n' "调度器回归测试"
  cat /tmp/jjz-unit.log
  FAIL=$((FAIL + 1))
fi

echo "-- 静态与基础接口 --"
check "GET /" 200 "$(code "http://127.0.0.1:$PORT/")"
check "GET /app.js" 200 "$(code "http://127.0.0.1:$PORT/app.js")"
check "GET /style.css" 200 "$(code "http://127.0.0.1:$PORT/style.css")"
check "GET /api/health" 200 "$(code "http://127.0.0.1:$PORT/api/health")"
check "GET /api/dashboard" 200 "$(code "http://127.0.0.1:$PORT/api/dashboard")"
check "未知接口返回 404" 404 "$(code "http://127.0.0.1:$PORT/api/nope")"
check "路径穿越被拦截" 404 "$(code --path-as-is "http://127.0.0.1:$PORT/../package.json")"
check "畸形 URI 返回 400 而不是崩溃" 400 "$(code --path-as-is "http://127.0.0.1:$PORT/%")"
check "畸形 URI 之后服务仍存活" 200 "$(code "http://127.0.0.1:$PORT/api/health")"

echo "-- 用户管理 --"
check "空 token 被拒" 400 \
  "$(code -X POST "http://127.0.0.1:$PORT/api/users" -H 'Content-Type: application/json' --data '{"token":""}')"
check "非法 JSON 被拒" 500 \
  "$(code -X POST "http://127.0.0.1:$PORT/api/users" -H 'Content-Type: application/json' --data 'not-json')"
check "添加用户成功" 200 \
  "$(code -X POST "http://127.0.0.1:$PORT/api/users" -H 'Content-Type: application/json' --data '{"token":"mock-token","note":"冒烟"}')"
check "重复添加返回 409" 409 \
  "$(code -X POST "http://127.0.0.1:$PORT/api/users" -H 'Content-Type: application/json' --data '{"token":"mock-token"}')"

echo "-- 数据解析（ecbzxx 回归） --"
DASH="$(curl -s "http://127.0.0.1:$PORT/api/dashboard")"
node -e '
const j = JSON.parse(process.argv[1]);
const v = j.vehicles[0];
const fail = (m) => { console.log("  FAIL " + m); process.exit(1); };
if (j.summary.users !== 1) fail("用户数应为 1");
if (!v) fail("未解析到车辆");
if (!v.yl.current) fail("六环内证件缺失");
if (!v.el.current) fail("六环外证件缺失（检查 eczbxx 字段名）");
if (!v.yl.current.stampImage) fail("印章图缺失");
console.log("  ok   六环内 " + v.yl.current.status + " " + v.yl.current.validFrom + "~" + v.yl.current.validTo);
console.log("  ok   六环外 " + v.el.current.status + " " + v.el.current.validFrom + "~" + v.el.current.validTo);
console.log("  ok   剩余次数 " + v.counters.ylLeft + "，印章图已内嵌");
' "$DASH"
if [ $? -eq 0 ]; then PASS=$((PASS + 2)); else FAIL=$((FAIL + 1)); fi

echo "-- 北京时间（容器时区无关） --"
HEALTH="$(curl -s "http://127.0.0.1:$PORT/api/health")"
node -e '
const j = JSON.parse(process.argv[1]);
const sysTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
console.log("  info 系统时区=" + sysTz + " 应用认为今天=" + j.today + " 现在=" + j.now);
if (!/^\d{4}-\d{2}-\d{2}$/.test(j.today)) { console.log("  FAIL 日期格式异常"); process.exit(1); }
' "$HEALTH"
if [ $? -eq 0 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi

echo "-- 重启后数据仍在（快照持久化） --"
USER_ID="$(node -e 'const j=JSON.parse(process.argv[1]);process.stdout.write(j.users?j.users[0].id:"")' "$(curl -s "http://127.0.0.1:$PORT/api/users")")"
test -f "$DATA/state.json" && SNAP=yes || SNAP=no
check "state.json 已写入" yes "$SNAP"
kill $PID 2>/dev/null
wait $PID 2>/dev/null
node server.js --mock --port="$PORT" --data="$DATA" >/tmp/jjz-smoke2.log 2>&1 &
PID=$!
for _ in $(seq 1 30); do
  curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/health" && break
  sleep 0.3
done
AFTER="$(curl -s "http://127.0.0.1:$PORT/api/dashboard")"
node -e '
const j = JSON.parse(process.argv[1]);
const fail = (m) => { console.log("  FAIL " + m); process.exit(1); };
if (j.summary.users !== 1) fail("重启后用户丢失");
if (j.summary.vehicles !== 1) fail("重启后车辆丢失（快照未恢复）");
if (!j.vehicles[0].el.current) fail("重启后六环外证件丢失");
console.log("  ok   重启后仍显示 " + j.summary.vehicles + " 辆车，六环外 " + j.vehicles[0].el.current.validFrom + "~" + j.vehicles[0].el.current.validTo);
' "$AFTER"
if [ $? -eq 0 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi
check "重启后可直接读取原始响应" 200 "$(code "http://127.0.0.1:$PORT/api/users/$USER_ID/raw")"

echo
echo "== 通过 $PASS 项，失败 $FAIL 项 =="
[ "$FAIL" -eq 0 ]
