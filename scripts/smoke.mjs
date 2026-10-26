const base = new URL(process.env.PIPER_WORKER_URL);
if (base.protocol !== 'https:') throw new Error('HTTPS Worker URL required');
const health = await fetch(new URL('/health', base), { signal: AbortSignal.timeout(15000) });
const data = await health.json();
if (!health.ok || data.status !== 'ok' || data.service !== 'piper' || data.environment !== 'production')
  throw new Error('Health, coordinator or environment mismatch');
const signature = await fetch(new URL('/webhooks/github', base), {
  method: 'POST',
  body: '{}',
  signal: AbortSignal.timeout(15000),
});
if (signature.status !== 401) throw new Error('Unsigned webhook was not rejected');
const admin = await fetch(new URL('/admin/status', base), { signal: AbortSignal.timeout(15000) });
if (admin.status !== 401) throw new Error('Unauthenticated admin request was not rejected');
console.log(`Smoke passed for ${data.environment}: health, webhook signature, admin authentication.`);
