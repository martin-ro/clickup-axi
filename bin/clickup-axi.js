#!/usr/bin/env node
import { VERSION } from '../src/version.js';

process.stdout.on('error', error => process.exit(error.code === 'EPIPE' ? 0 : 1));
const argv = process.argv.slice(2);
if (argv.length === 1 && ['-v', '-V', '--version'].includes(argv[0])) {
  process.stdout.write(`${VERSION}\n`);
} else {
  const { main } = await import('../src/cli.js');
  await main(argv);
}
