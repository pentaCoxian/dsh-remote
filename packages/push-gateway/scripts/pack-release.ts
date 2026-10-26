// The gateway as a release artifact: release/dsh-remote-push-gateway-<version>.tgz holds the
// bundle (gateway.mjs), a package.json whose only dependency is @number0/iroh, and a lockfile
// with every platform's integrity hash, for `npm ci --omit=dev` on the server (infra/push/deploy.sh).
//   pnpm --filter @dsh-remote/push-gateway pack:release
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { version: string; dependencies: Record<string, string> };
const out = `${root}release/package`;
rmSync(`${root}release`, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
execFileSync(process.execPath, [`${root}scripts/build.ts`], { stdio: 'inherit' });
copyFileSync(`${root}dist/gateway.mjs`, `${out}/gateway.mjs`);
writeFileSync(`${out}/package.json`, `${JSON.stringify({ name: 'dshr-push', version: pkg.version, private: true, type: 'module', dependencies: { '@number0/iroh': pkg.dependencies['@number0/iroh'] } }, null, 2)}\n`);
execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--silent'], { cwd: out, stdio: 'inherit' });
const file = `dsh-remote-push-gateway-${pkg.version}.tgz`;
execFileSync('tar', ['--no-xattrs', '-czf', `${root}release/${file}`, '-C', out, 'gateway.mjs', 'package.json', 'package-lock.json'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
console.log(`wrote release/${file}`);
