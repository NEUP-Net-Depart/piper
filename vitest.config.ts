import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      main: './src/index.ts',
      miniflare: {
        compatibilityDate: '2026-10-01',
        compatibilityFlags: ['nodejs_compat'],
        durableObjects: { COORDINATORS: { className: 'TaskCoordinator', useSQLite: true } },
        bindings: {
          ALLOWED_REPOSITORIES: 'NEUP-Net-Depart/Pioneer-appointment-system',
          EMERGENCY_STOP: 'false',
          STOPPED_REPOSITORIES: '',
        },
      },
    }),
  ],
  test: { testTimeout: 20000, fileParallelism: false },
}));
