import { safeText, type Metadata, type PR } from './types';
import type { GitHub } from './github';
import { addressUser } from './mentions';

export function commitMessage(pr: PR, metadata: Metadata, reviewers: string[], authors: { name: string; email: string; login?: string }[]) {
  const title = `${safeText(pr.title.replace(/[\r\n\t]+/g, ' ').trim())} (#${pr.number})`;
  const identities = new Map<string, { name: string; email: string }>();
  for (const a of [...authors, ...(metadata.contributors ?? []), ...(metadata.author ? [metadata.author] : [])]) {
    if (!/[\r\n<>]/.test(a.name) && /^[^\s<>@]+@[^\s<>@]+$/.test(a.email)) identities.set(a.email.toLowerCase(), a);
  }
  const primary = authors.find(a => (a.login ?? a.name).toLowerCase() === pr.user.login.toLowerCase()) ?? (new Set(authors.map(a => a.email.toLowerCase())).size === 1 ? authors[0] : undefined);
  const principal = primary?.email.toLowerCase();
  const trailers = [...identities.values()].filter(a => a.email.toLowerCase() !== principal).map(a => `Co-authored-by: ${a.name} <${a.email}>`);
  if (metadata.author) trailers.unshift(`Original-author: ${metadata.author.name} <${metadata.author.email}>`);
  trailers.push(...reviewers.map(r => `Reviewed-by: ${r}`));
  const summary = safeText(metadata.summary?.trim() ?? '');
  return { commit_title: title, commit_message: [summary, trailers.join('\n')].filter(Boolean).join('\n\n') };
}

export function integratedMessage(gh: Pick<GitHub, 'repo' | 'config' | 'env'>, pr: PR, sha = pr.merge_commit_sha) {
  const welcome = gh.config!.welcome;
  const image = welcome.image.startsWith('/') ? new URL(welcome.image, gh.env.PUBLIC_URL).href : welcome.image;
  const release = gh.config!.release.enabled && pr.base.ref === gh.config!.release.target;
  return addressUser(pr.user, [safeText(welcome.merged), `已集成到 \`${safeText(pr.base.ref)}\`：[${sha?.slice(0, 12)}](https://github.com/${gh.repo}/commit/${sha})`, release ? '代码已合并；版本是否已发布，请在新评论中发送 `/release status` 查询。Piper 仅在部署成功后创建版本 Tag 和 Release。' : '此 PR 的合并已完成，无需再次发送集成命令。', welcome.merged && image ? `![庆祝合并](${image})` : ''].filter(Boolean).join('\n\n'));
}
