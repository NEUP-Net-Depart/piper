# 按需生产发布

Piper 管理发布 PR；业务仓库 Actions 执行生产发布和 Tag。没有新增 Release Bot、数据库或两小时常驻工作流。现有仓库级 Durable Object 串行处理写入，现有 Queue 重试，Bot 评论保存发布策略和截止时间，现有 DO storage 记录已处理的 workflow run ID（包括没有待发布提交的请求）。

## 调查结果（2026-11-16）

- `NEUP-Net-Depart/Pioneer-appointment-system` 默认分支是 `dev`；仓库允许 Merge Commit，`main` 的规则只允许 Merge Commit。当前没有 Git Tag，使用下文备用命名。
- `protect_dev` Ruleset `24945363` 要求一人批准；`protect_main` Ruleset `24865453` 也要求一人批准。两者现有 bypass 仅组织管理员。经典 branch protection API 返回 404，是因为仓库使用 Rulesets，并非没有保护。
- dev push 的 `check.yml` Job 为 `checks`、`browser`、`test`、`migrate-preview`、`release`。最后一个 Job 包含 Preview Pages 部署和 HTTP Smoke。正式 dev → main PR 的测试被刻意跳过，main push 复用 dev 验证。
- 已读取 GitHub Actions Check Run，确认可信 App ID 为 `15368`。业务 production Environment 当前只有 branch policy，没有人工审批规则。Piper 自身 main Ruleset 保持禁止删除/force push，不需要为本次功能调整。
- Piper `.piper.yml` 的普通 PR 策略要求当前提交人工批准、可信检查来源、模块规则和权限；普通合并使用 Squash，发布原本使用 Merge Commit。本次保持这些普通 PR 规则及合并方式。
- 业务仓库原先 `release.enabled: false`；本次配置改为新策略。仓库线上 Rulesets、App 安装/密钥、Environment 设置均未被本次本地改动修改。

## 入口和日常操作

在业务仓库 Actions → **Request production release** → **Run workflow** 选择默认分支 `dev`。仅 `maintain` / `admin` 用户可以通过入口；即便 write 用户能点击 GitHub 的按钮，工作流和 Piper 的二次授权都会拒绝其发布请求。Piper 验证签名 webhook，再从 GitHub API 读取 workflow run，核对来源仓库、文件路径、默认分支、`workflow_dispatch`、成功状态以及原触发人和重跑人的当前角色。

已有命令入口 `/release prepare` 同样要求 maintain/admin。普通 Piper 命令原有 write/maintain/admin 权限语义保持不变。`/release status` 可查询发布 PR 状态；部署和 Tag 的最终结果在 Actions 查看。

Piper 创建非 Draft 的 dev → main PR，标题为 `[release] YYYY年M月D日版本发布`，日期按北京时间；merge commit title 使用同一标题，正文为空，不使用 GitHub 自动标题。Bot 回执绑定仓库、PR 编号、创建时间、标题、请求 ID 和 `mergeAfter`，并使用现有 Webhook secret 做 HMAC 签名；复制或修改 Bot 评论不能伪造发布身份，PR 正文或标签本身不能授权自动合并。轮换 Webhook secret 会使旧签名失效，应先结束/取消待发布 PR，轮换后重新创建发布。

重复请求复用未关闭的 Piper 发布 PR，并刷新内容。已有非 Piper PR 时拒绝重复创建或自动接管，提示维护者处理。旧 Piper v1 发布 PR 只有在维护者显式触发后才登记新策略。截止时间始终取 GitHub 的实际 PR 创建时间加两小时，因此旧 PR 被显式登记时可能已经到期。

比较使用当前 main/base SHA 与 dev/head SHA。说明按合入的 PR 汇总，未关联 PR 的提交单独列出；收集 PR 作者、Commit 作者、Co-authored-by trailers，大小写不敏感地去重，排除 GitHub Bot。通过 GitHub GraphQL Commit.authors 的完整分页获取含私有邮箱在内的已关联作者/共同作者；noreply 邮箱验证用户和数字 ID，公开邮箱通过精确公开 profile 验证。无法可靠映射的身份保留姓名说明，不猜测账号、不暴露邮箱。dev 新提交通过事件或周期扫描更新内容。

取消：关闭 PR 或移除 `auto-release`。回执和 GitHub 时间线使取消保持有效，重新打开/加标签/重复触发都不会恢复；重新发起需先关闭旧 PR。维护者可提前在发布 PR 中发送 `/release publish`，仍核验最新 dev 的全部条件。也支持在 GitHub 页面用 Merge Commit 提前手动合并；此时 GitHub 自身规则适用。任何 main push 都进入原生产 CI。

## 合并条件和恢复

1. Release 已启用，PR 作者为本 Piper App，同仓库 `dev → main`，正式、未关闭，并持有可信 Bot 发布回执和 `auto-release` 标签，未被取消。
2. 当前时间不早于持久化 `mergeAfter`（维护者提前发布命令除外）。五分钟 Cron 不保证精确到秒，正常到期后 0–5 分钟执行，队列或 GitHub 故障会延后。
3. PR HEAD 必须等于当前 dev SHA。只接受配置工作流的 `push` / `dev` / 同仓库 / 同 SHA 最新 run 及最新 attempt；整个 run 成功，所有配置 Job 和 Preview 部署 Job 都成功。逐一核对 Job 的 SHA、Check Run 的可信 App ID 及 check suite ID。`skipped`、neutral、缺失、旧 SHA 和旧成功 attempt 均不能代替成功证据。PR 工作流被跳过不会影响 dev push 的独立核验。
4. 无冲突，GitHub 已完成合并计算。合并写入前重新读取 PR、取消记录、dev SHA 和 CI；请求使用 `sha` 参数绑定已验证 HEAD。GitHub 仍执行分支规则，不伪造状态、不强制推送。

PR 关闭、HEAD 改变、冲突、CI 失败/运行中都不会强行合并。Queue 失败重试后还有五分钟扫描；重启后从回执恢复固定截止时间。merge 响应丢失时先读 PR，已合并便结束；重复 webhook、命令或 Cron 不重复合并。创建/标签响应丢失时沿用原 PR 继续登记。一个已成功处理但没有变更的 Actions 请求不会在以后有新提交时意外创建发布。

GitHub 的 merge 接口仅支持 HEAD 的条件写入，PR 关闭/标签变化与 API 接受合并之间仍有极短竞态。取消必须发生在合并受理前；已受理的请求不能撤回。PR 正文和 Bot 回执应保留；删除/破坏可信回执会停止自动处理。

## GitHub App 和分支规则配置

创建 PR、管理回执、读取 CI、普通 PR 合并和 Release 合并统一使用现有 Piper App 及其 installation token。沿用 `APP_ID`、`APP_PRIVATE_KEY`、`BOT_LOGIN` 和 Webhook 配置，无需新增 App 或密钥。权限保持 Metadata、Checks、Commit statuses、Actions **read**；Contents、Pull requests、Issues **write**。确保订阅 `workflow_run`、`push`、PR、check 等现有事件。

普通 PR 与 Release 的区别由 Piper 内部策略管理：普通集成仍要求现有人工批准、CI、权限和目标分支规则，并在异步合并请求中显式设置 `bypass_rules: false`；Release 只有在维护者授权、同仓库 dev → main、有效签名回执、截止时间、最新 dev CI/Preview 及取消状态全部满足后，才调用 Merge Commit 接口。普通 `/integrate` 不能把发布 PR 合入 main。

不要把 main 的全局批准数降为零，也不要改动 protect_dev。将当前 main 保护拆成两层，最后验证所有有效规则的叠加结果：

- **main 基础规则**：保持禁止删除、禁止 force push、必须 PR、仅 Merge Commit，以及已有的 CI/对话解决等要求；该层的 PR rule 批准数可为 0，但不给 Piper 添加 bypass。
- **main 人工审查规则**：只匹配 `refs/heads/main`，要求 1 人批准；将现有 Piper App 加入 **For pull requests only** bypass。普通用户和其他 App 仍受一人批准约束；Piper 对普通 PR 保持原审查门槛和禁止 bypass 的请求参数。保留原本组织管理员的例外政策。其他安全规则不要放入 Piper 可绕过的这层。

GitHub Rulesets 按 App 身份授予例外，不能按 PR label/head 选择批准人数；Piper 负责在代码中将免人工批准严格限定到可信 Release PR。不给 Piper 添加 dev、CI、删除保护或 force push 的新 bypass。若其他有效 ruleset/经典保护仍要求 main 批准，需同样只调整对应的人工审查规则。

未配置 main 审查豁免时，GitHub 仍会阻止未经批准的发布合并；Piper 不会自行修改仓库规则。

合并由 App installation token 执行，不能换成 Actions 默认 `GITHUB_TOKEN`：后者触发的 main push 通常不会启动新工作流。[GitHub 触发规则](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow)。

## 业务 Actions 和 Tag

入口 `release.yml` 只需要 `contents: read`，不 checkout 代码、不访问生产环境和 Piper 私钥。实际部署仍是 `check.yml`：main push → Production D1 迁移 → Cloudflare Pages → HTTP Smoke。dev/full CI 复用条件未改变。

部署步骤仅在迁移、部署、Smoke 全部成功之后输出 `deployed_sha`。独立 `production-tag` Job 依赖部署成功，限制 `push + refs/heads/main`，核对输出 SHA 等于这次 push 的 SHA，checkout 该 SHA 后创建 Annotated Tag。只有此 Job 获取 `contents: write`，使用默认 Actions token；它无 Cloudflare 密钥，不额外创建 GitHub Release 页面。

暂无历史命名规范，采用 `release-YYYYMMDD-<12位SHA>`。日期取实际部署 main commit 的 **committer date 按 Asia/Shanghai 换算**，使跨日重跑或同 SHA 的另一 workflow run 保持幂等。Annotation 指向部署提交，ref 指向 tag object。已有 Tag（含 annotated tag 的解析目标）正确时不重复写入；目标不同时报错，绝不覆盖。并发创建遇到 422 时再次核对已有 ref，只有目标正确才成功。Tag Job 自身失败可只重跑失败 Job，沿用已成功部署的输出，无需重跑数据库迁移。

Preview、功能分支、PR、手动 main CI 或失败部署均不进入 Tag Job。生产 Environment 的 Cloudflare credentials 和原有迁移/部署权限保持不变。已核对 production Environment 当前没有人工审批规则，无需为本功能移除审批。若日后添加了审批，生产 CI 会等待；应继续保留 main 分支限制及其余保护。

## 上线顺序与验证

1. 先部署新版 Piper（仍不开 Release 或保持 dry-run），确认五分钟 Cron、Queue、DO binding、Webhook 正常；复用现有 Piper App/私钥，配置两层 main Ruleset。保留普通 PR 的保护。
2. 将业务 `release.yml`、Tag 脚本、生产成功 SHA 输出和 `production-tag` Job 合入默认分支 dev；确保 `check.yml` 的 dev Job 全成功。
3. 在默认分支启用 `.piper.yml` 的 release，并配置 `requestWorkflow: release.yml`、`deploymentWorkflow: check.yml`、`deploymentJob: release`、`requiredChecks: [checks, browser, test, migrate-preview]`、可信 GitHub Actions `app.id: 15368`。关闭所需的 Worker/仓库 dry-run。
4. 维护者按需触发入口；检查正式 PR、标题、贡献者、回执 deadline。可以先移除 `auto-release` 验证取消，再关闭 PR，重新触发一次新发布。
5. 核实自动合并提交标题、main push 工作流、D1/Pages/Smoke 顺序和 Annotated Tag 的 peeled SHA；确认普通 PR 仍需审查，其合并请求保持 `bypass_rules: false`，且 `/integrate` 不能合入 main。

本地验证：Piper `npm run verify`；业务 `node --test tests/release.test.mjs tests/release-tag.test.mjs`，并 lint 本次修改脚本。测试模拟 GitHub/部署结果，不访问生产数据库、不部署、不创建真实 PR/Tag。线上 App 私钥、Cloudflare Environment 审批和最终叠加保护需要维护者在上线时核验。
