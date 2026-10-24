# Piper

Piper 是运行在 Cloudflare Workers 上的 GitHub App，负责 PR 审查分配、检查进度、合并和发布。业务状态保存在 GitHub 评论中，Queues 处理任务，Durable Objects 协调并发，Cron 每小时整点补偿检查；无需 D1 数据库。

本文包含[机器人部署](#机器人部署)和[仓库 YAML 配置](#仓库-yaml-配置)。使用机器人时，在 Issue 或 PR 中新建评论发送 `/help`；单项用法用 `/help integrate` 等，完整列表用 `/help all`。

PR 描述底部的 Piper Progress 自动更新协作状态和检查清单。Piper 维护 `<!-- piper:progress -->` 与 `<!-- piper:progress:end -->` 之间的内容，保留作者原文。就绪通知包含最终提交信息和合并命令；新提交或检查失败时，通知更新为进度链接。

## 机器人部署

### 1. 准备环境

需要 Node.js 22.22+、可使用 Workers / Queues / Durable Objects 的 Cloudflare 账户，以及创建和安装 GitHub App 的权限。

```powershell
npm ci
npm run verify
npx wrangler login
```

`verify` 执行类型检查、Lint、自动化测试和正式环境打包，不会部署或访问真实 GitHub 仓库。以下命令使用 PowerShell；替换示例中的账号、App ID、登录名和域名后再执行。

只需部署一套 `production` 环境：Worker 和任务队列均名为 `piper-production`，失败队列名为 `piper-production-dlq`。公开或私有仓库均可接入。

### 2. 创建 GitHub App

在账号或组织的 Settings → Developer settings → GitHub Apps 中创建 App，记录 **App ID** 和实际机器人登录名（以 `[bot]` 结尾），生成私钥 PEM，并设置 Webhook secret。

- Homepage URL：Piper 仓库地址。
- Webhook URL：对应 Worker 的 `https://你的域名/webhooks/github`。首次部署和密钥配置完成后再启用 Webhook。
- Repository permissions：按下表授权。
- Subscribe to events：`pull_request`、`pull_request_review`、`issue_comment`、`issues`、`check_run`、`check_suite`、`status`、`push`、`workflow_run`。
- 安装时选择需要管理的仓库，并让安装范围与后面的仓库白名单一致。

| Repository permission | 级别 |
| --- | --- |
| Metadata、Checks、Commit statuses、Actions | Read-only |
| Contents、Pull requests、Issues | Read and write |

也可运行 `npm run manifest -- https://你的域名` 生成相同配置的 Manifest，按照 [GitHub Manifest 注册流程](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)注册。该脚本只输出 JSON，不会自动创建 App。

目标仓库应启用 Squash；需要 Piper 发布时也启用 Merge Commit。配置必需 CI、人工审查、推送新提交后旧批准失效及分支删除保护。不要将 App 加入分支规则 bypass。保留发布源分支和目标分支，避免合并后自动删除长期分支。

### 3. 创建 Cloudflare 队列

```powershell
npx wrangler queues create piper-production
npx wrangler queues create piper-production-dlq
```

仓库的 `wrangler.jsonc` 已配置 `TASKS`、`COORDINATORS`、类迁移、静态资源和 Cron；首次部署自动创建 Durable Objects 命名空间，无需执行 SQL。任务失败最多重试 5 次，随后进入失败队列（DLQ）。

### 4. 配置并部署 Worker

设置下列环境变量，生成正式环境部署配置：

```powershell
$env:PIPER_APP_ID = '123456'
$env:PIPER_BOT_LOGIN = 'your-piper[bot]'
$env:PIPER_ALLOWLIST = 'YOUR_ORG/YOUR_REPO'
$env:PIPER_WORKER_URL = 'https://piper-production.YOUR-SUBDOMAIN.workers.dev'
$env:PIPER_ORG_DEFAULTS = '{}'
$env:PIPER_DRY_RUN = 'true'
$env:PIPER_EMERGENCY_STOP = 'false'
$env:PIPER_STOPPED_REPOSITORIES = ''

node scripts/deploy-config.mjs
npx wrangler deploy --env production --config .piper.deploy.jsonc
```

脚本从 `wrangler.jsonc` 生成 `.piper.deploy.jsonc`，并填写 `production` 的部署变量。每次修改变量后重新运行脚本，不要复用旧的生成文件。`PIPER_WORKER_URL` 必须是实际可访问的 HTTPS origin，不含路径、查询参数或用户名密码；`public/` 中的静态资源部署到这个地址下。

| 部署变量 | Worker 中的名称 | 用途 |
| --- | --- | --- |
| `PIPER_APP_ID` | `APP_ID` | 对应 GitHub App 的数字 ID |
| `PIPER_BOT_LOGIN` | `BOT_LOGIN` | 对应 App 的实际机器人登录名 |
| `PIPER_ALLOWLIST` | `ALLOWED_REPOSITORIES` | 完整仓库名，多个用逗号分隔 |
| `PIPER_WORKER_URL` | `PUBLIC_URL` | 当前 Worker 的 HTTPS origin |
| `PIPER_ORG_DEFAULTS` | `ORG_DEFAULTS` | 组织默认配置 JSON，默认 `{}` |
| `PIPER_DRY_RUN` | `DRY_RUN` | 默认 `true`，只记录拟执行的操作；`false` 允许写入 |
| `PIPER_EMERGENCY_STOP` | `EMERGENCY_STOP` | 默认 `false`；`true` 停用全部仓库 |
| `PIPER_STOPPED_REPOSITORIES` | `STOPPED_REPOSITORIES` | 停用仓库名，逗号分隔；默认空 |

Worker 创建后写入本环境的三个密钥，按提示输入值：

```powershell
npx wrangler secret put APP_PRIVATE_KEY --env production --config .piper.deploy.jsonc
npx wrangler secret put WEBHOOK_SECRET --env production --config .piper.deploy.jsonc
npx wrangler secret put ADMIN_TOKEN --env production --config .piper.deploy.jsonc
```

`APP_PRIVATE_KEY` 是对应 App 的完整多行 PEM；`WEBHOOK_SECRET` 与 GitHub App 中填写的值一致；`ADMIN_TOKEN` 使用至少 32 字符的随机值。三者保存在 Cloudflare Worker secrets，不放入 YAML、组织配置或 Git。

### 5. 接入仓库并启用写入

1. 在目标仓库的**默认分支根目录**放置 `.piper.yml`，按下文配置 `enabled: true`、检查名和审查者，先保留 `dryRun: true`。
2. 启用 GitHub App Webhook，执行 `node scripts/smoke.mjs`。它通过 `PIPER_WORKER_URL` 检查健康接口、无签名 Webhook 和未认证管理请求的拒绝行为，不执行审查、合并或发布。
3. 查看 GitHub App 的 Recent deliveries 和 Worker 日志，确认事件被接收、配置已加载。Dry-run 是上线前的预演开关：只记录拟执行操作，不发评论、不修改仓库，也不保存待执行命令意图。
4. **正式启用：将部署变量 `PIPER_DRY_RUN` 和默认分支 `.piper.yml` 的 `dryRun` 都设为 `false`，重新生成配置并部署 Worker。** 此前在 Dry-run 中发送的命令需要新建评论重发。
5. 在 Issue 或 PR 中新建评论发送 `/help`，确认机器人回复；根据 PR 描述中的待处理事项、CI 和审查进度推进合并。

### 6. 使用 GitHub Actions 部署

Piper 仓库的 `.github/workflows/ci.yml` 在 push / PR 时检查代码；`.github/workflows/deploy.yml` 仅从 `main` 手动触发。它先验证，再部署 `production`，最后检查 HTTP 健康状态与认证。

在 Piper 仓库创建名为 `production` 的 GitHub Environment，配置：

- Secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`。Token 需要允许对应账户的 Worker 部署、Queue 配置和 Durable Objects 类迁移。
- Variables：上表中的 `PIPER_*` 变量；正式运行时设置 `PIPER_DRY_RUN=false`。

三个 Worker secrets 仍使用上一步的 Wrangler 命令设置；部署工作流不会替你上传它们。为 `production` 设置必需人工审批、禁止自批，并限制只能从 `main` 部署。准备好后，在 Actions → Deploy Piper → Run workflow 中选择 `main` 并运行。

### 7. 停用与排查

全局停用：设置 `PIPER_EMERGENCY_STOP=true` 后重新生成配置并部署。单仓库停用：将仓库加入 `PIPER_STOPPED_REPOSITORIES` 后部署，或在默认分支的 `.piper.yml` 设置 `enabled: false`。

| 现象 | 处理 |
| --- | --- |
| `/health` 返回 503 | 检查 `COORDINATORS` binding 和类迁移，使用当前配置重新部署 |
| Webhook 返回 401 | 核对 App 与 Worker 的 `WEBHOOK_SECRET` |
| 收到事件但没有评论 | 检查 App 安装范围、仓库白名单、`enabled`、两层 Dry-run 和停用开关 |
| Webhook 入队失败 | 在 GitHub App Recent deliveries 重投原事件；Cron 不恢复未入队命令 |
| 任务进入 DLQ | 核对失败原因，在保留期内将原消息重放到 `piper-production` 队列，保留原 job ID |
| 发布部署失败 | 查看工作流日志，修复并重跑同一合并提交的工作流，Piper 会重新核验 |
| 命令评论或提交已改变 | 在新评论中重新发送命令 |

管理接口使用 `Authorization: Bearer ADMIN_TOKEN`：`GET /admin/status` 查看环境开关，`GET /admin/audit?repo=owner/repo&number=1` 读取 Bot 回执，`POST /admin/reconcile?repo=owner/repo` 请求状态重扫。重扫不会重放命令。保留 Bot 评论中的隐藏回执，并监控 Worker 日志、队列积压和 DLQ。恢复记录只从 Piper 自己的 Bot 评论读取，PR 描述中的复选框不作为合并授权依据。停用不撤回已发出的请求；环境停用期间消息可能继续重试并进入 DLQ。

## 仓库 YAML 配置

### 配置放在哪里

Piper 读取每个仓库**默认分支根目录**的 `.piper.yml`。PR 自己修改的配置要先合入默认分支才生效。

生效顺序：内置默认值 → Worker 的 `ORG_DEFAULTS` JSON → 仓库 `.piper.yml`。对象按字段合并，数组整体替换。配置是严格格式，不接受未知字段、重复 YAML 键或超过 64 KiB 的文件。

默认 `enabled: false`、`dryRun: true`。实际写入还要求仓库在 Worker 白名单内、App 已安装、停用开关关闭，且 Worker `DRY_RUN` 和仓库 `dryRun` 均为 `false`。

### 完整示例

以下示例使用 `dev` 开发分支、`main` 发布目标和 `verify` 检查。替换参与指南、审查者和实际 CI 名称；按需启用 Backport 或发布。

```yaml
enabled: true
dryRun: true

welcome:
  issue: '感谢反馈。请按 Issue 模板补充问题信息。'
  pr: ''
  merged: '感谢贡献。'
  image: ''
  guide: https://github.com/YOUR_ORG/YOUR_REPO

reviewers:
  pool: [reviewer-one, reviewer-two]
  count: 1
  remindHours: 24
  rotateHours: 48

merge:
  requiredChecks: [verify]
  trustedCheckAppIds: [] # 必须填写实际 CI 应用的 app.id；空列表会阻止集成
  minApprovals: 1
  auto: false
  allowedBases: [dev]
  protectedBranches: [main]
  highRiskFiles: ['.github/**', 'migrations/**', '**/migrations/**', '.piper.yml']
  highRiskLabels: [security, high-risk]

labels:
  - name: bug
    titlePrefixes: ['fix:', 'fix(']
    branches: ['fix/**', 'fix-*']
  - name: area/ci
    files: ['.github/**']
    reviewers: [reviewer-one, reviewer-two]
    reviewerCount: 2
    minApprovals: 2
    highRisk: true

backport:
  enabled: false
  targets: []
  maxFiles: 50

release:
  enabled: false
  source: dev
  target: main
  timezone: Asia/Shanghai
  weekday: 4
  hour: 18
  version: patch
  initialVersion: v0.1.0
  deploymentWorkflow: ci.yml
  deploymentJob: release
  requiredChecks: [verify]
  minApprovals: 1
```

### 字段说明

| 配置 | 默认值与行为 |
| --- | --- |
| `enabled` | 默认 `false`；开启该仓库的 Piper 处理 |
| `dryRun` | 默认 `true`；只记录拟执行操作 |
| `welcome.issue` / `pr` / `merged` | 首次 Issue 回复、PR 状态补充说明、普通 PR 合并致谢；内置中文文案，可设空字符串关闭相应文字，单项最多 10,000 字符 |
| `welcome.image` | 默认关闭；接受 Worker 的 `/assets/文件名` 或 HTTPS 图片地址，空字符串关闭图片；`merged` 为空时也不展示图片 |
| `welcome.guide` | 参与指南 URL；内置值为预约系统 Issue #39，接入其他项目时应覆盖 |
| `reviewers.pool` | 默认 `[]`，最多 30 个 GitHub 用户名，不带 `@`、不能重复；候选人须有写权限且不是 PR 作者 |
| `reviewers.count` | 默认 `1`，范围 0–10；自动请求审查的人数，`0` 关闭仓库级自动分配，不等于无需批准；模块可提高人数 |
| `reviewers.remindHours` | 默认 `24`，范围 1–168 小时；未回应时提醒 |
| `reviewers.rotateHours` | 默认 `48`，范围 2–336 小时，必须大于提醒时间；未回应时尝试换人，无可用替补时提示维护者交接 |
| `merge.requiredChecks` | 默认 `[verify]`，1–30 个必需检查名称；填写 GitHub Checks 中的名称，不是工作流文件名；要求检查成功，跳过或 neutral 不算成功 |
| `merge.trustedCheckAppIds` | 默认 `[]`，拒绝通过 CI 门槛；必须填写可信 CI 的 Check Run `app.id`，仅接受这些 App 的检查，不接受无法绑定 App 身份的 commit status |
| `merge.minApprovals` | 默认 `1`，范围 1–10；当前提交所需人工批准数，作者、Bot 和旧提交的批准不计入 |
| `merge.auto` | 默认 `false`；开启后可自动合并有写权限作者的非高风险 PR，仍检查 CI、审查和 GitHub 分支规则 |
| `merge.allowedBases` | 默认 `[dev]`；普通 Squash 合并允许的目标分支，至少一项 |
| `merge.protectedBranches` | 默认 `[main]`；禁止普通集成和 Backport 直接写入的分支；发布流程另行校验 |
| `merge.highRiskFiles` / `highRiskLabels` | 默认见示例；匹配后要求人工批准及显式集成请求 |
| `labels` | 默认 `[]`，最多 50 条；按下面的规则自动设置标签和模块审查要求 |
| `backport.enabled` / `targets` / `maxFiles` | 默认 `false` / `[]` / `50`；允许将已合并 PR 移植到列出的分支，目标最多 20 个，文件限制 1–100 |
| `release.enabled` | 默认 `false`；为 Worker 仓库白名单内的仓库启用下述发布流程 |
| `release.source` / `target` | 默认 `dev` / `main`，两者必须不同；目标分支即使未开启发布，也不能走普通 Squash 或 Backport |
| `release.timezone` / `weekday` / `hour` | 默认 `Asia/Shanghai` / `4` / `18`，即北京时间周四 18 点后开始准备；星期 0–6 表示周日到周六，小时 0–23，实际执行受 Cron 和队列影响 |
| `release.version` / `initialVersion` | 默认 `patch` / `v0.1.0`；`patch` 增加补丁号，`minor` 增加次版本并清零补丁号，`date` 使用 `v年.月.日`；初始版本只用于尚无版本的 patch / minor 发布 |
| `release.deploymentWorkflow` / `deploymentJob` | 默认 `ci.yml` / `release`；目标分支 push 后运行的工作流文件名和实际部署 Job 名称 |
| `release.requiredChecks` / `minApprovals` | 默认 `[verify]` / `1`；发布合并前的检查和批准要求，批准数还须满足仓库、模块及命令设置的更高要求 |

`merge.trustedCheckAppIds` 须使用已知可信 CI 运行记录中的 `app.id`，也适用于发布 PR。缺少必需检查时，从首次观察到当前提交起等待五分钟，再通过延迟队列任务重新检查；重启、评论和标签更新不会重置计时，队列重试或服务停用可能使实际检查延后。普通 PR 达到 250 个提交的读取上限时，Piper 停止集成并提示人工处理。

当前审查责任以 GitHub 待处理审查请求为准。审查提醒和换人基于审查请求时间线；每小时 Cron 和队列等待可能使实际提醒晚于配置时间。历史审查者在距离最近一次请求、撤销或审查达到 `rotateHours` 后可重新进入候选池，优先选择未请求过的人；排除当前审查者、作者、当前批准者及要求修改者。

自动集成请求人的写权限在刷新和执行时复核；失权后移除自动集成标签并提示重新请求。`merge.auto` 是独立的仓库规则，`/integrate cancel` 仅取消命令登记的自动请求，不会关闭它。

普通集成统一使用 GitHub 异步合并 API（版本 `2026-03-10`），绑定已核验的 HEAD，指定 Squash、直接合并且不绕过规则。命令回执表示命令已处理；GitHub 受理后，Piper 更新同一回复及 PR Progress，直到确认成功或失败。`/integrate cancel` 不会撤回 GitHub 已受理的请求。

GitHub 原生 Stack 按最终目标分支检查 `allowedBases`，保留直接父分支及下层依赖信息。Piper 只集成当前没有未合并下层依赖的一条 PR；例如 #72 → #74 必须先集成 #72，等待 GitHub 更新 #74 的父分支和 HEAD，再重新完成 CI、当前提交审查及集成。提交前重查 HEAD、Stack 成员和顺序；无法核实则停止。Piper 不创建、调整、Rebase 或整组合并 Stack，也不管理 Merge Queue。

合并意图、UUID 和最终结果保存在 Bot 评论回执中，延迟 Queue 任务查询进度，Cron/状态刷新可恢复丢失的轮询。临时查询故障最多连续重试五次。提交响应丢失时只观察 PR，不盲目重新发起请求；UUID 过期、超过 24 小时或结果无法可靠确认时停止并提示维护者核实。GitHub 不提供 Stack 版本锁，最后一次核验与 GitHub 执行之间仍可能发生外部变更；受理后 Piper 无法撤回该请求。

### 标签与模块审查规则

每条 `labels` 规则必须有唯一的 `name`（1–50 字符）。`files`、`branches`、`titlePrefixes` 任一条件匹配即生效；都为空则不匹配。`branches` 匹配 PR 源分支，`titlePrefixes` 忽略大小写，`files` 同时检查重命名前后的路径。

路径和分支支持 `*`（当前目录）、`**`（跨目录）、`?`（单字符），不支持复杂的扩展 glob。标签名 `rfr`、`ready`、`auto`、`integrated` 保留给 Piper。

| 规则字段 | 行为 |
| --- | --- |
| `reviewers` | 本模块的审查候选池，默认空，最多 30 人；匹配模块中存在候选人时合并模块池，否则使用仓库池 |
| `reviewerCount` | 可选，0–10；与仓库及其他匹配模块取最大值，决定自动邀请人数 |
| `minApprovals` | 可选，1–10；与仓库、其他匹配模块及命令设置取最大值，决定批准门槛 |
| `highRisk` | 默认 `false`；标记高风险，停用仓库规则触发的自动合并，允许显式请求后重新核验 |

模块批准人数取最高要求，不累加；不会额外要求每个模块池各自提供批准。人工移除展示标签不会降低文件规则的审查和风险要求。新增标签由 Piper 创建，人工调整会保留，`/label auto 标签名` 恢复自动管理。

### Backport 与发布

Backport 只用于已合并 PR。启用时配置 `backport.targets`；若希望新 Backport PR 也能由 Piper 普通集成，将目标同时加入 `merge.allowedBases`。目标不能位于 `protectedBranches`，也不能等于 `release.target`。遇到补丁冲突、符号链接或不支持的文件格式时，Piper 停止自动处理并给出人工操作提示。

发布功能适用于 Worker 仓库白名单（`ALLOWED_REPOSITORIES`）内启用 `release.enabled: true` 的仓库。发布源分支、目标分支、检查和部署工作流均按该仓库的配置执行；实际写入还须满足前述 App 安装、启用、Dry-run 和停用开关要求。

启用后，Piper 按计划创建 `source → target` 发布 PR；无新增提交时跳过。审查和 CI 满足后，维护者发送 `/release publish`，Piper 使用 Merge Commit 合并，再核对该合并 SHA 在目标分支上的 `push` 工作流和指定部署 Job。工作流及部署 Job 均成功后才创建版本 Tag 和正式 Release，并标记为最新版本。`/release prepare` 可手动准备，`/release status` 查询进度。

预约系统可使用 `examples/appointment.piper.yml`：检查为 `test`，部署工作流为 `check.yml`，部署 Job 为 `release`。这些名称必须与接入仓库的实际工作流一致。

### 组织默认值与本地运行

组织默认配置使用与 YAML 相同的字段，以 JSON 写入 `PIPER_ORG_DEFAULTS`，例如：

```json
{"reviewers":{"pool":["reviewer-one","reviewer-two"]},"merge":{"requiredChecks":["verify"],"minApprovals":1}}
```

仓库 YAML 可以覆盖组织默认值，因此它不是不可覆盖的安全策略。仓库白名单、环境 Dry-run 和停用开关由 Worker 控制，GitHub 分支保护仍独立生效。组织配置样例见 `examples/organization-defaults.json`。

本地运行前，在 `wrangler.jsonc` 的 `production.vars`（位于 `env` 下）填写非密钥变量，将三个 Worker secrets 放入已被 Git 忽略的 `.dev.vars.production`，然后运行 `npm run dev`。本地调试保持 `DRY_RUN: "true"`；本地 Worker 仍可访问 GitHub，Dry-run 可防止修改真实仓库。不要将私钥、Webhook secret 或管理 token 写入 `.piper.yml`。

<details>
<summary>第三方许可声明</summary>

Welcome message translations: https://github.com/behaviorbot/welcome

MIT License

Copyright (c) 2017 behaviorbot

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

</details>
