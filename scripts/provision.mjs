import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { Engine, engineOrigin } from "../src/engine.mjs";
import { actorNames, closureSchema, dispatchFlow, dispositionFlow, flowNames, statisticsFlow } from "../src/workflows.mjs";

const origin = engineOrigin(process.env.ALARM_ENGINE_ORIGIN);
assert.equal(process.env.ALARM_CONFIRM_ENGINE, origin, "ALARM_CONFIRM_ENGINE 须等于将创建演练数据的 origin");
const root = resolve(process.env.ALARM_SETUP_DIR ?? "runtime/setup");
mkdirSync(root, { recursive: true, mode: 0o700 });
const load = (name, fallback) => existsSync(join(root, name)) ? JSON.parse(readFileSync(join(root, name), "utf8")) : fallback;
function save(name, value) {
  const path = join(root, name);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
const plan = load("setup.json", { origin, tag: randomBytes(6).toString("hex"), workflows: {} });
assert.equal(plan.origin, origin);
assert.match(plan.tag, /^[a-f0-9]{12}$/);
save("setup.json", plan);
const logins = load("accounts.json", Object.fromEntries(Object.entries(actorNames).map(([role, name]) => [role, {
  username: `alarm_${plan.tag}_${role}`, password: randomBytes(24).toString("base64url"), name,
}])));
save("accounts.json", logins);
const supplied = process.env.ALARM_ADMIN_USERNAME && process.env.ALARM_ADMIN_PASSWORD
  ? { username: process.env.ALARM_ADMIN_USERNAME, password: process.env.ALARM_ADMIN_PASSWORD }
  : JSON.parse(readFileSync(0, "utf8"));
const admin = new Engine(origin);
const code = `ALARM_DEMO_${plan.tag.toUpperCase()}`;
const name = "设备报警处置演练";
const requestKey = key => `alarm_demo_${plan.tag}_${key}`;
let stage = "登录流程引擎";

async function publish(type, definition) {
  const { id } = await admin.write("project.createWorkflow", {
    projectId: plan.projectId, name: flowNames[type], flowType: type, definition, requestKey: requestKey(type),
  });
  assert(!plan.workflows[type] || plan.workflows[type] === id);
  plan.workflows[type] = id;
  save("setup.json", plan);
  let flow = await admin.read("workflow.get", { id });
  assert(flow.projectId === plan.projectId && flow.flowType === type && !flow.archivedAt);
  if (flow.status === "published" && flow.auditStatus === "approved") return flow;
  const compiled = await admin.write("workflow.compile", { id });
  assert(compiled.ok, compiled.diagnostics?.map(item => item.message).join("；"));
  if (flow.auditStatus !== "approved") {
    await admin.write("project.auditWorkflow", { projectId: plan.projectId, workflowId: id, auditStatus: "approved",
      expectedAuditStatus: flow.auditStatus, expectedDefinitionVersion: flow.definitionVersion });
    flow = await admin.read("workflow.get", { id });
  }
  await admin.write("workflow.publish", { id, expectedDefinitionVersion: flow.definitionVersion });
  return admin.read("workflow.get", { id });
}

try {
  const adminUser = await admin.write("auth.login", supplied);
  assert.equal(adminUser.role, "admin", "此命令需要管理员创建演练账号与项目");
  stage = "创建独立测试项目";
  const original = (await admin.read("project.list")).find(item => item.code === code && item.name === name && item.status === "active");
  assert(!plan.projectId || plan.projectId === original?.id);
  plan.projectId = original?.id ?? (await admin.write("project.create", {
    code, name, description: "设备报警处置演练。控制流程分级派发，状态子流程办理，数据流程读取结案快照生成统计。",
  })).id;
  save("setup.json", plan);
  console.log(JSON.stringify({ stage, projectId: plan.projectId, code }));

  stage = "配置三个演练办理人";
  const actors = {};
  for (const [role, login] of Object.entries(logins)) {
    const member = new Engine(origin);
    let identity;
    try {
      identity = await member.write("auth.login", { username: login.username, password: login.password });
    } catch (error) {
      if (error.status !== 401) throw error;
    }
    if (!identity) {
      const { userId } = await admin.write("iam.createUser", { ...login, role: "user" });
      identity = await member.write("auth.login", { username: login.username, password: login.password });
      assert.equal(identity.id, userId);
    }
    assert.equal(identity.role, "user");
    actors[role] = identity.id;
    await member.write("auth.logout");
    await admin.write("project.grantMember", { projectId: plan.projectId, userId: identity.id, role: "operator" });
    if (role === "reviewer") await admin.write("project.grantMember", { projectId: plan.projectId, userId: identity.id, role: "designer" });
  }

  stage = "发布状态流程";
  const child = await publish("state", dispositionFlow(actors));
  assert(child.publishedExecutionPlanHash);
  stage = "发布控制流程并绑定子流程版本";
  const control = await publish("control", dispatchFlow(child));
  stage = "创建结案快照资源并发布数据流程";
  const { id: assetId } = await admin.write("data.createAsset", { projectId: plan.projectId, name: "报警结案快照",
    assetType: "dataset", schema: closureSchema, sample: [], requestKey: requestKey("asset") });
  const statistics = await publish("data", statisticsFlow(assetId));
  const config = { origin, projectId: plan.projectId, code, assetId, actors,
    workflows: { state: child.id, control: control.id, data: statistics.id } };
  for (const flow of [child, control, statistics]) assert(flow.status === "published" && flow.auditStatus === "approved");
  save("config.json", config);
  console.log(JSON.stringify({ projectId: config.projectId, code, workflows: config.workflows, versions: {
    state: child.definitionVersion, control: control.definitionVersion, data: statistics.definitionVersion,
  }, assetId }));
} catch (error) {
  console.error(`${stage}失败 ${error.engineMessage ?? error.message}`);
  process.exitCode = 1;
} finally {
  if (admin.token) await admin.write("auth.logout");
}
