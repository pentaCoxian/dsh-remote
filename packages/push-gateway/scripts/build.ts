// Bundle the gateway into dist/gateway.mjs for deployment. Workspace packages are
// inlined from their TypeScript sources; only @number0/iroh (native) stays external.
import { build } from 'rolldown';

await build({
  input: new URL('../src/main.ts', import.meta.url).pathname,
  platform: 'node',
  external: ['@number0/iroh', /^node:/],
  resolve: { conditionNames: ['source', 'import', 'node', 'default'] },
  output: { file: new URL('../dist/gateway.mjs', import.meta.url).pathname, format: 'esm' },
});
console.log('wrote dist/gateway.mjs');
