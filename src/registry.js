// CP registry client — resolves every profile from cp.padi.io (raw JSON;
// property flags are encoded by KEY PRESENCE with null values, so summarized
// views lose them). Disk cache under data/profiles/ for offline restart.

import fs from 'node:fs';
import path from 'node:path';
import { ApiError } from './util.js';

const REGISTRY_BASE = 'https://cp.padi.io/profiles/';

export class Registry {
  #cache = new Map(); // profile -> { cp, flags } | null (404)
  #dir;

  constructor(dataDir) {
    this.#dir = path.join(dataDir, 'profiles');
    fs.mkdirSync(this.#dir, { recursive: true });
  }

  /**
   * Resolve a profile. Returns { cp, flags } where flags maps property name to
   * { server, propagate, required } booleans. Returns null for a 404
   * (unregistered profile). Throws ApiError 502 if the registry is unreachable
   * and there is no disk cache.
   */
  async resolve(profile) {
    if (this.#cache.has(profile)) return this.#cache.get(profile);

    const file = path.join(this.#dir, profile + '.json');
    let cp = null;
    try {
      const res = await fetch(REGISTRY_BASE + encodeURIComponent(profile), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 404) {
        this.#cache.set(profile, null);
        return null;
      }
      if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
      cp = await res.json();
      fs.writeFileSync(file, JSON.stringify(cp, null, 2));
    } catch (e) {
      // Offline fallback: disk cache from a previous run.
      if (fs.existsSync(file)) {
        cp = JSON.parse(fs.readFileSync(file, 'utf8'));
      } else {
        throw new ApiError(
          502,
          'registry_unreachable',
          `cannot resolve profile '${profile}' from cp.padi.io (${e.message}) and no cached copy exists`,
        );
      }
    }

    const entry = { cp, flags: extractFlags(cp) };
    this.#cache.set(profile, entry);
    return entry;
  }

  /** Synchronous flag lookup for profiles already resolved (event pipeline). */
  flagsOf(profile) {
    const entry = this.#cache.get(profile);
    return entry ? entry.flags : null;
  }
}

/**
 * Flags are encoded by key presence (values are null in the registry JSON):
 *   'server' in prop    -> the PROVIDER writes this property (absent: consumer writes)
 *   'propagate' in prop -> capability-level writes broadcast into all connections
 *   'required' in prop  -> required
 * Versions are additive; merge properties across versions in order.
 */
export function extractFlags(cp) {
  const flags = {};
  for (const version of cp.versions ?? []) {
    for (const prop of version.properties ?? []) {
      flags[prop.name] = {
        server: 'server' in prop,
        propagate: 'propagate' in prop,
        required: 'required' in prop,
      };
    }
  }
  return flags;
}

/** Which role writes this property? */
export function writerRole(flag) {
  return flag.server ? 'provider' : 'consumer';
}
