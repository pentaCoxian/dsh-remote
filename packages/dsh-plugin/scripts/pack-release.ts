// Build the installable plugin: release/dsh-remote-dsh-plugin-<version>.tgz, which DSH
// installs with `dsh plugin --profile web add <path>` (next to dsh-mobile-maxxing), and
// release/install.mjs, the standalone installer that does that from checked local files.
// The workspace packages (protocol, iroh-http) and ajv are bundled in; @number0/iroh (native
// binaries per platform), qrcode and ws stay npm dependencies, installed by DSH's pnpm.
//   pnpm --filter @dsh-remote/dsh-plugin pack:release
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { build } from 'rolldown';
import { MOBILE_UI } from '../src/dsh/mobile-ui.ts';

const root = new URL('..', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { version: string; description: string; engines: Record<string, string>; dependencies: Record<string, string>; dsh: unknown };
const external = ['@number0/iroh', 'qrcode', 'ws'];
const out = `${root}release/package`;
rmSync(`${root}release`, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  input: { index: `${root}src/index.ts`, cli: `${root}src/cli/main.ts` },
  platform: 'node',
  external: [...external, /^node:/],
  resolve: { conditionNames: ['source', 'import', 'node', 'default'] },
  output: { dir: `${out}/dist`, format: 'esm', entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js' },
});
// The installer runs before anything is installed: one file, Node built-ins only.
await build({
  input: `${root}src/install/main.ts`,
  platform: 'node',
  external: [/^node:/],
  resolve: { conditionNames: ['source', 'import', 'node', 'default'] },
  output: { file: `${root}release/install.mjs`, format: 'esm', codeSplitting: false },
});
for (const script of [`${out}/dist/cli.js`, `${root}release/install.mjs`]) {
  const text = readFileSync(script, 'utf8');
  if (!text.startsWith('#!')) writeFileSync(script, `#!/usr/bin/env node\n${text}`);
  chmodSync(script, 0o755);
}

writeFileSync(`${out}/package.json`, `${JSON.stringify({
  name: '@dsh-remote/dsh-plugin',
  version: pkg.version,
  description: pkg.description,
  license: 'MIT',
  repository: { type: 'git', url: 'git+https://github.com/pentaCoxian/dsh-remote.git' },
  type: 'module',
  engines: pkg.engines,
  exports: { '.': './dist/index.js', './client': './client/client.js' },
  bin: { 'dsh-remote': './dist/cli.js' },
  files: ['dist', 'client', 'cordis.patch.yml', 'README.md', 'LICENSE'],
  dependencies: Object.fromEntries(external.map((name) => [name, pkg.dependencies[name]])),
  dsh: pkg.dsh,
}, null, 2)}\n`);
copyFileSync(`${root}cordis.patch.yml`, `${out}/cordis.patch.yml`);
// DSH Web's half (the /rc pairing dialog) is served verbatim.
mkdirSync(`${out}/client`);
copyFileSync(`${root}client/client.js`, `${out}/client/client.js`);
copyFileSync(`${root}../../LICENSE`, `${out}/LICENSE`);
writeFileSync(`${out}/README.md`, `# DSH Remote plugin ${pkg.version}

Use DeepSeek Harness Web from the DSH Remote phone app, end-to-end encrypted over iroh.

\`\`\`sh
curl -fsSL https://github.com/pentaCoxian/dsh-remote/releases/download/v${pkg.version}/install.mjs | node --input-type=module -
\`\`\`

Then restart DSH and send \`/rc\` in DSH Web to pair a phone. The installer also adds
dsh-mobile-maxxing ${MOBILE_UI.version} (DSH Web's phone layout), which DSH Remote requires; \`dsh-remote upgrade\`
updates both, and \`dsh-remote doctor\` checks the setup.
`);
for (const name of external) if (pkg.dependencies[name] === undefined) throw new Error(`${name} is not a dependency of the plugin`);

execFileSync('npm', ['pack', '--pack-destination', `${root}release`, '--silent'], { cwd: out, stdio: ['ignore', 'pipe', 'inherit'] });
console.log(`wrote release/dsh-remote-dsh-plugin-${pkg.version}.tgz and release/install.mjs`);
