// This prints a manifest. It never registers an App or sends requests.
const base = process.argv[2];
if (!base || process.argv.length !== 3)
  throw new Error('Usage: npm run manifest -- https://piper-production.example.workers.dev');
const origin = new URL(base);
if (
  origin.protocol !== 'https:' ||
  origin.username ||
  origin.password ||
  origin.search ||
  origin.hash ||
  origin.pathname !== '/'
)
  throw new Error('Worker URL must be an HTTPS origin');
console.log(
  JSON.stringify(
    {
      name: 'NEUP Piper',
      url: 'https://github.com/NEUP-Net-Depart/piper',
      hook_attributes: { url: new URL('/webhooks/github', base).href, active: true },
      redirect_url: 'https://github.com/NEUP-Net-Depart/piper',
      public: false,
      default_permissions: {
        contents: 'write',
        issues: 'write',
        pull_requests: 'write',
        checks: 'read',
        statuses: 'read',
        actions: 'read',
        metadata: 'read',
      },
      default_events: [
        'pull_request',
        'pull_request_review',
        'issue_comment',
        'issues',
        'check_run',
        'check_suite',
        'status',
        'push',
        'workflow_run',
      ],
    },
    null,
    2,
  ),
);
