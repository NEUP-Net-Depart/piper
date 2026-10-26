import { safeText } from './types';

type User = { login: string; type: string };

export function profile(login: string) {
  const label = safeText(login).replace(/([\\`*_{}[\]()|~<>])/g, '\\$1');
  return `[${label}](https://github.com/${encodeURIComponent(login)})`;
}

export function userReference(user: User, notify = false) {
  const valid = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(user.login) && !user.login.includes('--');
  return notify && user.type === 'User' && valid ? '@' + user.login : profile(user.login);
}

export function addressUser(user: User, body: string) {
  if (user.type !== 'User') return body;
  const recipient = userReference(user, true);
  const prefix = body.slice(0, recipient.length + 1).toLowerCase();
  return prefix === recipient.toLowerCase() + ' ' || prefix === recipient.toLowerCase() + '\n'
    ? body
    : recipient + '\n\n' + body;
}
