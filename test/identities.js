// Stable identities for the test suites.
//
// Every suite used to mint a fresh random system id per run — for its peers
// (crypto.randomUUID()) and, indirectly, for the gateway itself (a fresh
// scratch dir means a fresh system seed). Combined with teardown that
// retracted only the NODE and not the system record, each run left a new,
// permanent system on the realm. Twenty-odd runs in a day is twenty-odd
// systems, which is exactly how the test realm filled up.
//
// Two fixes, both here:
//
//   * ids are DERIVED from the suite and role, so re-running a suite reuses
//     the same identities instead of minting new ones. N runs, N systems
//     becomes N runs, one set.
//   * suites can retract the whole system subtree on teardown, not just the
//     node — see retractSystems() below.
//
// Deterministic ids also make a leak diagnosable: an id in this namespace
// tells you which suite created it.

import crypto from 'node:crypto';

const NAMESPACE = 'arete-gateway-test';

/**
 * A stable UUID for a named test identity. Same inputs, same id, every run.
 *   testSystemId('peer-identity', 'peer', 2)
 */
export function testSystemId(suite, role, index = 0) {
  const h = crypto.createHash('sha256')
    .update(`${NAMESPACE}:${suite}:${role}:${index}`)
    .digest('hex');

  // Shape the digest into a v4-looking UUID; the realm only needs a stable
  // opaque string, but keeping the format familiar avoids surprises.
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    '4' + h.slice(13, 16),
    ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join('-');
}

/**
 * A stable seed for a gateway under test, so its system id is also stable
 * across runs (the SDK derives the id from ARETE_SYSTEM_SEED).
 */
export function testSystemSeed(suite) {
  return `${NAMESPACE}:${suite}:gateway`;
}

/**
 * Remove test systems from the realm ENTIRELY — the system record too, not
 * just its nodes. Retracting the node leaves `cns/<id>/name|token|orchestrator`
 * behind: inert (no version key, so nothing can bind to it) but still clutter,
 * and it accumulates one per run.
 *
 * Uses its own short-lived client so it works even if the suite's gateway has
 * already been shut down. Best-effort: cleanup must never fail a suite.
 */
export async function retractSystems(ids, { host, protocol = 'wss:', port = 443 } = {}) {
  if (!ids.length) return 0;

  const { Client } = await import('arete-sdk');
  process.env.ARETE_SYSTEM_SEED = `${NAMESPACE}:cleanup`;

  const c = new Client({ protocol, host, port });
  let removed = 0;

  try {
    const snapshot = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no snapshot')), 10000);
      c.on('open', () => { clearTimeout(t); resolve(); });
    });
    await c.waitForOpen(8000);
    await snapshot;
    await new Promise((r) => setTimeout(r, 1500));

    for (const id of ids) {
      if (c.get(`cns/${id}/name`) === null) continue;   // never registered
      await c.command('purge', `cns/${id}`);
      await new Promise((r) => setTimeout(r, 600));
      if (c.get(`cns/${id}/name`) === null) removed++;
    }
  } catch {
    /* cleanup is best-effort; a suite must not fail because tidying did */
  } finally {
    try { c.dispose(); } catch { /* already gone */ }
  }

  return removed;
}
