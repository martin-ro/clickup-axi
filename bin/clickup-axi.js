#!/usr/bin/env node
import { tryFastPath } from 'axi-sdk-js/fast-path';
import { VERSION } from '../src/version.js';

process.stdout.on('error', error => process.exit(error.code === 'EPIPE' ? 0 : 1));
const argv = process.argv.slice(2);
if (!tryFastPath(argv, { version: VERSION })) {
  const { main } = await import('../src/cli.js');
  await main(argv);
}
