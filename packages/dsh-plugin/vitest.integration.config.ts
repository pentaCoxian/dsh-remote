import { defineConfig } from 'vitest/config';

// End-to-end against the pinned DSH host (`pnpm test:dsh`); slow, so not part of `pnpm test`.
export default defineConfig({
  resolve: { conditions: ['source', 'import', 'node', 'default'] },
  ssr: { resolve: { conditions: ['source', 'import', 'node', 'default'] } },
  test: { include: ['test/integration/**/*.itest.ts'], testTimeout: 120_000, hookTimeout: 180_000 },
});
