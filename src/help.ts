import { Denied } from './types';

const usage =
  '在 PR 的 Conversation（对话）中新建评论，单独一行输入命令。每条评论只发一个命令；不要加反引号、缩进或引用。修改旧评论不会执行命令。';
const maintainer = '维护者指具有仓库 write、maintain 或 admin 权限的人。';
const topics: Record<string, { summary: string; syntax: string[]; detail: string }> = {
  help: {
    summary: '查看帮助，任何可评论用户都能使用。',
    syntax: ['/help', '/help integrate', '/help all'],
    detail: '用 /help 命令名 查看一个命令的用法，用 /help all 查看全部命令。帮助在 Issue 和 PR 中都可使用。',
  },
  integrate: {
    summary: '将当前 PR 合并到目标分支。作者或维护者可执行。',
    syntax: ['/integrate', '/integrate auto', '/integrate cancel', '/integrate manual'],
    detail:
      '普通 PR 使用 Squash：把这次 PR 的修改合成一个提交。\n\n- /integrate：立即尝试一次。作者无需仓库写权限；条件未满足时不会排队，完成检查后须重新发送。\n- /integrate auto：等待当前提交的条件满足后自动合并，发令者必须有仓库写权限。\n- /integrate cancel：取消通过命令登记的自动请求；/integrate manual 是同义命令，不会立即合并。\n\n先确认协作状态中的 CI（自动检查）、人工批准和分支规则已满足，再检查集成提示中的最终提交信息。推送新提交会使旧请求和旧批准失效。取消命令请求不会关闭维护者在 .piper.yml 中配置的 merge.auto，也不会撤回 GitHub 已受理的请求。GitHub 受理后会异步更新本条命令回复，无需重复发送。Stack 只逐个集成：先合并下层 PR，等待 GitHub 更新上层分支后重新检查和审查。发布 PR 使用 /release publish。',
  },
  reviewers: {
    summary: '查看审查安排；维护者可邀请或更换审查者。',
    syntax: ['/reviewers', '/reviewers add login', '/reviewers handoff old new', '/reviewers 2'],
    detail:
      '将 login、old、new 替换为 GitHub 用户名（不带 @）。/reviewers 无需写权限；其余操作需要维护者权限。数字设置所需批准人数，范围为仓库及模块最低要求至 10。\n\n收到审查请求后，打开 Files changed → Review changes，选择 Approve（批准）或 Request changes（要求修改）。普通评论和 /reviewers add 都不算批准。有效批准须来自有写权限的非作者、非 Bot 审查者，并覆盖当前提交。handoff 会先邀请新审查者，再撤销旧请求。',
  },
  summary: {
    summary: '作者或维护者设置合并提交的正文。',
    syntax: ['/summary 修复预约日期校验，并补充边界测试'],
    detail:
      '正文支持换行，长度为 1 至 6000 字符。提交标题取自 PR 标题；该命令不修改 PR 描述。集成提示会展示最终提交信息。署名请使用 /contributor 或 /author，审查署名由有效批准自动生成。',
  },
  contributor: {
    summary: '维护者添加或移除额外共同作者。',
    syntax: ['/contributor add @login', '/contributor add Name <email>', '/contributor remove email'],
    detail:
      '替换用户名或姓名邮箱后发送其中一条命令。账号使用公开邮箱，没有公开邮箱时使用 GitHub noreply 邮箱。最终提交通过 Co-authored-by 署名；移除额外署名不会移除原始 commits 中的作者。',
  },
  author: {
    summary: '维护者记录原作者署名。',
    syntax: ['/author Name <email>'],
    detail:
      '替换为原作者的姓名和邮箱。信息写入 Original-author 和 Co-authored-by；GitHub 的原生 author 字段仍由 GitHub 决定。一般共同创作用 /contributor add 即可。',
  },
  label: {
    summary: '维护者调整标签或恢复自动管理。',
    syntax: ['/label add bug', '/label remove bug', '/label auto bug'],
    detail:
      '将 bug 换成目标标签，每次只处理一个。人工添加或移除会保留；auto 恢复按规则管理。rfr、ready、auto、integrated 由 Piper 管理。移除标签不会降低按文件变更计算的审查和风险要求。',
  },
  tag: {
    summary: '维护者为合并提交创建普通 Tag。',
    syntax: ['/tag candidate'],
    detail:
      '将 candidate 换成标签名。合并前可登记，合并后创建；已有 Tag 不会被覆盖。名称以字母开头，限 80 字符，可包含字母、数字、下划线、点和连字符，不能含 .. 或以 .lock 结尾。v数字 开头的版本 Tag 由发布流程创建。',
  },
  backport: {
    summary: '维护者把已合并的修改移植到另一分支。',
    syntax: ['/backport maintenance'],
    detail:
      '在已合并的原 PR 中发送，将 maintenance 换成仓库配置允许的目标分支。Piper 创建新的 PR；新 PR 仍需 CI 和人工审查。遇到冲突时停止自动移植，按回复提示解决冲突后创建 PR。',
  },
  release: {
    summary: '准备发布、查看部署进度或确认发布。',
    syntax: ['/release prepare', '/release status', '/release publish'],
    detail:
      '1. 维护者在 Issue 或 PR 中用 /release prepare 创建发布 PR。\n2. 在该发布 PR 中完成 CI 和当前提交的人工批准。\n3. 维护者在该发布 PR 中发送 /release publish，用 Merge Commit 保留提交历史。\n4. Piper 等待部署成功，再创建版本 Tag 和 GitHub Release。合并完成不代表版本已发布。\n\n任何可评论用户都可用 /release status 查询进度。部署失败时，维护者查看 Actions 日志，修复并重跑工作流；无需重复发送发布命令。',
  },
};

export const knownCommand = (name: string) => Object.hasOwn(topics, name);

export function commandHelp(topic: string, isPR = true): string {
  const name = topic.trim().replace(/^\//, '').toLowerCase();
  if (name && name !== 'all') {
    if (!knownCommand(name))
      throw new Denied('没有这个帮助主题。请发送 /help 查看常用命令，或 /help all 查看全部命令。');
    const item = topics[name]!;
    return [
      `### /${name} 怎么用`,
      '',
      item.summary,
      '',
      item.detail,
      '',
      '用法（每次只发送其中一条，替换示例参数）：',
      '',
      '```text',
      ...item.syntax,
      '```',
      '',
      usage,
      '',
      maintainer,
    ].join('\n');
  }
  const table = (complete: boolean) => [
    '| 命令 | 作用与权限 |',
    '| --- | --- |',
    ...Object.entries(topics).map(
      ([key, item]) =>
        `| ${complete ? item.syntax.map((syntax) => `\`${syntax}\``).join('<br>') : `\`/${key}\``} | ${item.summary}${key === 'help' ? '' : ` 用 \`/help ${key}\` 查看用法。`} |`,
    ),
  ];
  if (name === 'all')
    return [
      '### Piper 全部命令',
      '',
      usage,
      '',
      '替换示例参数后，每次只发送其中一条命令。',
      '',
      ...table(true),
      '',
      maintainer,
    ].join('\n');
  return [
    '### Piper 常用命令',
    '',
    isPR
      ? '在 PR 对话中新建评论，单独一行输入命令。修改旧评论不会执行命令。'
      : '这里是 Issue。支持 `/help`、`/release prepare` 和 `/release status`；代码相关命令请在 PR 中发送。',
    '',
    '| 操作 | 命令 |',
    '| --- | --- |',
    ...(isPR
      ? [
          '| 合并普通 PR | `/integrate` |',
          '| 确认版本发布（维护者） | `/release publish` |',
          '| 查看审查安排 | `/reviewers` |',
          '| 修改提交正文 | `/summary 正文` |',
        ]
      : []),
    '| 查看发布进度 | `/release status` |',
    '| 查看单个命令的用法 | `/help 命令名` |',
    '| 查看全部命令与权限 | `/help all` |',
    '',
    ...(isPR
      ? [
          '普通 PR 的作者或维护者可用 `/integrate` 尝试一次合并；条件未满足时不会排队。新提交需要重新审查。发布 PR 由维护者使用 `/release publish`。',
          '',
          '审查者：Files changed → Review changes → Approve 或 Request changes。普通评论不算批准。',
        ]
      : []),
  ].join('\n');
}

export const HELP = commandHelp('');
