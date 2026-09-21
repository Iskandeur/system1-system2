import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Disk cache of model responses, keyed by a hash of (adapter kind, model id, request body).
// A rerun costs nothing and a crash loses at most the call in flight. The key deliberately ignores
// the endpoint URL: the same model id behind two base URLs shares entries (use another model
// name, or --no-cache, to keep them apart).

export function cacheKey(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

export function createCache({ dir }) {
  const fileFor = (key) => path.join(dir, key.slice(0, 2), `${key}.json`);
  let hits = 0;
  let misses = 0;
  return {
    dir,
    key: cacheKey,
    get(key) {
      const f = fileFor(key);
      if (!fs.existsSync(f)) {
        misses++;
        return null;
      }
      try {
        const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
        hits++;
        return rec;
      } catch {
        misses++;
        return null;
      }
    },
    set(key, record) {
      const f = fileFor(key);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(record));
      fs.renameSync(tmp, f);
    },
    stats() {
      return { hits, misses };
    },
  };
}
