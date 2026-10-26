import { expect, it, vi } from 'vitest';
import { appApi, installationApi } from '../src/github';
import { repo, testEnv } from './fixtures';

it('authenticates Octokit with an App JWT and installation token inside Workers', async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const key = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  const encoded = btoa(String.fromCharCode(...key));
  const pem = `-----BEGIN PRIVATE KEY-----\n${encoded.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----`;
  const http = vi.fn(async (url: string, init: RequestInit) => {
    const authorization = new Headers(init.headers).get('authorization')!;
    if (url === 'https://api.github.com/app/installations/1/access_tokens' && init.method === 'POST') {
      expect(authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/i);
      return Response.json(
        { token: 'fixture-installation-token', expires_at: new Date(Date.now() + 3600000).toISOString() },
        { status: 201 },
      );
    }
    if (url === `https://api.github.com/repos/${repo}` && init.method === 'GET') {
      expect(authorization).toBe('token fixture-installation-token');
      return Response.json({ full_name: repo });
    }
    if (url === `https://api.github.com/repos/${repo}/installation` && init.method === 'GET') {
      expect(authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/i);
      return Response.json({ id: 1 });
    }
    throw new Error(`Unexpected HTTP request: ${url}`);
  });
  vi.stubGlobal('fetch', http);
  try {
    const api = installationApi(testEnv({ APP_PRIVATE_KEY: pem }), 1);
    const result = await api.request('GET /repos/{owner}/{repo}', {
      owner: 'NEUP-Net-Depart',
      repo: 'Pioneer-appointment-system',
    });
    expect(result.data.full_name).toBe(repo);
    const discovered = await appApi(testEnv({ APP_PRIVATE_KEY: pem })).request(
      'GET /repos/{owner}/{repo}/installation',
      { owner: 'NEUP-Net-Depart', repo: 'Pioneer-appointment-system' },
    );
    expect(discovered.data.id).toBe(1);
    expect(http).toHaveBeenCalledTimes(3);
  } finally {
    vi.unstubAllGlobals();
  }
});
