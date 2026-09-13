import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENTRY = fileURLToPath(new URL('./clickup-axi.mjs', import.meta.url));
export const shellQuote = value => /^[\w/.:\-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

export function invocation(execPath = ENTRY, { env = process.env, cwd = process.cwd(), homeDir = homedir() } = {}) {
  execPath = resolve(cwd, execPath);
  let verified = false;
  for (const dir of (env.PATH === undefined ? [] : env.PATH.split(delimiter))) {
    const candidate = resolve(cwd, dir, 'clickup-axi');
    try {
      accessSync(candidate, constants.X_OK);
      if (!statSync(candidate).isFile()) continue;
      verified = realpathSync(candidate) === realpathSync(execPath);
      break; // Only the first executable on PATH can be used.
    } catch { /* Missing or inaccessible PATH entry. */ }
  }
  const file = verified ? 'clickup-axi' : process.execPath;
  const args = verified ? [] : [execPath];
  return {
    file, args, command: [file, ...args].map(shellQuote).join(' '),
    display: execPath === homeDir ? '~' : execPath.startsWith(`${homeDir}${sep}`) ? `~${execPath.slice(homeDir.length)}` : execPath,
  };
}
