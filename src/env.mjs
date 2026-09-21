import fs from 'node:fs';
import path from 'node:path';

export function loadDotEnv({ file = '.env' } = {}) {
  const p = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
  if (!fs.existsSync(p)) return;

  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();

    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }

    if (process.env[k] === undefined) {
      process.env[k] = v;
    }
  }
}
