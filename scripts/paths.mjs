import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

// scripts/ -> project root
export const projectRoot = path.resolve(scriptsDir, '..');

export function inProject(...segments) {
  return path.resolve(projectRoot, ...segments);
}
