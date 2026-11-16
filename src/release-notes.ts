import type { GitHub } from './github';
import { Denied, safeText } from './types';
import { userReference } from './mentions';

interface CommitAuthors {
  nodes: { name: string; email?: string; user?: { login: string; __typename: string } }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}
interface AuthorsResponse {
  data?: { repository?: { object?: { authors?: CommitAuthors } } };
  errors?: unknown[];
}
async function githubAuthors(gh: GitHub, oid: string) {
  const people: { name: string; email?: string; user?: { login: string; __typename: string } }[] = [];
  let after: string | null = null;
  for (let page = 0; page < 100; page++) {
    const result: AuthorsResponse = await gh.read('POST /graphql', {
      query: `query($owner:String!, $name:String!, $oid:GitObjectID!, $after:String) {
        repository(owner:$owner, name:$name) { object(oid:$oid) { ... on Commit {
          authors(first:100, after:$after) { nodes { name email user { login __typename } } pageInfo { hasNextPage endCursor } }
        } } }
      }`,
      variables: { owner: gh.owner, name: gh.name, oid, after },
    });
    const authors: CommitAuthors | undefined = result.data?.repository?.object?.authors;
    if (result.errors?.length || !authors) throw new Denied('无法读取完整 GitHub 共同作者映射');
    people.push(...authors.nodes);
    if (!authors.pageInfo.hasNextPage) return people;
    if (!authors.pageInfo.endCursor || authors.pageInfo.endCursor === after) break;
    after = authors.pageInfo.endCursor;
  }
  throw new Denied('共同作者分页不完整，拒绝遗漏贡献者');
}

// Only verified GitHub accounts become mentions. Unmapped identities are retained
// by name; private email addresses are never printed in the PR.
export async function notesFor(gh: GitHub, base: string, head: string) {
  const commits = await gh.list(
    'GET /repos/{owner}/{repo}/compare/{basehead}',
    { basehead: base + '...' + head },
    'commits',
  );
  const people = new Map<string, { login: string; type: string }>();
  const emails = new Map<string, { login: string; type: string }>();
  const unresolved = new Set<string>();
  const authors: { name: string; email?: string }[] = [];
  const add = (user: { login: string; type: string } | undefined) => {
    if (user?.type === 'User' && /^[a-z\d-]+$/i.test(user.login) && !user.login.toLowerCase().endsWith('-bot'))
      people.set(user.login.toLowerCase(), user);
  };
  const prs = new Map<number, { number: number; title: string }>();
  const direct: string[] = [];
  for (const commit of commits) {
    add(commit.author);
    for (const author of await githubAuthors(gh, commit.sha)) {
      const user = author.user ? { login: author.user.login, type: author.user.__typename } : undefined;
      add(user);
      if (user && author.email) emails.set(author.email.toLowerCase(), user);
      if (!user) authors.push(author);
    }
    if (commit.author && commit.commit.author.email)
      emails.set(commit.commit.author.email.toLowerCase(), commit.author);
    if (!commit.author) authors.push(commit.commit.author);
    for (const match of commit.commit.message.matchAll(/^Co-authored-by:\s*(.*?)\s*<([^<>\s]+)>\s*$/gim))
      authors.push({ name: match[1], email: match[2] });
    const related = await gh.list('GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls', { commit_sha: commit.sha });
    const included = related.filter(
      (p) => p.merged_at && p.base.repo.full_name.toLowerCase() === gh.repo.toLowerCase() && p.base.ref === 'dev',
    );
    for (const pr of included) {
      prs.set(pr.number, pr);
      add(pr.user);
    }
    if (!included.length)
      direct.push(`- ${safeText(commit.commit.message.split('\n')[0]).slice(0, 250)} (${commit.sha.slice(0, 7)})`);
  }
  for (const author of authors) {
    const email = author.email?.toLowerCase();
    let user = email ? emails.get(email) : undefined;
    if (!user && email) {
      const noreply = /^(?:(\d+)\+)?([a-z\d-]+)@users\.noreply\.github\.com$/i.exec(email);
      if (noreply) {
        try {
          const profile = await gh.read('GET /users/{username}', { username: noreply[2] });
          if (!noreply[1] || String(profile.id) === noreply[1]) user = profile;
        } catch (error) {
          if ((error as { status?: number }).status !== 404) throw error;
        }
      } else if (/^[^\s<>"\\]+@[^\s<>"\\]+$/.test(email)) {
        const result = await gh.read('GET /search/users', { q: 'in:email "' + email + '"', per_page: 2 });
        if (!result.incomplete_results && result.total_count === 1) {
          const profile = await gh.read('GET /users/{username}', { username: result.items[0].login });
          if (profile.email?.toLowerCase() === email) user = profile;
        }
      }
      if (user) emails.set(email, user);
    }
    if (user) add(user);
    else if (!/\[bot\]|\bbot\b/i.test(author.name)) unresolved.add(safeText(author.name));
  }
  const lines = [
    '## 主要变更',
    '',
    ...[...prs.values()].sort((a, b) => a.number - b.number).map((p) => `- ${safeText(p.title)} (#${p.number})`),
    ...direct,
    '',
    '## 感谢贡献者',
    '',
    [...people.values()]
      .sort((a, b) => a.login.localeCompare(b.login))
      .map((p) => userReference(p, true))
      .join('、') || '暂无可映射的 GitHub 用户。',
    ...(unresolved.size ? ['', '未能可靠映射 GitHub 账号：' + [...unresolved].sort().join('、') + '。'] : []),
    '',
    `[本次比较](https://github.com/${gh.repo}/compare/${base}...${head})`,
  ];
  const notes = lines.join('\n');
  if (notes.length > 50000) throw new Denied('发布说明超过上限，需拆分发布');
  return notes;
}
