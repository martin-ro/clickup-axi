#!/usr/bin/env node
import { VERSION } from './version.mjs';

process.stdout.on('error', error => process.exit(error.code === 'EPIPE' ? 0 : 1));
const argv = process.argv.slice(2);
if (argv.length === 1 && ['-v', '-V', '--version'].includes(argv[0])) {
  process.stdout.write(`${VERSION}\n`);
} else {
  const { main } = await import('./cli.mjs');
  await main(argv, { execPath: process.argv[1] });
}
