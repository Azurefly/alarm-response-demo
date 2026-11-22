import { RequestError } from "./engine.mjs";
import { alarmInput, digest, recordId } from "./ledger.mjs";
import { closedStates } from "./workflows.mjs";

const parse = value => typeof value === "string" ? JSON.parse(value) : value;
const failedStatuses = new Set(["failed", "terminated", "cancelled", "blocked", "suspended"]);
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));

export function business(config, ledger) {
  const { projectId, workflows, origin, assetId } = config;
  const inflight = new Map();
  let activeReport;
  const runLink = (flow, runId) => `${origin}/#/runs/monitor/${encodeURIComponent(workflows[flow])}/${encodeURIComponent(runId)}`;
  function single(key, action) {
    if (!inflight.has(key)) inflight.set(key, Promise.resolve().then(action).finally(() => inflight.delete(key)));
    return inflight.get(key);
  }

  async function submit(engine, user, input) {
    const id = recordId(input.id);
    const alarm = ledger.reserveAlarm(id, user.id, alarmInput(input));
    if (alarm.controlRunId) return alarm;
    return single(id, async () => {
      const data = { alarmId: id, ...alarm.fields };
      const workflowId = workflows.control;
      const ready = await engine.write("workflow.runReadiness", { workflowId, mode: "formal", input: data });
      if (!ready.canStart || ready.executionSource !== "published_plan") throw new RequestError(409, "已发布的报警派发流程当前不可运行，请核对父子流程配置。");
      const receipt = await engine.write("workflow.run", { workflowId, input: data, idempotencyKey: `alarm-demo-${id}`,
        expectedDefinitionVersion: ready.definitionVersion, expectedExecutionPlanHash: ready.planHash });
      return ledger.put("alarms", { ...alarm, controlRunId: receipt.runId });
    });
  }

  async function series(engine, alarm) {
    if (alarm.finished) return alarm.finished;
    if (!alarm.controlRunId) return { phase: "待提交", timeline: [], operations: [] };
    const parent = await engine.read("workflow.runDetail", { runId: alarm.controlRunId });
    if (parent.workflowId !== workflows.control || parse(parent.inputJson)?.alarmId !== alarm.id) throw new RequestError(502, "派发回执与报警编号不一致。");
    const links = parent.childLinks.filter(item => item.direction === "child" && item.workflowId === workflows.state);
    if (links.length > 1) throw new RequestError(502, "演练报警出现了多条处置实例，请查看派发记录。");
    const link = links[0];
    const child = link ? await engine.read("workflow.runDetail", { runId: link.runId }) : null;
    if (child && (child.workflowId !== workflows.state || parse(child.inputJson)?.alarmId !== alarm.id)) throw new RequestError(502, "处置实例与报警编号不一致。");
    const childInput = child ? parse(child.inputJson) : {};
    const timeline = (child?.stateTransitions ?? []).map(item => ({ state: parse(item.payloadJson)?.stateName, at: item.createdAt ?? item.occurredAt }));
    const operations = (child?.nodeRuns ?? []).filter(node => node.nodeType === "operate" && node.status === "success").map(node => {
      const output = parse(node.outputJson);
      return { nodeId: node.nodeId, name: node.nodeName, action: output?.outcome, comment: output?.result?.comment ?? "", at: node.finishedAt };
    });
    const final = parent.status === "success" && child?.status === "success" && closedStates.includes(child.currentStateName);
    const elapsedSeconds = final ? Math.max(0, Math.round((Date.parse(parent.finishedAt) - Date.parse(parent.createdAt)) / 1000)) : null;
    if (final && (parse(parent.finalOutputJson)?.result?.resolution !== child.currentStateName || !Number.isFinite(elapsedSeconds))) {
      throw new RequestError(502, "派发回执与处置结案状态不一致，请查看实例。");
    }
    const snapshot = { phase: failedStatuses.has(parent.status) || failedStatuses.has(child?.status) ? "运行异常" : child?.currentStateName ?? "派发中",
      parentStatus: parent.status, childStatus: child?.status ?? null, stateRunId: child?.id ?? null,
      childVersion: link?.version ?? null, route: childInput.route ?? null, responseMinutes: childInput.responseMinutes ?? null,
      terminal: final, elapsedSeconds, timeline, operations, controlUrl: runLink("control", parent.id),
      stateUrl: child ? runLink("state", child.id) : null };
    if (final) ledger.put("alarms", { ...alarm, finished: snapshot });
    return snapshot;
  }

  async function detail(engine, user, alarm) {
    const snapshot = await series(engine, alarm);
    const current = snapshot.stateRunId && !snapshot.terminal
      ? (await engine.read("task.list", { projectId, runId: snapshot.stateRunId, view: "todo", limit: 10 }))
        .find(item => item.canAct && item.workflowId === workflows.state)
      : null;
    const task = current ? { id: current.id, name: current.nodeName, nodeId: current.nodeId, instruction: current.instruction,
      outcomes: (parse(current.outcomeHandlesJson)?.outcomes ?? []).map(item => pick(item, ["code", "label", "decision", "requireComment"])) } : null;
    return { ...pick(alarm, ["id", "fields", "createdAt", "controlRunId"]), ...snapshot, task, canRetry: !alarm.controlRunId && user.id === alarm.ownerId };
  }

  async function perform(engine, user, alarm, input) {
    const { task } = await detail(engine, user, alarm);
    if (!task || task.id !== input.taskId) throw new RequestError(409, "当前账号的待办已变化，请刷新记录。");
    const outcome = task.outcomes.find(item => item.code === input.action);
    if (!outcome) throw new RequestError(400, "请选择待办允许的处理结果。");
    const comment = typeof input.comment === "string" ? input.comment.trim() : "";
    if (comment.length > 1000 || (outcome.requireComment && !comment)) throw new RequestError(400, "请填写处理意见，最多 1000 字。");
    await engine.write("task.execute", { taskId: task.id, result: { outcome: outcome.code, decision: outcome.decision, comment } });
    return { taskId: task.id, accepted: true };
  }

  // Read reconciled state only. Every result is obtained from the engine's published data flow.
  async function reportView(engine, report) {
    if (report.result) return report.result;
    const view = { id: report.id, createdAt: report.createdAt, rowCount: report.rows.length, runId: report.runId ?? null, status: "reserved" };
    if (!report.runId) return view;
    const run = await engine.read("data.runDetail", { projectId, runId: report.runId });
    if (!run || run.workflowId !== workflows.data || run.input?.snapshotHash !== report.hash) throw new RequestError(502, "统计回执与结案快照不一致。");
    Object.assign(view, { status: run.status, url: runLink("data", run.id) });
    if (run.status === "success") {
      const source = run.nodeRuns.find(node => node.nodeId === "fields")?.output?.rows;
      const ordered = value => value?.map(row => ({ alarmId: row.alarmId, severity: row.severity, resolution: row.resolution,
        elapsedSeconds: row.elapsedSeconds })).sort((a, b) => a.alarmId.localeCompare(b.alarmId));
      if (digest(ordered(source) ?? []) !== report.hash) {
        Object.assign(view, { status: "failed", message: "统计源与本次结案快照不一致，请重新生成。" });
        ledger.put("reports", { ...report, result: view });
        return view;
      }
      view.rows = run.output?.terminals?.find(item => item.outputName === "报警处置统计")?.rows ?? [];
      if (view.rows.reduce((count, row) => count + row.alarmCount, 0) !== report.rows.length) {
        Object.assign(view, { status: "failed", message: "数据流程汇总行数与结案快照不一致，请重新生成。" });
        delete view.rows;
      }
    }
    if (["success", "failed", "cancelled"].includes(run.status)) ledger.put("reports", { ...report, result: view });
    return view;
  }

  async function allAlarms(engine) {
    const items = ledger.list("alarms");
    const summaries = [];
    for (let index = 0; index < items.length; index += 6) {
      summaries.push(...await Promise.all(items.slice(index, index + 6).map(async alarm => {
        const snapshot = await series(engine, alarm);
        return { ...pick(alarm, ["id", "fields", "createdAt", "controlRunId"]), ...pick(snapshot, ["phase", "route", "terminal", "elapsedSeconds"]) };
      })));
    }
    return summaries;
  }

  async function startReport(engine, user, id) {
    const existing = ledger.get("reports", id);
    if (existing?.ownerId && existing.ownerId !== user.id) throw new RequestError(409, "统计请求属于另一位操作员。");
    if (activeReport && (activeReport.id !== id || activeReport.userId !== user.id)) throw new RequestError(409, "已有统计正在提交，请稍后刷新。");
    activeReport = { id, userId: user.id };
    return single(`statistics:${id}`, async () => {
      try {
        return await submitReport(engine, user, id);
      } finally {
        activeReport = undefined;
      }
    });
  }

  async function submitReport(engine, user, id) {
      const report = ledger.get("reports", id);
      if (report?.runId) return reportView(engine, report);
      const prior = ledger.list("reports").find(item => item.id !== id && !item.result);
      if (prior && !["success", "failed", "cancelled"].includes((await reportView(engine, prior)).status)) {
        throw new RequestError(409, "上一份统计正在处理。请刷新统计结果，或使用原请求继续。");
      }
      let reserved = report;
      if (!reserved) {
        const alarms = await allAlarms(engine);
        const rows = alarms.filter(item => item.terminal).map(item => ({ alarmId: item.id, severity: item.fields.severity,
          resolution: item.phase, elapsedSeconds: item.elapsedSeconds })).sort((a, b) => a.alarmId.localeCompare(b.alarmId));
        if (!rows.length) throw new RequestError(409, "请先处置或关闭至少一条报警。");
        reserved = ledger.put("reports", { id, ownerId: user.id, createdAt: new Date().toISOString(), rows, hash: digest(rows) });
      }
      await engine.write("data.updateAsset", { projectId, assetId, sample: reserved.rows });
      const workflowId = workflows.data;
      const ready = await engine.write("workflow.runReadiness", { workflowId, mode: "formal" });
      if (!ready.canStart || ready.executionSource !== "published_plan") throw new RequestError(409, "已发布的统计流程当前不可运行。");
      const launched = await engine.write("data.run", { projectId, workflowId, mode: "formal", data: { snapshotHash: reserved.hash, reportId: id },
        idempotencyKey: `alarm-report-${id}`, expectedDefinitionVersion: ready.definitionVersion, expectedExecutionPlanHash: ready.planHash });
      return reportView(engine, ledger.put("reports", { ...reserved, runId: launched.runId }));
  }

  return { submit, detail, perform, allAlarms, startReport, reportView };
}
