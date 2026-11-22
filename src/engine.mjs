export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function engineOrigin(value) {
  const url = new URL(value);
  if (url.username || url.password || url.href !== `${url.origin}/` ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("流程引擎地址须为 HTTPS origin 或本机回环 HTTP origin");
  }
  return url.origin;
}

export const sessionTokenPattern = /^[A-Za-z0-9_.~-]{20,2048}$/;
const statusMessage = new Map([
  [400, "流程引擎拒绝了本次输入，请核对办理结果。"], [401, "请重新登录。"],
  [403, "当前账号没有该项目或待办的操作权限。"], [404, "该流程记录不存在或当前账号无权查看。"],
  [409, "记录已更新，请刷新后再操作。"], [429, "请求频繁，请稍后重试。"],
]);

export class Engine {
  constructor(origin, token = "") {
    this.origin = engineOrigin(origin);
    this.token = sessionTokenPattern.test(token) ? token : "";
  }

  async call(procedure, input, write = false) {
    const payload = JSON.stringify({ json: input ?? null });
    let response;
    try {
      response = await fetch(`${this.origin}/api/trpc/${procedure}${write ? "" : `?input=${encodeURIComponent(payload)}`}`, {
        method: write ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(15000),
        headers: { "Content-Type": "application/json", ...(this.token ? { Cookie: `flow_session=${this.token}` } : {}) },
        body: write ? payload : undefined,
      });
    } catch {
      throw new RequestError(502, "暂时无法连接流程引擎。保留本次编号后可重试。");
    }
    const document = await response.json().catch(() => null);
    if (!response.ok || !document?.result || document.error) {
      const status = statusMessage.has(response.status) ? response.status : 502;
      const error = new RequestError(status, statusMessage.get(status) ?? "流程引擎暂时无法处理请求，请稍后重试。");
      // The provisioning CLI can display targeted structural diagnostics from the engine.
      error.engineMessage = document?.error?.json?.message;
      throw error;
    }
    if (procedure === "auth.login") {
      const cookie = response.headers.getSetCookie().find(value => value.startsWith("flow_session="));
      const token = cookie?.slice("flow_session=".length).split(";", 1)[0] ?? "";
      if (!sessionTokenPattern.test(token)) throw new RequestError(502, "流程引擎登录回执缺少有效会话。");
      this.token = token;
    }
    return document.result.data.json;
  }

  read(procedure, input) { return this.call(procedure, input); }
  write(procedure, input) { return this.call(procedure, input, true); }
}
