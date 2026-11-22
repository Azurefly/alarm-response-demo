const node = (id, type, name, x, y, config = {}) => ({ id, type, name, config, position: { x, y } });
const route = (from, to, handle = "default") => ({ id: `e-${from}-${to}-${handle}`, sourceNodeId: from, targetNodeId: to, sourceHandle: handle });
const graph = (nodes, edges) => ({ schemaVersion: 1, nodes, edges, viewport: { x: 0, y: 0, zoom: 1 }, settings: {} });
const state = (id, name, x, y) => node(id, "state", name, x, y, { nodeDh: id.toUpperCase(), jdmc: name, flowStatus: name, stateType: "business" });
const result = (code, label, decision, requireComment = false) => ({ code, label, decision, sourceHandle: code, requireComment });

export const flowNames = { state: "报警处置与复核", control: "报警分级与派发", data: "报警处置统计" };
export const actorNames = { duty: "演练值班员", technician: "演练处置员", reviewer: "演练复核员" };
export const closedStates = ["已关闭", "误报关闭", "升级结案"];

export function dispositionFlow(actors) {
  const operate = (id, name, actor, x, y, instruction, outcomes) => node(id, "operate", name, x, y, {
    nodeDh: id.toUpperCase(), czmc: name, pendingStatusName: name, assigneeMode: "user", assigneeUserId: actors[actor],
    assigneeFallback: "error", signMode: "single", instruction, outcomeMode: "explicit", outcomes,
  });
  const fix = result("handled", "提交处置记录", "approved", true);
  const pass = result("closed", "复核通过", "approved", true);
  const retry = result("rework", "退回重处置", "rejected", true);
  const escalate = result("escalated", "升级结案", "rejected", true);
  return graph([
    node("start", "start", "接收派发", 0, 50),
    state("confirmation", "待确认", 220, 50),
    operate("triage", "核实报警", "duty", 440, 50, "核对设备与现场现象，误报须说明原因。", [
      result("confirmed", "确认属实", "approved"), result("falseAlarm", "关闭误报", "rejected", true),
    ]),
    state("handling", "处置中", 660, 50),
    operate("fix", "记录处置", "technician", 880, 50, "填写检查、处置措施和恢复现象。", [fix]),
    state("verification", "待复核", 1100, 50),
    operate("verify", "复核恢复", "reviewer", 1320, 50, "核对恢复证据，填写复核意见。", [pass, retry]),
    state("closed", "已关闭", 2210, 50),
    state("falseAlarm", "误报关闭", 660, 520),
    state("returning", "退回处置", 1320, 310),
    operate("fixAgain", "补充处置", "technician", 1540, 310, "按第一次复核意见补充处置证据。", [fix]),
    state("reverification", "待再次复核", 1760, 310),
    operate("verifyAgain", "再次复核", "reviewer", 1980, 310, "记录通过或将这条演练报警升级结案。", [pass, escalate]),
    state("escalated", "升级结案", 2210, 310),
    node("done", "end", "结案回执", 2450, 150, { resultTemplate: {
      alarmId: "{{input.alarmId}}", severity: "{{input.severity}}", route: "{{input.route}}",
      resolution: "{{nodes.closed.displayName}}{{nodes.falseAlarm.displayName}}{{nodes.escalated.displayName}}",
    } }),
  ], [
    route("start", "confirmation"), route("confirmation", "triage"), route("triage", "handling", "confirmed"),
    route("triage", "falseAlarm", "falseAlarm"), route("falseAlarm", "done"),
    route("handling", "fix"), route("fix", "verification", "handled"), route("verification", "verify"),
    route("verify", "closed", "closed"), route("closed", "done"), route("verify", "returning", "rework"),
    route("returning", "fixAgain"), route("fixAgain", "reverification", "handled"), route("reverification", "verifyAgain"),
    route("verifyAgain", "closed", "closed"), route("verifyAgain", "escalated", "escalated"), route("escalated", "done"),
  ]);
}

export function dispatchFlow(child) {
  const call = (id, planId, name, y) => node(id, "subflow", name, 710, y, {
    executionMode: "durable_child", subflowId: child.id, childVersion: child.definitionVersion,
    childPlanHash: child.publishedExecutionPlanHash,
    input: { alarmId: "{{input.alarmId}}", title: "{{input.title}}", device: "{{input.device}}", zone: "{{input.zone}}",
      severity: "{{input.severity}}", description: "{{input.description}}",
      route: `{{nodes.${planId}.route}}`, responseMinutes: `{{nodes.${planId}.responseMinutes}}` },
  });
  return graph([
    node("start", "start", "接收设备报警", 0, 140),
    node("grade", "condition", "是否高优先级", 230, 140, { left: "{{input.severity}}", operator: "equals", right: "high" }),
    node("urgentPlan", "transform", "紧急派发 · 15 分钟", 470, 35, { mappings: { route: "紧急派发", responseMinutes: 15 } }),
    node("normalPlan", "transform", "常规派发 · 60 分钟", 470, 265, { mappings: { route: "常规派发", responseMinutes: 60 } }),
    call("urgentCall", "urgentPlan", "启动紧急处置", 35), call("normalCall", "normalPlan", "启动常规处置", 265),
    node("end", "end", "接收结案回执", 980, 140, { resultTemplate: {
      alarmId: "{{input.alarmId}}",
      route: "{{nodes.urgentCall.result.route}}{{nodes.normalCall.result.route}}",
      resolution: "{{nodes.urgentCall.result.resolution}}{{nodes.normalCall.result.resolution}}",
    } }),
  ], [route("start", "grade"), route("grade", "urgentPlan", "true"), route("grade", "normalPlan", "false"),
    route("urgentPlan", "urgentCall"), route("normalPlan", "normalCall"), route("urgentCall", "end"), route("normalCall", "end")]);
}

export const closureSchema = [
  { name: "alarmId", type: "string" }, { name: "severity", type: "string" },
  { name: "resolution", type: "string" }, { name: "elapsedSeconds", type: "number" },
];

export function statisticsFlow(assetId) {
  const names = ["alarmId", "severity", "resolution", "elapsedSeconds"];
  return graph([
    node("start", "start", "开始统计", 0, 110),
    node("fields", "source", "读取结案快照", 230, 110, { assetId, columns: names, limit: 200 }),
    node("quality", "quality_gate", "校验结案记录", 460, 110, { minRows: 1, maxNullRate: 0 }),
    node("groups", "aggregate", "按等级和结果汇总", 690, 110, { groupBy: ["severity", "resolution"], metrics: [
      { name: "alarmCount", operation: "count" }, { name: "averageSeconds", operation: "avg", field: "elapsedSeconds" },
    ] }),
    node("output", "output", "报警处置统计", 920, 110, { outputName: "报警处置统计" }),
  ], [route("start", "fields"), route("fields", "quality"), route("quality", "groups"), route("groups", "output")]);
}
