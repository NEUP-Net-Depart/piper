import { backport } from './backport';
import { GitHub } from './github';
import { assign, filesFor, gate, getPR, integrate, removeReviewer, tagPR } from './pulls';
import { assertManualLabel, reviewPolicy } from './labels';
import { listReleases, prepareRelease, publishRelease, releaseStatusMessage } from './releases';
import { prState, type CommandState } from './records';
import { Denied, safeText, type Identity } from './types';
import { profile } from './mentions';

import { commandHelp, knownCommand } from './help';
export { HELP } from './help';

export interface Command { name: string; args: string }
export function commandResult({ name, args }: Command) {
  const results: Record<string, string> = {
    summary: '提交摘要已更新。就绪后可在通知中核对最终提交信息。', author: '原作者署名已更新。', contributor: '共同作者署名已更新。',
    reviewers: '审查请求已更新。', label: '标签已更新。', tag: 'Tag 设置已完成。',
    integrate: ['cancel', 'manual'].includes(args) ? '已取消通过命令登记的自动集成请求。仓库在 `.piper.yml` 中配置的自动集成规则仍按配置生效。' : args === 'auto' ? '已为当前提交启用自动集成，条件满足后 Piper 会重新核验并尝试合并。新提交会使本次请求失效；可用 `/integrate manual` 或 `/integrate cancel` 取消。' : '请查看协作进度。'
  };
  return results[name] ?? '命令已完成。';
}
export function parseCommand(body: string): Command | null {
  if (body.length > 10000) throw new Denied('命令过长');
  const lines = body.split(/\r?\n/), found: { index: number; name: string; args: string }[] = [];
  let fence = '', inComment = false, htmlCode = '', quoted = false;
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index]!;
    if (fence) {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
      if (closing && closing[0] === fence[0] && closing.length >= fence.length) fence = '';
      continue;
    }
    if (/^ {0,3}>/.test(line)) { quoted = true; continue; }
    if (quoted) { if (!line.trim()) quoted = false; continue; }
    if (htmlCode) { if (new RegExp(`</${htmlCode}\\s*>`, 'i').test(line)) htmlCode = ''; continue; }
    const html = /<(pre|code)(?:\s|>)/i.exec(line);
    if (!fence && html) { if (!new RegExp(`</${html[1]}\\s*>`, 'i').test(line)) htmlCode = html[1]!.toLowerCase(); continue; }
    let clean = '';
    while (line) {
      if (inComment) { const end = line.indexOf('-->'); if (end < 0) break; line = line.slice(end + 3); inComment = false; }
      const start = line.indexOf('<!--');
      if (start < 0) { clean += line; break; }
      clean += line.slice(0, start); line = line.slice(start + 4); inComment = true;
    }
    line = clean;
    if (/^(?: {4}|\t|\s*>)/.test(line)) continue;
    const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter) { fence = delimiter; continue; }
    const match = /^ {0,3}\/([a-z]+)(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
    if (match) found.push({ index, name: match[1]!, args: match[2] ?? '' });
  }
  if (found.length > 1) throw new Denied('每条评论只执行一个命令，请分别发送');
  const command = found[0];
  return command ? { name: command.name, args: [command.args, ...lines.slice(command.index + 1)].join('\n').trim() } : null;
}
function identity(value: string): Identity {
  const m = /^([^<>\r\n]{1,100}) <([^\s<>@]+@[^\s<>@]+)>$/.exec(value);
  if (!m) throw new Denied('身份格式应为 Name <email>，且不得包含换行。添加贡献者也可使用 /contributor add @login。');
  return { name: m[1]!.trim(), email: m[2]! };
}
export async function executeCommand(gh: GitHub, number: number, actor: string, command: Command, isPR: boolean) {
  gh.actor = actor;
  const { name, args } = command;
  gh.commandName = name;
  gh.commandResult = undefined;
  const reply = (text: string) => gh.reply(number, text, actor);
  const requireMaintainer = async () => { if (!(await gh.maintainer(actor))) throw new Denied(`该命令需要仓库 write / maintain / admin 权限。请维护者执行；可发送 /help ${name} 查看用法。`); };
  const pinHead = async (head: string) => {
    if (gh.dryRun) return;
    const original = await gh.record(number, `command-head:${gh.job}`, { head });
    if (original?.head !== head) throw new Denied('命令首次处理后 PR 已更新，请发送新命令');
  };
  if (!knownCommand(name)) throw new Denied(`未知命令 \`/${name}\`。请发送 \`/help\` 查看常用命令，或 \`/help all\` 查看全部命令。`);
  if (name === 'help') { await reply(commandHelp(args, isPR)); return; }
  if (name === 'release') {
    if (args === 'status') {
      const rows = (await listReleases(gh)).slice(0, 5);
      await reply(rows.length ? rows.map(r => releaseStatusMessage(gh, r)).join('\n\n---\n\n') : gh.config!.release.enabled ? '尚无发布记录。需要发布时，请维护者发送 `/release prepare` 创建发布 PR。' : '尚无发布记录，当前仓库未启用 Piper 发布。请维护者确认仓库的发布方式。');
    } else {
      await requireMaintainer();
      if (args === 'prepare') {
        const at = new Date().toISOString();
        const plan = await gh.record(number, 'release-prepare:' + gh.job, { at });
        const row = await prepareRelease(gh, new Date(plan?.at ?? at), true);
        await reply(row ? releaseStatusMessage(gh, row) : '当前没有待发布变更，或本次为 Dry-run（详见审计）。');
      } else if (args === 'publish' && isPR) { await pinHead((await getPR(gh, number)).head.sha); await publishRelease(gh, number, actor); await reply(gh.commandResult ?? '发布请求已核验。部署结果可通过 `/release status` 查询。'); }
      else throw new Denied('使用 /release prepare、/release status 或在发布 PR 内使用 /release publish');
    }
    return;
  }
  if (!isPR) throw new Denied(`命令 /${name} 只能用于 PR 对话。请在正确的位置新建评论，发送 /help 查看命令。`);
  const pr = await getPR(gh, number);
  const metadata = (await prState(gh, pr)).metadata;
  const authorOrMaintainer = async () => {
    if (actor.toLowerCase() !== pr.user.login.toLowerCase() && !(await gh.maintainer(actor))) throw new Denied('该命令需要 PR 作者或仓库维护者执行。维护者须具有 write、maintain 或 admin 权限。');
  };
  const save = async (change: CommandState['change']) => {
    if (!gh.commandOrder) throw new Denied('Missing verified command comment ID');
    await gh.record(number, `command-state:${gh.job}`, { order: gh.commandOrder, actor, head: pr.head.sha, change } satisfies CommandState);
  };
  switch (name) {
    case 'integrate': {
      await authorOrMaintainer();
      if (args && !['auto', 'manual', 'cancel'].includes(args)) throw new Denied('立即合并用 /integrate；等待条件满足后合并用 /integrate auto；取消自动请求用 /integrate cancel。发送 /help integrate 查看权限和示例。');
      if (args === 'auto') await requireMaintainer();
      if (pr.state !== 'open' && !pr.merged) throw new Denied('PR 已关闭且未合并。需要继续时请先重新打开 PR，完成最新提交的检查和审查，再发送命令。');
      await gh.guard();
      if (['cancel', 'manual'].includes(args)) {
        await save({ kind: 'integrate', cancelled: true });
        gh.commandResult = '已取消通过命令登记的自动集成请求。' + (gh.config!.merge.auto ? '仓库仍启用了独立的自动集成规则；需要暂停它时，请维护者调整 `.piper.yml` 中的 `merge.auto`。' : '准备好后可发送 `/integrate` 立即尝试合并。');
        return;
      }
      await pinHead(pr.head.sha);
      if (pr.merged) { await integrate(gh, number, actor, pr.head.sha); return; }
      await save({ kind: 'integrate', cancelled: false, mode: args === 'auto' ? 'auto' : 'manual' });
      const intent = await prState(gh, pr);
      if (gh.dryRun || (intent.integrate_head === pr.head.sha && intent.integrate_actor === actor)) await integrate(gh, number, actor, pr.head.sha);
      return;
    }
    case 'reviewers': {
      if (!args || /^\d+$/.test(args)) {
        if (!args) {
          const release = gh.config!.release.enabled && pr.base.ref === gh.config!.release.target;
          const result = await gate(gh, pr, release);
          const review = result.progress.find(p => p.name === '人工审查')!;
          await reply([`### 当前审查进度`, '', review.detail + '。', '', `已批准当前提交：${result.reviewers.map(profile).join('、') || '暂无'}。`, `等待审查：${pr.requested_reviewers.map(x => profile(x.login)).join('、') || '暂无'}。`, '', pr.state !== 'open' ? '此 PR 已结束，无需继续请求审查。' : pr.draft ? '作者准备好后，点击 Ready for review 开始正式审查。' : review.ready ? '人工审查已满足。请查看协作状态中的其他检查和下一步操作。' : `${review.owner}：${safeText(review.action!)}`, '', '普通评论不算批准。需要邀请或交接审查者时，发送 `/help reviewers` 查看用法。'].join('\n'));
          return;
        }
        await requireMaintainer(); const value = Number(args);
        const floor = Math.max(reviewPolicy(gh.config!, pr, await filesFor(gh, number)).minimum, gh.config!.release.enabled && pr.base.ref === gh.config!.release.target ? gh.config!.release.minApprovals : 1);
        if (value < floor || value > 10) throw new Denied(`所需批准人数必须为 ${floor}–10，不能低于仓库或模块要求。请使用 /reviewers 数字。`);
        await save({ kind: 'reviewers-count', value }); gh.commandResult = `所需批准人数已设为 ${value}。批准须来自有写权限、非作者、非 Bot 的人工审查者，并覆盖当前提交。`; return;
      }
      await requireMaintainer();
      if (pr.draft || pr.state !== 'open') throw new Denied(pr.draft ? 'PR 仍为草稿。请作者点击 Ready for review 后，再邀请审查者。' : 'PR 已关闭，不能邀请或交接审查者。需要继续时请先重新打开 PR。');
      const [action, ...people] = args.split(/\s+/);
      if (!people.every(x => /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(x))) throw new Denied('请使用 GitHub 用户名，不带 @，多人用空格分隔。审查者需要仓库 write、maintain 或 admin 权限。发送 /help reviewers 查看示例。');
      if (action === 'add' && people.length >= 1 && people.length <= 10) {
        for (const person of people) if (!(await gh.maintainer(person))) throw new Denied('审查者必须使用有效的 GitHub 登录名，并具有仓库 write、maintain 或 admin 权限。');
        const selected = await assign(gh, pr, [...new Set(people)]);
        gh.commandResult = `已请求 ${selected.map(profile).join('、')} 审查当前 PR。审查者请在 Files changed → Review changes 中提交批准或修改意见。`;
      } else if (action === 'handoff' && people.length === 2 && people[0]!.toLowerCase() !== people[1]!.toLowerCase()) {
        const transferKey = `handoff:${gh.job}`;
        const transfer = await gh.getRecord(number, transferKey);
        if (!transfer && !pr.requested_reviewers.some(r => r.login.toLowerCase() === people[0]!.toLowerCase())) throw new Denied('原审查者不在待审查列表。先用 /reviewers 查看当前请求；若只需新增审查者，使用 /reviewers add 用户名。');
        if (!(await gh.maintainer(people[1]!))) throw new Denied('新审查者需要仓库写权限');
        await gh.record(number, transferKey, { from: people[0], to: people[1] });
        const selected = await assign(gh, pr, [people[1]!]);
        if (selected.length) {
          await removeReviewer(gh, pr, people[0]!, gh.job);
          gh.commandResult = `已将审查请求从 ${profile(people[0]!)} 交接给 ${profile(people[1]!)}。新审查者请在 Files changed → Review changes 中提交批准或修改意见。`;
        }
      } else throw new Denied('邀请审查者用 /reviewers add 用户名；交接用 /reviewers handoff 原用户名 新用户名。用户名不带 @。发送 /help reviewers 查看示例。');
      return;
    }
    case 'contributor': {
      await requireMaintainer();
      if (args.startsWith('add ')) {
        const requested = args.slice(4);
        let value: Identity;
        if (/^@[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(requested)) {
          const person = await gh.read('GET /users/{username}', { username: requested.slice(1) });
          if (person.type !== 'User' || !Number.isSafeInteger(person.id) || person.id <= 0 || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(person.login)) throw new Denied('贡献者必须是有效的 GitHub 用户');
          value = identity(`${(person.name || person.login).trim()} <${person.email || `${person.id}+${person.login}@users.noreply.github.com`}>`);
        } else value = identity(requested);
        if ((metadata.contributors ?? []).filter(x => x.email.toLowerCase() !== value.email.toLowerCase()).length >= 20) throw new Denied('最多 20 位额外贡献者');
        await save({ kind: 'contributor-add', value }); gh.commandResult = `已添加共同作者 ${safeText(value.name)} <${safeText(value.email)}>。`;
      } else if (args.startsWith('remove ')) { await save({ kind: 'contributor-remove', value: args.slice(7) }); gh.commandResult = `已移除额外共同作者：${safeText(args.slice(7))}。原始提交中的作者归属仍会保留。`; }
      else throw new Denied('添加共同作者用 /contributor add @用户名 或 /contributor add 姓名 <邮箱>；移除额外共同作者用 /contributor remove 邮箱。发送 /help contributor 查看示例。');
      return;
    }
    case 'author':
      await requireMaintainer(); await save({ kind: 'author', value: identity(args) });
      await reply('原作者归属已更新，将写入 Original-author 和 Co-authored-by。GitHub Squash 的原生 author 字段仍由 GitHub 决定。'); return;
    case 'summary':
      await authorOrMaintainer();
      if (!args || args.length > 6000 || /^(?:Co-authored-by|Reviewed-by|Original-author):/im.test(args)) throw new Denied('提交摘要须为 1 至 6000 字符；身份 trailer（Co-authored-by、Reviewed-by 和 Original-author）请使用对应署名或审查流程设置。');
      await save({ kind: 'summary', value: args }); return;
    case 'label': {
      await requireMaintainer();
      const m = /^(add|remove|auto) ([^\r\n]{1,50})$/.exec(args);
      if (!m) throw new Denied('每次处理一个标签：/label add bug 添加，/label remove bug 移除，/label auto bug 恢复自动管理。请把 bug 替换为目标标签。');
      assertManualLabel(m[2]!);
      await save({ kind: 'label', name: m[2]!, mode: m[1] as 'add' | 'remove' | 'auto', at: new Date().toISOString() });
      if (m[1] === 'add') await gh.setLabels(number, [m[2]!], `label:${gh.job}`);
      else if (m[1] === 'remove') await gh.write(`label-remove:${gh.job}`, 'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', { issue_number: number, name: m[2] }, async () => {
        const current = await gh.list('GET /repos/{owner}/{repo}/issues/{issue_number}/labels', { issue_number: number });
        return current.some(x => x.name === m[2]) ? undefined : current;
      });
      gh.commandResult = `标签 ${safeText(m[2]!)}：${m[1] === 'auto' ? '已恢复自动规则' : m[1] === 'add' ? '已添加并保留人工设置。需要重新交给自动规则时，请使用 /label auto 标签名' : '已移除并保留人工设置。移除展示标签不会降低按修改范围计算的审查及风险要求'}。`;
      return;
    }
    case 'tag':
      await requireMaintainer();
      if (!/^[a-zA-Z][\w.-]{0,79}$/.test(args) || /^v\d/.test(args) || args.includes('..') || args.endsWith('.lock')) throw new Denied('普通 Tag 须为 1 至 80 个字符，以英文字母开头，其余只能使用英文字母、数字、下划线、点和连字符；不能含 ..、以 .lock 结尾或以 v数字开头。版本 Tag 请使用发布流程。');
      if (pr.merged) {
        await tagPR(gh, pr, args);
        gh.commandResult = `普通 Tag \`${args}\` 已指向提交 [\`${pr.merge_commit_sha!.slice(0, 12)}\`](https://github.com/${gh.repo}/commit/${pr.merge_commit_sha})。`;
      } else {
        await save({ kind: 'tag', value: args });
        gh.commandResult = `已登记普通 Tag \`${args}\`，合并后将指向该 PR 的实际合并提交。`;
      } return;
    case 'backport': {
      await requireMaintainer(); const result = await backport(gh, pr, args);
      await reply(result ? `Backport PR：[#${result.number}](https://github.com/${gh.repo}/pull/${result.number})，目标分支 ${safeText(args)}。该 PR 需要重新通过 CI 与人工审查。` : 'Backport 为 Dry-run，详见审计。'); return;
    }
    default: throw new Denied(`未知命令 \`/${name}\`。请使用 \`/help\` 查看可用命令列表。`);
  }
}
