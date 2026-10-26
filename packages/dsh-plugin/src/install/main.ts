#!/usr/bin/env node
// Install or upgrade DSH Remote (and dsh-mobile-maxxing, which it requires) in DSH:
//   curl -fsSL https://github.com/pentaCoxian/dsh-remote/releases/latest/download/install.mjs | node --input-type=module - [version] [--profile web]
// Restart DSH afterwards to load them.
import { install } from './installer.ts';

const args = process.argv.slice(2);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const version = args.find((arg, i) => !arg.startsWith('--') && !(i > 0 && args[i - 1]!.startsWith('--')));
try {
  const result = await install({
    ...(version === undefined ? {} : { version: version.replace(/^v/, '') }),
    ...(option('--profile') === undefined ? {} : { profile: option('--profile')! }),
    ...(option('--from') === undefined ? {} : { from: option('--from')! }),
    log: (line) => process.stdout.write(`dsh-remote: ${line}\n`),
  });
  process.stdout.write(`\nDSH Remote ${result.version} is installed. Restart DSH (dsh web) to load it, then run /rc in DSH Web.\n`);
} catch (error) {
  process.stderr.write(`dsh-remote: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
