import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { RequestError } from "./engine.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function recordId(input) {
  if (typeof input !== "string" || !uuid.test(input)) throw new RequestError(400, "记录编号格式无效。");
  return input.toLowerCase();
}

function field(input, label, maximum, required = true) {
  const value = typeof input === "string" ? input.trim() : "";
  if (value.length > maximum || (required && !value)) throw new RequestError(400, `${label}须填写，且最多 ${maximum} 字。`);
  return value;
}

export function alarmInput(value) {
  if (!["high", "normal"].includes(value.severity)) throw new RequestError(400, "请选择报警等级。");
  return { title: field(value.title, "报警标题", 80), device: field(value.device, "设备编号", 64),
    zone: field(value.zone, "区域", 64), severity: value.severity, description: field(value.description ?? "", "现场描述", 600, false) };
}

export const digest = value => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

export class Ledger {
  constructor(path) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.state = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { alarms: {}, reports: {} };
  }

  list(type) { return Object.values(this.state[type]).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  get(type, id) { return this.state[type][recordId(id)]; }

  put(type, value) {
    const id = recordId(value.id);
    const next = { ...this.state, [type]: { ...this.state[type], [id]: value } };
    writeFileSync(`${this.path}.tmp`, JSON.stringify(next), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
    this.state = next;
    return value;
  }

  reserveAlarm(id, owner, fields) {
    const found = this.get("alarms", id);
    if (found) {
      if (found.ownerId !== owner || digest(found.fields) !== digest(fields)) throw new RequestError(409, "同一报警编号的提交人和内容须保持一致。");
      return found;
    }
    if (this.list("alarms").length >= 200) throw new RequestError(409, "演练台账已达 200 条，请另建演练项目与台账。");
    return this.put("alarms", { id, ownerId: owner, fields, createdAt: new Date().toISOString(), controlRunId: null });
  }
}
