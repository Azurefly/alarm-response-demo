# 对接 Flow AI Engine

报警处置台通过服务端调用 Flow AI Engine。业务应用保存报警编号、原始字段和实例关联。引擎保存流程定义、参与人任务、父子实例、结案回执和数据产物。[架构与部署](architecture.md)

## 1. 准备引擎和接入账号

- 按引擎的部署说明启动应用、MySQL 和运行 Worker。在电脑浏览器打开引擎并用测试环境管理员登录。[Flow AI Engine 部署说明](https://github.com/Azurefly/flow-ai-engine/blob/main/docs/deployment-linux-docker.md)
- 为本次演练使用专用引擎环境或测试业务。需要管理账号和项目的管理员只在初始化时使用。后续提交、办理和统计使用脚本创建的三个演练账号。
- 演示项目需要 Node.js 20 或更新版本。引擎地址填写 HTTPS origin。本机联调可使用 `http://127.0.0.1:1180`。origin 由协议、主机和端口组成。

## 2. 初始化三类流程并打开业务应用

在演示仓库根目录的 PowerShell 7 执行。用自己环境的地址替换示例值。

```powershell
$env:ALARM_ENGINE_ORIGIN = 'http://127.0.0.1:1180'
$env:ALARM_CONFIRM_ENGINE = $env:ALARM_ENGINE_ORIGIN
$credential = Get-Credential -Message '输入测试环境管理员凭据'
@{
    username = $credential.UserName
    password = $credential.GetNetworkCredential().Password
} | ConvertTo-Json -Compress | node scripts/provision.mjs
Remove-Variable credential
if ($LASTEXITCODE -ne 0) { throw '初始化失败，请先检查脚本记录。' }
npm start
```

初始化会创建独立业务项目、三个办理人和结案数据资源。随后创建、预检、审核及发布以下流程。使用同一 `ALARM_SETUP_DIR` 和同一引擎地址重跑可以核对和继续初始化。[初始化脚本](../scripts/provision.mjs) · [三类流程定义](../src/workflows.mjs)

| 发布顺序 | 类型 | 流程与配置 |
| --- | --- | --- |
| 1 | 状态 | 「报警处置与复核」绑定值班员、处置员和复核员，分别负责确认、处置和复核。 |
| 2 | 控制 | 「报警分级与派发」按 `high` 或 `normal` 分支选择派发方式，调用已发布的状态流程版本并等待结案。 |
| 3 | 数据 | 「报警处置统计」读取「报警结案快照」数据资产，验证字段、按等级和结案结果聚合并输出统计。 |

如果手动建立流程，可以使用定义工厂生成定义。初始化通过 `project.createWorkflow` 创建草稿，使用 `workflow.compile` 检查，提交审核时带上当前审核状态和定义版本。随后重新读取流程并用当前定义版本执行 `workflow.publish`。换用新的子流程发布版本时，在父流程配置中重新绑定版本，保存、预检、审核并发布父流程。

| 本地文件 | 用途 |
| --- | --- |
| `runtime/setup/setup.json` | 初始化进度、目标引擎及本次项目和流程关联。 |
| `runtime/setup/config.json` | 服务读取的引擎地址、项目 ID、三类流程 ID、数据资产和办理人 ID。 |
| `runtime/setup/accounts.json` | 三个演练账号的用户名和随机口令。部署者通过私有渠道交接。 |
| `runtime/ledger.json` | 演示业务的报警和统计台账。将其保存在应用可写的持久目录。 |

将生成的文件留在私有运行目录。`ALARM_SETUP_DIR` 支持自定义初始化目录，对应将 `ALARM_CONFIG_FILE` 指向该目录下的 `config.json`。服务容器只需要读取配置文件，台账单独挂载为可写目录。[运行配置](architecture.md#运行配置)

打开[本机处置台](http://127.0.0.1:8080/alarm-demo/)，从自己的账号文件取值，分别以 `duty`、`technician` 和 `reviewer` 登录。三个账号都具备该项目的 `operator` 角色，复核员另有 `designer` 角色，用于更新统计快照资产。可以用三个桌面浏览器配置文件保持各自的登录会话。

## 3. 通过业务应用跑通一次报警

1. 值班员上报「温度越限」样例。提交后保存报警与派发实例的关联，等待详情出现「待确认」。点击「确认属实」。
2. 处置员选中同一报警，记录处置意见并提交。复核员在「待复核」选择「复核通过」。等详情出现「已关闭」，核对值班确认、处置和复核记录。
3. 复核员点「生成统计」，等结果显示「已生成」。核对结果行的数量、结案类型及耗时。
4. 从报警详情点「控制实例」「状态实例」，在统计区点「数据实例」。用对应账号登入引擎，查看画布右侧的节点执行记录。数据实例还可查看最终结果。

可再用「通信离线」样例复验误报关闭，或在复核时退回补充处置后升级结案。[验收场景](acceptance.md)

## 4. 在自己的服务端复用引擎调用

[Engine 客户端](../src/engine.mjs)使用 `/api/trpc/<过程名>`。查询使用 GET，`input` 参数为 URL 编码的 `{"json":输入}`。命令使用 POST，正文采用相同外壳，头部使用 `Content-Type: application/json`。业务结果位于 `result.data.json`。先调用 `auth.login`，客户端从响应提取 `flow_session`，后续用该登录身份调用引擎，使用完执行 `auth.logout`。

服务端应按办理人维持独立会话并校验 `project.access`。业务页使用作用域限制在 `/alarm-demo/` 的 HttpOnly Cookie。HTTPS 部署同时使用 `Secure` 属性。对接其他业务时可以保留现有业务登录入口，由服务端按对应的引擎身份和授权调用接口。

| 业务动作 | 引擎过程与需保存的数据 |
| --- | --- |
| 上报报警 | `workflow.runReadiness` 核对正式发布计划，再用 `workflow.run` 提交输入、稳定幂等键、定义版本和计划哈希。关联返回的 `runId`。 |
| 查进度和结案 | `workflow.runDetail` 读取控制实例，再从 `childLinks` 找到状态实例并回读。核对告警编号、父子状态和结案结果。 |
| 查询待办 | `task.list` 带 `projectId`、状态子实例的 `runId` 和 `view: "todo"`。展示当前账号可办的任务及其允许的结果。 |
| 提交办理 | `task.execute` 使用当前 `taskId`，提交该任务允许的 `outcome`、对应的 `decision` 及办理意见。随后重新读取实例和待办。 |
| 报表运行 | `data.updateAsset` 同步结案快照，预检后调用 `data.run`。保存返回的实例编号，并用 `data.runDetail` 回读来源节点和最终结果。 |

### 从服务端直接发起一次控制流程

以下示例使用初始化生成的值班员账号和项目配置。可保存为仓库根目录的 `run-alarm.mjs`，在 PowerShell 7 中执行 `node run-alarm.mjs`。它会在所配置的测试引擎创建一条合成报警实例，随后可从引擎工作台办理。需要进入演示台账时使用下一节的业务接口。

```js
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Engine } from "./src/engine.mjs";

const config = JSON.parse(await readFile("runtime/setup/config.json", "utf8"));
const { duty } = JSON.parse(await readFile("runtime/setup/accounts.json", "utf8"));
const engine = new Engine(config.origin);

const alarmId = process.env.DEMO_ALARM_ID || randomUUID();
const input = {
  alarmId,
  title: "冷却泵温度越限演练",
  severity: "high",
  device: "PUMP-DEMO-01",
  zone: "设备演练区",
  description: "合成设备事件",
};
const workflowId = config.workflows.control;

await engine.write("auth.login", { username: duty.username, password: duty.password });
try {
  console.log({ alarmId });
  const ready = await engine.write("workflow.runReadiness", { workflowId, mode: "formal", input });
  if (!ready.canStart || ready.executionSource !== "published_plan") {
    throw new Error("请检查报警派发流程的正式发布状态与父子配置");
  }
  const receipt = await engine.write("workflow.run", {
    workflowId,
    input,
    idempotencyKey: `alarm-demo-${alarmId}`,
    expectedDefinitionVersion: ready.definitionVersion,
    expectedExecutionPlanHash: ready.planHash,
  });
  const detail = await engine.read("workflow.runDetail", { runId: receipt.runId });
  console.log({ runId: receipt.runId, status: detail.status, childLinks: detail.childLinks });
} finally {
  await engine.write("auth.logout");
}
```

在业务系统中应在第一次提交前持久化 `alarmId` 和输入。连接中断后，给 `DEMO_ALARM_ID` 传入同一个编号，沿用原输入。收到运行回执表示引擎已接单。流程完成以详情的终态为准。演示要求父实例及状态子实例均成功，父实例结案回执与子实例业务状态一致，才把台账标为结案。[提交与回读实现](../src/business.mjs)

## 5. 直接接入报警处置台 HTTP 接口

以下路由由演示的 Node.js 服务提供。示例使用默认前缀 `/alarm-demo`。POST 发送 JSON 并把 `Origin` 设为实际访问应用的 origin。登录后保留会话 Cookie。每次上报和生成统计使用调用方生成的 UUID，重试时继续使用同一编号。

| 方法与路径 | 请求与回执 |
| --- | --- |
| `POST /alarm-demo/api/login` | 输入 `username` 和 `password`，取得当前角色及会话 Cookie。 |
| `POST /alarm-demo/api/alarms` | 传 `id`、`title`、`severity`、`device`、`zone` 和 `description`。接单时返回 `id` 和 `controlRunId`。 |
| `GET /alarm-demo/api/alarms/{alarmId}` | 读取父子运行状态、业务状态和 `task`。`task` 有值时可用其中的 `id` 和 `outcomes` 办理。 |
| `POST /alarm-demo/api/alarms/{alarmId}/task` | 传 `taskId`、所选结果的 `action` 和 `comment`。提交后重新读取详情。 |
| `POST /alarm-demo/api/reports` | 复核员传报告编号 `id`，提交独立数据实例。 |
| `GET /alarm-demo/api/reports/{reportId}` | 用同一报告编号读取状态和结果行。 |
| `POST /alarm-demo/api/logout` | 结束当前会话。 |

可按状态处理接口响应。`401` 时重新登录，`403` 时核对项目及待办权限，`409` 时刷新实例或任务后按当前信息操作。连接异常时先用业务编号核对原回执。统计快照按报警编号排序并计算摘要，回读数据源时核对摘要和分组数量。此演示用单实例串行更新一份资产快照。[HTTP 路由](../src/server.mjs) · [幂等台账](../src/ledger.mjs)

## 6. 运行验收或换成自己的业务

启动演示服务后，在另一个 PowerShell 7 会话执行下列命令。验收会向当前演练项目写入三条合成报警，分别完成关闭、误报和退回升级，最后生成统计并核对父子实例和数据血缘。

```powershell
npm test
$env:ALARM_DEMO_URL = 'http://127.0.0.1:8080/alarm-demo/'
$env:ALARM_CONFIG_FILE = 'runtime/setup/config.json'
$env:ALARM_ACCOUNTS_FILE = 'runtime/setup/accounts.json'
npm run acceptance
```

迁移到自己的业务时，先替换三类流程的输入和人员映射，再把台账关联字段改成自己的业务主键。保留稳定幂等键、期望版本、按办理人授权以及回读终态的契约。建议在引擎中先发布一条简化流程，完成一次从业务提交、引擎办理到业务回读的联验，再增加并行与统计。[节点与流程类型](https://github.com/Azurefly/flow-ai-engine/blob/main/docs/workflow-guide.md)
