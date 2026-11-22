import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Engine } from "../src/engine.mjs";

const base = new URL(process.env.ALARM_DEMO_URL);
assert(base.pathname.endsWith("/") && !base.username && !base.password);
const configs = JSON.parse(readFileSync(process.env.ALARM_CONFIG_FILE, "utf8"));
const accounts = JSON.parse(readFileSync(process.env.ALARM_ACCOUNTS_FILE, "utf8"));
const active = [];
const evidence = { projectId: configs.projectId, code: configs.code, workflows: configs.workflows, scenarios: [] };
let stage = "登录三个独立办理账号";

class DemoClient {
  cookie = "";
  async call(path, input) {
    const response = await fetch(new URL(`api/${path}`, base), { method: input === undefined ? "GET" : "POST", redirect: "error",
      headers: { "Content-Type": "application/json", Origin: base.origin, ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(20000) });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(`${path} HTTP ${response.status} ${result.error}`);
      error.status = response.status;
      throw error;
    }
    if (path === "login") this.cookie = response.headers.getSetCookie().find(value => value.startsWith("alarm_demo_session="))?.split(";", 1)[0];
    return result;
  }
}

async function wait(label, read, until) {
  const limit = Date.now() + 30000;
  let latest;
  do {
    latest = await read();
    if (until(latest)) return latest;
    assert(latest?.phase !== "运行异常" && !["failed", "cancelled"].includes(latest?.status), `${label}提前结束`);
    await delay(400);
  } while (Date.now() < limit);
  throw new Error(`${label}等待超时，阶段 ${latest?.phase ?? latest?.status ?? "unknown"}`);
}

try {
  const members = {};
  for (const [name, credentials] of Object.entries(accounts)) {
    const actor = new DemoClient();
    const { id } = await actor.call("login", { username: credentials.username, password: credentials.password });
    assert(actor.cookie && id === configs.actors[name]);
    members[name] = actor;
    active.push(actor);
  }
  const { duty, technician, reviewer } = members;
  await assert.rejects(() => duty.call("reports", { id: randomUUID() }), { status: 403 });

  async function open(title, severity, device) {
    const input = { id: randomUUID(), title, severity, device, zone: "设备演练区", description: "合成设备报警，用于验证完整业务流转。" };
    const receipts = await Promise.all([duty.call("alarms", input), duty.call("alarms", input)]);
    assert.equal(receipts[0].id, input.id);
    assert(receipts[0].controlRunId);
    assert.deepEqual(receipts[0], receipts[1]);
    const path = `alarms/${input.id}`;
    const pending = await wait("派发值班员", () => duty.call(path), value => value.task?.nodeId === "triage");
    assert.equal(pending.parentStatus, "waiting");
    assert.equal(pending.phase, "待确认");
    assert.equal(pending.route, severity === "high" ? "紧急派发" : "常规派发");
    assert.equal(pending.responseMinutes, severity === "high" ? 15 : 60);
    assert.equal(pending.childVersion, 2);
    assert.equal((await technician.call(path)).task, null);
    return { path, id: input.id, first: pending };
  }

  async function handle(actor, item, nodeId, action, comment) {
    const pending = await wait(nodeId, () => actor.call(item.path), value => value.task?.nodeId === nodeId);
    const receipt = await actor.call(`${item.path}/task`, { taskId: pending.task.id, action, comment });
    assert.equal(receipt.taskId, pending.task.id);
  }

  async function close(item, state, expected) {
    const done = await wait("父子完成", () => duty.call(item.path), value => value.terminal);
    assert(done.parentStatus === "success" && done.childStatus === "success" && done.phase === state);
    assert.deepEqual(done.timeline.map(value => value.state), expected);
    assert(done.elapsedSeconds >= 0);
    evidence.scenarios.push({ id: item.id, route: done.route, resolution: state, controlRunId: done.controlRunId,
      stateRunId: done.stateRunId, timeline: expected, elapsedSeconds: done.elapsedSeconds });
  }

  stage = "高优先级确认、处置、复核关闭";
  const high = await open("冷却泵轴承温度越限", "high", "PUMP-C07");
  await assert.rejects(() => technician.call(`${high.path}/task`, { taskId: high.first.task.id, action: "confirmed" }), { status: 409 });
  await handle(duty, high, "triage", "confirmed", "核实温度异常");
  await handle(technician, high, "fix", "handled", "完成散热检查，采样恢复正常");
  await handle(reviewer, high, "verify", "closed", "复核温度趋势，设备已恢复");
  await close(high, "已关闭", ["待确认", "处置中", "待复核", "已关闭"]);

  stage = "常规报警误报关闭";
  const normal = await open("温湿度传感器通信离线", "normal", "SENSOR-B12");
  await assert.rejects(() => duty.call(`${normal.path}/task`, { taskId: normal.first.task.id, action: "falseAlarm", comment: "" }), { status: 400 });
  await handle(duty, normal, "triage", "falseAlarm", "网关维护引起的短暂离线，经核实为误报");
  await close(normal, "误报关闭", ["待确认", "误报关闭"]);

  stage = "复核退回并升级结案";
  const rework = await open("配电柜风机反馈异常", "normal", "FAN-E02");
  await handle(duty, rework, "triage", "confirmed", "反馈值异常");
  await handle(technician, rework, "fix", "handled", "初次检查并重启设备");
  await handle(reviewer, rework, "verify", "rework", "观察到反馈信号仍有间断");
  await handle(technician, rework, "fixAgain", "handled", "补充供电及通信检查记录");
  await handle(reviewer, rework, "verifyAgain", "escalated", "转入设备维修演练队列");
  await close(rework, "升级结案", ["待确认", "处置中", "待复核", "退回处置", "待再次复核", "升级结案"]);

  stage = "同步真实结案记录并执行数据流程";
  const started = await reviewer.call("reports", { id: randomUUID() });
  const finished = await wait("结案统计", () => reviewer.call(`reports/${started.id}`), value => value.status === "success");
  assert.equal(finished.rows.reduce((sum, row) => sum + row.alarmCount, 0), finished.rowCount);
  for (const [level, outcome] of [["high", "已关闭"], ["normal", "误报关闭"], ["normal", "升级结案"]]) {
    assert(finished.rows.some(row => row.severity === level && row.resolution === outcome && row.alarmCount > 0));
  }
  const client = new Engine(configs.origin);
  await client.write("auth.login", { username: accounts.reviewer.username, password: accounts.reviewer.password });
  try {
    const data = await client.read("data.runDetail", { projectId: configs.projectId, runId: finished.runId });
    assert.equal(data.status, "success");
    assert.deepEqual(data.nodeRuns.map(item => item.nodeId), ["start", "fields", "quality", "groups", "output"]);
    const inputRows = data.nodeRuns.find(item => item.nodeId === "fields").output.rows;
    for (const item of evidence.scenarios) {
      const source = inputRows.find(row => row.alarmId === item.id);
      assert(source?.resolution === item.resolution && source.elapsedSeconds === item.elapsedSeconds);
    }
    const lineage = await client.read("data.runLineage", { projectId: configs.projectId, runId: data.id });
    assert(lineage.artifacts.length >= 5);
    evidence.report = { runId: data.id, count: finished.rowCount, groups: finished.rows, artifacts: lineage.artifacts.length };
  } finally { await client.write("auth.logout"); }
  evidence.passed = true;
  console.log(JSON.stringify(evidence));
} catch (error) {
  console.error(JSON.stringify({ stage, error: error.message, evidence }));
  process.exitCode = 1;
} finally {
  for (const client of active) await client.call("logout", {}).catch(() => { process.exitCode = 1; });
}
