import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { alarmInput, digest, Ledger } from "../src/ledger.mjs";
import { business } from "../src/business.mjs";

const configuration = { projectId: "project-1", origin: "https://engine.example.test", assetId: "asset-1", workflows: {
  state: "state-1", control: "control-1", data: "data-1",
} };
const sample = { title: " 冷却泵高温 ", device: "P-01", zone: "东区", severity: "high", description: "合成数据" };

function fresh(t) {
  const dir = mkdtempSync(join(tmpdir(), "alarm-demo-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "ledger.json");
}

test("标准化报警字段并拦截无效等级及空标题", () => {
  assert.equal(alarmInput(sample).title, "冷却泵高温");
  assert.throws(() => alarmInput({ ...sample, severity: "unknown" }), { status: 400 });
  assert.throws(() => alarmInput({ ...sample, title: " " }), { status: 400 });
});

test("提交编号在重启后仍匹配同一内容和操作员", t => {
  const path = fresh(t);
  const id = randomUUID();
  const original = new Ledger(path).reserveAlarm(id, 4, alarmInput(sample));
  const ledger = new Ledger(path);
  assert.deepEqual(ledger.reserveAlarm(id, 4, alarmInput(sample)), original);
  assert.throws(() => ledger.reserveAlarm(id, 5, alarmInput(sample)), { status: 409 });
  assert.throws(() => ledger.reserveAlarm(id, 4, alarmInput({ ...sample, zone: "西区" })), { status: 409 });
  assert.equal(ledger.list("alarms").length, 1);
});

test("并行重复提交共享同一引擎运行回执", async t => {
  const ledger = new Ledger(fresh(t));
  const app = business(configuration, ledger);
  const calls = [];
  const engine = { async write(procedure, input) {
    calls.push([procedure, input]);
    if (procedure === "workflow.runReadiness") return { canStart: true, executionSource: "published_plan", definitionVersion: 2, planHash: "plan" };
    return { runId: "engine-run" };
  } };
  const id = randomUUID();
  const results = await Promise.all([app.submit(engine, { id: 5 }, { ...sample, id }), app.submit(engine, { id: 5 }, { ...sample, id })]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].controlRunId, "engine-run");
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1].idempotencyKey, `alarm-demo-${id}`);
});

test("结案只取引擎父子均成功且一致的回执", async t => {
  const ledger = new Ledger(fresh(t));
  const app = business(configuration, ledger);
  const id = randomUUID();
  const alarm = ledger.put("alarms", { ...ledger.reserveAlarm(id, 5, alarmInput(sample)), controlRunId: "parent" });
  const base = { status: "success", inputJson: { alarmId: id }, createdAt: "2026-11-21T08:00:00Z", finishedAt: "2026-11-21T08:00:10Z" };
  const parent = { ...base, id: "parent", workflowId: configuration.workflows.control, finalOutputJson: { result: { resolution: "已关闭" } },
    childLinks: [{ direction: "child", workflowId: configuration.workflows.state, runId: "child", version: 2 }] };
  const child = { ...base, id: "child", workflowId: configuration.workflows.state, currentStateName: "已关闭", nodeRuns: [], stateTransitions: [] };
  const engine = { async read(_name, input) { return input.runId === "parent" ? parent : child; } };
  const result = await app.detail(engine, { id: 5 }, alarm);
  assert.equal(result.terminal, true);
  assert.equal(result.elapsedSeconds, 10);
  assert.equal(ledger.get("alarms", id).finished.childVersion, 2);
});

test("数据节点读取的样本偏离快照时保存失败结果", async t => {
  const ledger = new Ledger(fresh(t));
  const app = business(configuration, ledger);
  const rows = [{ alarmId: randomUUID(), severity: "high", resolution: "已关闭", elapsedSeconds: 10 }];
  const report = { id: randomUUID(), runId: "data-run", createdAt: "2026-11-21T08:00:00Z", rows, hash: digest(rows) };
  const result = await app.reportView({ async read() {
    return { id: "data-run", status: "success", workflowId: configuration.workflows.data, input: { snapshotHash: report.hash }, nodeRuns: [] };
  } }, report);
  assert.equal(result.status, "failed");
  assert.match(result.message, /快照不一致/);
  assert.deepEqual(ledger.get("reports", report.id).result, result);
});
