// Compile protocol/native-v1.schema.json (the authoritative contract) into src/schema-data.ts,
// so the schema ships inside bundles that have no repo around them (the plugin release).
//   pnpm --filter @dsh-remote/protocol schema
import { readFileSync, writeFileSync } from 'node:fs';

const json = JSON.parse(readFileSync(new URL('../../../protocol/native-v1.schema.json', import.meta.url), 'utf8')) as unknown;
writeFileSync(
  new URL('../src/schema-data.ts', import.meta.url),
  `// GENERATED from protocol/native-v1.schema.json by scripts/gen-schema.ts; do not edit.\n` +
    `// test/protocol.test.ts fails when the two differ.\n` +
    `export const SCHEMA: { $id: string; $defs: Record<string, unknown>; [key: string]: unknown } = ${JSON.stringify(json, null, 2)};\n`,
);
console.log('wrote src/schema-data.ts');
