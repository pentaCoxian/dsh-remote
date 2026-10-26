import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript sources (the `source` export condition).
export default defineConfig({
  resolve: { conditions: ['source', 'import', 'node', 'default'] },
  ssr: { resolve: { conditions: ['source', 'import', 'node', 'default'] } },
});
