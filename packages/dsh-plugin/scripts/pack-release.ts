// Build the installable plugin: release/dsh-remote-dsh-plugin-<version>.tgz, which DSH
// installs with `dsh plugin --profile web add <path or URL>` (next to dsh-mobile-maxxing).
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
const cli = `${out}/dist/cli.js`;
const cliText = readFileSync(cli, 'utf8');
if (!cliText.startsWith('#!')) writeFileSync(cli, `#!/usr/bin/env node\n${cliText}`);
chmodSync(cli, 0o755);

writeFileSync(`${out}/package.json`, `${JSON.stringify({
  name: '@dsh-remote/dsh-plugin',
  version: pkg.version,
  description: pkg.description,
  type: 'module',
  engines: pkg.engines,
  exports: { '.': './dist/index.js' },
  bin: { 'dsh-remote': './dist/cli.js' },
  files: ['dist', 'cordis.patch.yml', 'README.md'],
  dependencies: Object.fromEntries(external.map((name) => [name, pkg.dependencies[name]])),
  dsh: pkg.dsh,
}, null, 2)}\n`);
copyFileSync(`${root}cordis.patch.yml`, `${out}/cordis.patch.yml`);
writeFileSync(`${out}/README.md`, `# DSH Remote plugin ${pkg.version}

Use DeepSeek Harness Web from the DSH Remote phone app, end-to-end encrypted over iroh.

\`\`\`sh
dsh plugin --profile web add ./dsh-remote-dsh-plugin-${pkg.version}.tgz ${MOBILE_UI.tarball}
\`\`\`

Then restart DSH. It requires dsh-mobile-maxxing ${MOBILE_UI.minVersion}+ (DSH Web's phone layout), installed by the
same command; \`dsh-remote doctor\` checks the setup.
`);
for (const name of external) if (pkg.dependencies[name] === undefined) throw new Error(`${name} is not a dependency of the plugin`);

execFileSync('npm', ['pack', '--pack-destination', `${root}release`, '--silent'], { cwd: out, stdio: ['ignore', 'pipe', 'inherit'] });
console.log(`wrote release/dsh-remote-dsh-plugin-${pkg.version}.tgz`);
