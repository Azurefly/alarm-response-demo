import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Engine, RequestError, engineOrigin } from "./engine.mjs";
import { Ledger, recordId } from "./ledger.mjs";
import { business } from "./business.mjs";
import { actorNames } from "./workflows.mjs";

const configPath = resolve(process.env.ALARM_CONFIG_FILE ?? "runtime/setup/config.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const origin = engineOrigin(config.origin);
const port = Number(process.env.ALARM_PORT ?? 8080);
const listen = process.env.ALARM_BIND ?? "127.0.0.1";
const publicOrigin = engineOrigin(process.env.ALARM_PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`);
const prefix = process.env.ALARM_BASE_PATH ?? "/alarm-demo";
if (!/^\/[a-z0-9-]+$/.test(prefix)) throw new Error("ALARM_BASE_PATH 须为一级路径，例如 /alarm-demo");
const validId = id => typeof id === "string" && /^[a-zA-Z0-9_-]{8,64}$/.test(id);
if (![config.projectId, config.assetId, config.workflows.state, config.workflows.control, config.workflows.data].every(validId)) throw new Error("演练项目配置不完整");
const ledger = new Ledger(resolve(process.env.ALARM_LEDGER_FILE ?? "runtime/ledger.json"));
const demo = business(config, ledger);
const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.mjs", ["app.mjs", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);
const cookieName = "alarm_demo_session";
const cookieKey = `${cookieName}=`;
const secure = new URL(publicOrigin).protocol === "https:" ? "; Secure" : "";
const cookie = (token, expire = false) => `${cookieKey}${token}; Path=${prefix}/; HttpOnly; SameSite=Strict${secure}${expire ? "; Max-Age=0" : ""}`;
const statuses = new Set([400, 401, 403, 404, 409, 413, 429, 502]);

function json(res, status, value, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(value));
}

async function input(req) {
  if (!/^(application\/json)(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) throw new RequestError(400, "请求需要 JSON 内容。");
  let length = 0;
  const parts = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 16384) throw new RequestError(413, "输入超过 16 KB。");
    parts.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { throw new RequestError(400, "请求内容无法读取。"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RequestError(400, "请求正文须为对象。");
  return value;
}

function existing(type, id) {
  const record = ledger.get(type, id);
  if (!record) throw new RequestError(404, "该演练记录不存在。");
  return record;
}

async function membership(engine) {
  if (!engine.token) throw new RequestError(401, "请登录流程引擎账号。");
  const user = await engine.read("auth.me");
  if (!user?.id) throw new RequestError(401, "会话已过期，请重新登录。");
  const access = await engine.read("project.access", { projectId: config.projectId });
  const permissions = access.permissions ?? [];
  if (!access.exists || !permissions.includes("project:view")) throw new RequestError(403, "该账号没有报警演练项目权限。");
  const member = Object.entries(config.actors).find(([, id]) => Number(id) === Number(user.id))?.[0];
  const canRun = permissions.includes("project:workflow:run");
  return { id: user.id, name: user.name ?? user.username, role: actorNames[member] ?? "项目成员", canRun,
    canReport: canRun && permissions.includes("project:workflow:edit") };
}

function permit(allowed) {
  if (!allowed) throw new RequestError(403, "当前项目权限不支持这个操作。");
}

async function handle(req, res) {
  const url = new URL(req.url, publicOrigin);
  const method = req.method;
  if (url.pathname === prefix && method === "GET") {
    res.writeHead(308, { Location: `${prefix}/` });
    res.end();
    return;
  }
  if (!url.pathname.startsWith(`${prefix}/`)) throw new RequestError(404, "页面不存在。");
  const path = url.pathname.slice(prefix.length);
  if (method === "GET" && path === "/healthz") return json(res, 200, { ok: true });
  if (method === "GET" && files.has(path)) {
    const [file, contentType] = files.get(path);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(readFileSync(new URL(`../public/${file}`, import.meta.url)));
    return;
  }
  if (method === "POST" && req.headers.origin !== publicOrigin) throw new RequestError(403, "请在演练页面内提交请求。");
  if (!["GET", "POST"].includes(method)) throw new RequestError(404, "页面不存在。");
  const token = (req.headers.cookie ?? "").split(";").map(value => value.trim()).find(value => value.startsWith(cookieKey))?.slice(cookieKey.length);
  const engine = new Engine(origin, token);
  if (method === "POST" && path === "/api/login") {
    const { username, password } = await input(req);
    if (typeof username !== "string" || username.trim().length < 3 || username.length > 64 || typeof password !== "string" || password.length < 12 || password.length > 256) {
      throw new RequestError(400, "请填写正确的账号和密码。");
    }
    await engine.write("auth.login", { username, password });
    try {
      return json(res, 200, await membership(engine), { "Set-Cookie": cookie(engine.token) });
    } catch (error) {
      await engine.write("auth.logout").catch(() => undefined);
      throw error;
    }
  }
  if (method === "POST" && path === "/api/logout") {
    res.setHeader("Set-Cookie", cookie("", true));
    if (engine.token) await engine.write("auth.logout");
    return json(res, 200, { ok: true });
  }
  const user = await membership(engine);
  if (method === "GET" && path === "/api/session") {
    const flows = Object.fromEntries(Object.entries(config.workflows).map(([kind, id]) => [kind, `${origin}/#/flows/workflow/${id}/editor`]));
    return json(res, 200, { user, flows, projectUrl: `${origin}/#/flows/project/${config.projectId}` });
  }
  if (method === "GET" && path === "/api/alarms") return json(res, 200, await demo.allAlarms(engine));
  if (method === "POST" && path === "/api/alarms") {
    permit(user.canRun);
    const alarm = await demo.submit(engine, user, await input(req));
    return json(res, 202, { id: alarm.id, controlRunId: alarm.controlRunId });
  }
  const alarmPath = path.match(/^\/api\/alarms\/([a-f0-9-]+)(?:\/(task|retry))?$/i);
  if (alarmPath) {
    const [, id, action] = alarmPath;
    const alarm = existing("alarms", id);
    if (method === "GET" && !action) return json(res, 200, await demo.detail(engine, user, alarm));
    if (method === "POST" && action === "task") return json(res, 202, await demo.perform(engine, user, alarm, await input(req)));
    if (method === "POST" && action === "retry") {
      permit(user.canRun && user.id === alarm.ownerId);
      const saved = await demo.submit(engine, user, { id, ...alarm.fields });
      return json(res, 202, { id: saved.id, controlRunId: saved.controlRunId });
    }
  }
  if (method === "GET" && path === "/api/reports") {
    const report = ledger.list("reports")[0];
    if (!report) return json(res, 200, null);
    const result = await demo.reportView(engine, report);
    return json(res, 200, { ...result, canRetry: result.status === "reserved" && user.id === report.ownerId });
  }
  if (method === "POST" && path === "/api/reports") {
    permit(user.canReport);
    return json(res, 202, await demo.startReport(engine, user, recordId((await input(req)).id)));
  }
  const reportPath = path.match(/^\/api\/reports\/([a-f0-9-]+)$/i);
  if (method === "GET" && reportPath) return json(res, 200, await demo.reportView(engine, existing("reports", reportPath[1])));
  throw new RequestError(404, "页面不存在。");
}

createServer({ requestTimeout: 45000, headersTimeout: 10000 }, (req, res) => {
  res.setHeader("Content-Security-Policy", "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  void handle(req, res).catch(error => {
    const status = statuses.has(error.status) ? error.status : 500;
    if (status === 500) console.error("Demo request failed", error.name);
    if (!res.headersSent) json(res, status, { error: status === 500 ? "演练服务暂时无法处理请求。" : error.message });
    else if (!res.writableEnded) res.end();
  });
}).listen(port, listen, () => console.log(`Alarm Response Demo ${listen}:${port}${prefix}/`));
