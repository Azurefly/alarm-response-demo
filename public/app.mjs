const $ = id => document.getElementById(id);
const closed = new Set(["已关闭", "误报关闭", "升级结案"]);
let session, selected, alarms = [], report, refreshInFlight, detailKey, requestId;
let generation = 0;
let noticeTimer;
const time = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const displayTime = value => value && Number.isFinite(Date.parse(value)) ? time.format(new Date(value)) : "—";
const severity = value => value === "high" ? "高优先级" : "常规";

async function request(path, data) {
  const options = data === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  };
  const response = await fetch(`./api/${path}`, { ...options, signal: AbortSignal.timeout(30000) });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error ?? "请求失败，请稍后重试。");
    error.status = response.status;
    throw error;
  }
  return result;
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(label, action, primary = false) {
  const control = element("button", label, primary ? "primary" : undefined);
  control.type = "button";
  control.addEventListener("click", action);
  return control;
}

function link(label, url) {
  const anchor = element("a", label + " ↗");
  anchor.href = url;
  anchor.target = "_blank";
  anchor.rel = "noopener";
  return anchor;
}

function notice(text) {
  clearTimeout(noticeTimer);
  $("notice").textContent = text;
  $("notice").hidden = false;
  noticeTimer = setTimeout(() => { $("notice").hidden = true; }, 4300);
}

function formError(id, message = "") {
  $(id).textContent = message;
  $(id).hidden = !message;
}

function closeSession() {
  generation++;
  session = undefined;
  report = undefined;
  alarms = [];
  detailKey = undefined;
  refreshInFlight = undefined;
  $("session-bar").hidden = true;
  $("workspace").hidden = true;
  $("login").hidden = false;
  if ($("alarm-dialog").open) $("alarm-dialog").close();
}

async function busy(control, run, onError = error => notice(error.message)) {
  if (control.disabled) return;
  control.disabled = true;
  try {
    await run();
  } catch (error) {
    if (session && error.status === 401) closeSession();
    onError(error);
  } finally {
    control.disabled = false;
  }
}

function select(id) {
  selected = id;
  detailKey = undefined;
  if (id) history.replaceState(null, "", `#${id}`);
  paintAlarms();
  void loadDetail().catch(error => notice(error.message));
}

function paintAlarms() {
  const filter = $("filter").value;
  const items = alarms.filter(item => filter === "all" || (filter === "closed" ? item.terminal : !item.terminal));
  $("total").textContent = alarms.length;
  $("closed").textContent = alarms.filter(item => item.terminal).length;
  $("open").textContent = alarms.filter(item => !item.terminal).length;
  $("list-empty").hidden = Boolean(items.length);
  $("alarm-rows").replaceChildren(...items.map(item => {
    const row = element("tr", undefined, item.id === selected ? "selected" : undefined);
    const name = button(item.fields.title, () => select(item.id));
    name.className = "row-name";
    if (item.id === selected) name.setAttribute("aria-current", "true");
    const title = element("td");
    title.append(name, element("p", `${item.fields.device} · ${item.fields.zone}`, "row-sub"));
    const grade = element("td");
    grade.append(element("span", severity(item.fields.severity), `badge ${item.fields.severity}`));
    const phase = element("td");
    phase.append(element("span", item.phase, `badge${item.terminal ? " done" : ""}`));
    row.append(title, grade, phase, element("td", displayTime(item.createdAt), "when"));
    return row;
  }));
}

function paintTask(item) {
  const { task } = item;
  const panel = element("section", undefined, "task-panel");
  panel.append(element("h3", task.name), element("p", task.instruction));
  const label = element("label", "处理意见");
  const comment = element("textarea");
  comment.rows = 2;
  comment.maxLength = 1000;
  label.append(comment);
  const actions = element("div", undefined, "toolbar");
  for (const choice of task.outcomes) {
    const control = button(choice.label, () => {
      if (choice.requireComment && !comment.value.trim()) {
        notice("请填写处理意见。");
        comment.focus();
        return;
      }
      void busy(control, async () => {
        await request(`alarms/${item.id}/task`, { taskId: task.id, action: choice.code, comment: comment.value });
        notice("办理已提交，等待流程推进。");
        await refresh();
      });
    }, choice.decision === "approved");
    actions.append(control);
  }
  panel.append(label, actions);
  return panel;
}

function paintDetail(item) {
  const signature = JSON.stringify(item);
  if (signature === detailKey) return;
  detailKey = signature;
  const body = $("alarm-detail");
  $("detail-phase").replaceChildren(element("span", item.phase, `badge${closed.has(item.phase) ? " done" : ""}`));
  const meta = element("div", undefined, "alarm-meta");
  meta.append(element("span", severity(item.fields.severity), `badge ${item.fields.severity}`),
    element("span", `${item.fields.device} · ${item.fields.zone}`, "badge"));
  if (item.route) meta.append(element("span", `${item.route} · 响应目标 ${item.responseMinutes} 分钟`, "badge"));
  body.replaceChildren(element("h3", item.fields.title), meta, element("p", item.fields.description || "暂无现场描述"));
  if (item.timeline.length) {
    const timeline = element("ol", undefined, "timeline");
    timeline.setAttribute("aria-label", "业务状态记录");
    for (const step of item.timeline) timeline.append(element("li", step.state));
    body.append(timeline);
  }
  if (item.controlUrl || item.stateUrl) {
    const links = element("div", undefined, "run-links");
    if (item.controlUrl) links.append(link("控制实例", item.controlUrl));
    if (item.stateUrl) links.append(link("状态实例", item.stateUrl));
    body.append(links);
  }
  if (item.task) body.append(paintTask(item));
  if (item.operations.length) {
    const records = element("ol", undefined, "operations");
    for (const operation of item.operations) records.append(element("li", `${operation.name}${operation.comment ? ` · ${operation.comment}` : ""}`));
    body.append(element("h3", "办理记录"), records);
  }
  if (item.canRetry) {
    const retry = button("继续派发", () => void busy(retry, async () => {
      await request(`alarms/${item.id}/retry`, {});
      await refresh();
    }, error => notice(error.message)));
    body.append(retry);
  }
}

async function loadDetail() {
  if (!selected) {
    $("alarm-detail").replaceChildren(element("p", "请选择一条报警。", "empty"));
    $("detail-phase").replaceChildren();
    return;
  }
  const id = selected;
  const current = generation;
  const detail = await request(`alarms/${id}`);
  if (selected === id && generation === current) paintDetail(detail);
}

function paintReport() {
  const container = $("report-content");
  if (!report) return container.replaceChildren(element("p", "暂无统计。", "empty"));
  const meta = element("div", undefined, "report-meta");
  const labels = { reserved: "待提交", queued: "排队中", running: "统计中", success: "已生成", failed: "执行失败", cancelled: "已取消" };
  meta.append(element("span", labels[report.status] ?? report.status, "badge"), element("span", `${report.rowCount} 条结案记录`));
  if (report.url) meta.append(link("数据实例", report.url));
  container.replaceChildren(meta);
  if (report.message) container.append(element("p", report.message, "empty"));
  if (report.rows?.length) {
    const table = element("table");
    const head = table.createTHead().insertRow();
    for (const text of ["等级", "结案结果", "报警数量", "平均耗时（秒）"]) head.append(element("th", text));
    const body = table.createTBody();
    for (const item of report.rows) {
      const row = body.insertRow();
      for (const value of [severity(item.severity), item.resolution, item.alarmCount, Number(item.averageSeconds).toFixed(1)]) row.append(element("td", String(value)));
    }
    container.append(table);
  }
  $("generate-report").textContent = report.canRetry ? "继续生成" : "生成统计";
}

function refresh() {
  if (refreshInFlight) return refreshInFlight;
  const current = generation;
  const operation = (async () => {
    const [list, stats] = await Promise.all([request("alarms"), request("reports")]);
    if (generation !== current) return;
    alarms = list;
    report = stats;
    if (!alarms.some(item => item.id === selected)) selected = alarms[0]?.id;
    paintAlarms();
    paintReport();
    await loadDetail();
  })().catch(error => {
    if (error.status === 401 && session) closeSession();
    throw error;
  }).finally(() => { if (refreshInFlight === operation) refreshInFlight = undefined; });
  refreshInFlight = operation;
  return operation;
}

async function openSession() {
  const details = await request("session");
  session = details.user;
  generation++;
  $("login").hidden = true;
  $("workspace").hidden = false;
  $("session-bar").hidden = false;
  $("session-name").textContent = session.name;
  $("new-alarm").hidden = !session.canRun;
  $("generate-report").hidden = !session.canReport;
  $("project-link").href = details.projectUrl;
  for (const [kind, url] of Object.entries(details.flows)) $(`flow-${kind}`).href = url;
  const hash = location.hash.slice(1);
  selected = /^[a-f0-9-]{36}$/.test(hash) ? hash : undefined;
  await refresh();
}

$("login-form").addEventListener("submit", event => {
  event.preventDefault();
  const form = event.currentTarget;
  formError("login-error");
  void busy(event.submitter, async () => {
    await request("login", Object.fromEntries(new FormData(form)));
    form.reset();
    await openSession();
  }, error => formError("login-error", error.status === 401 ? "账号或密码有误，或账号已停用。" : error.message));
});
$("logout").addEventListener("click", () => void busy($("logout"), async () => {
  await request("logout", {});
  closeSession();
  $("login-form").elements.username.focus();
}));
$("refresh").addEventListener("click", () => void busy($("refresh"), refresh));
$("filter").addEventListener("change", paintAlarms);
$("new-alarm").addEventListener("click", () => {
  requestId = crypto.randomUUID();
  $("alarm-form").reset();
  formError("alarm-error");
  $("alarm-dialog").showModal();
});
$("close-alarm").addEventListener("click", () => $("alarm-dialog").close());
const samples = {
  high: { title: "冷却泵轴承温度越限", device: "PUMP-C07", zone: "动力站 A 区", severity: "high", description: "演练数据。温度读数连续三次超过设备阈值，请现场核实。" },
  normal: { title: "温湿度传感器通信离线", device: "SENSOR-B12", zone: "仓储 B 区", severity: "normal", description: "演练数据。采集网关未收到周期心跳，请核对设备状态。" },
};
document.querySelectorAll("[data-sample]").forEach(control => control.addEventListener("click", () => {
  for (const [key, value] of Object.entries(samples[control.dataset.sample])) $("alarm-form").elements[key].value = value;
}));
$("alarm-form").addEventListener("submit", event => {
  event.preventDefault();
  const fields = Object.fromEntries(new FormData(event.currentTarget));
  formError("alarm-error");
  void busy(event.submitter, async () => {
    const accepted = await request("alarms", { id: requestId, ...fields });
    $("alarm-dialog").close();
    selected = accepted.id;
    history.replaceState(null, "", `#${accepted.id}`);
    await refresh();
    notice("报警已接单，等待引擎派发。");
  }, error => formError("alarm-error", error.message));
});
$("generate-report").addEventListener("click", () => void busy($("generate-report"), async () => {
  const id = report?.canRetry ? report.id : crypto.randomUUID();
  report = await request("reports", { id });
  paintReport();
  notice("统计已提交。");
}));

void openSession().catch(error => { if (error.status !== 401) formError("login-error", error.message); });
setInterval(() => { if (session && !document.hidden) void refresh().catch(error => notice(error.message)); }, 5000);
