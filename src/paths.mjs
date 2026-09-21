import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// src/ -> project root
export const projectRoot = path.resolve(here, '..');

export function inProject(...segments) {
  return path.resolve(projectRoot, ...segments);
}
