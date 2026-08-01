// Capability tokens — the constrained-device pattern.
//
// A device that cannot run the CNS/CP stack still needs to read or write a
// property at one end of one connection. Giving it the gateway's local API
// token would hand it the whole gateway. Instead the gateway mints a token
// that names exactly one connection and a fixed set of properties on it.
//
// Properties of the design, and why:
//
//   ATTENUATING     a capability can only name properties the gateway may
//                   itself write on that connection (own side, per the CP's
//                   flags). It can never grant more than its minter holds.
//   NARROW          blast radius is ONE binding, not one identity. Compare
//                   handing out the local token, which is total.
//   HASHED          only a SHA-256 of the token is stored. The token is
//                   returned once, at mint, and cannot be recovered — so a
//                   leak of gateway state is not a leak of credentials.
//   TIED TO A BINDING  the connection must still exist at use time. When the
//                   substrate severs, the capability refers to nothing and
//                   stops working. Revocation for free, no CRL.
//
// STORAGE: the hashes live in the gateway's own state, NOT in the realm.
// The realm-side variant of this pattern (rights model §5) stores the hash at
// …/connections/<id>/capabilities/<capId> so that a service can validate when
// the minting participant is offline — deliberately OUTSIDE …/properties/,
// since the orchestrator mirrors only property keys to the peer and a device
// credential has no business in someone else's tree. Here the gateway is both
// the minter and the validator, so putting hashes on the realm would add keys
// nobody reads.

import crypto from 'node:crypto';
import { ApiError } from './util.js';

const DIRECTIONS = ['read', 'write', 'readwrite'];

export class CapabilityManager {
  #store;

  constructor({ store }) {
    this.#store = store;
  }

  static hash(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Mint a capability. `scope` identifies the binding; `properties` are the
   * property names it may touch. Returns the token ONCE — only its hash is
   * kept.
   */
  mint(scope, { properties, direction = 'write', label = '', expiresAt = null }) {
    if (!Array.isArray(properties) || properties.length === 0)
      throw new ApiError(400, 'bad_request', 'capability requires a non-empty "properties" array');

    if (!DIRECTIONS.includes(direction))
      throw new ApiError(400, 'bad_request', `"direction" must be one of ${DIRECTIONS.join(', ')}`);

    if (expiresAt !== null && Number.isNaN(Date.parse(expiresAt)))
      throw new ApiError(400, 'bad_request', '"expiresAt" must be an ISO timestamp');

    const token = 'acap_' + crypto.randomBytes(32).toString('base64url');
    const capId = 'cap_' + crypto.randomBytes(6).toString('hex');

    const record = {
      capId,
      hash: CapabilityManager.hash(token),
      ...scope,
      properties: [...properties],
      direction,
      label: String(label ?? ''),
      expiresAt,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      uses: 0,
    };

    this.#store.putCapability(capId, record);
    return { token, record: this.describe(record) };
  }

  /** Public view — never includes the hash, and there is no way back to the token. */
  describe(record) {
    const { hash, ...rest } = record;
    return rest;
  }

  list(filter = {}) {
    return Object.values(this.#store.getCapabilities())
      .filter((c) => Object.entries(filter).every(([k, v]) => v === undefined || c[k] === v))
      .map((c) => this.describe(c));
  }

  get(capId) {
    const rec = this.#store.getCapabilities()[capId];
    return rec ? this.describe(rec) : null;
  }

  revoke(capId) {
    return this.#store.deleteCapability(capId);
  }

  /** Resolve a presented token to its record, or null. Expiry is enforced here. */
  resolve(token) {
    if (typeof token !== 'string' || !token.startsWith('acap_')) return null;

    const hash = CapabilityManager.hash(token);
    for (const rec of Object.values(this.#store.getCapabilities())) {
      // Constant-time compare on equal-length hex digests.
      if (rec.hash.length === hash.length &&
        crypto.timingSafeEqual(Buffer.from(rec.hash), Buffer.from(hash))) {
        if (rec.expiresAt && Date.parse(rec.expiresAt) <= Date.now()) return null;
        return rec;
      }
    }
    return null;
  }

  /** Record a use (for visibility — a capability that is never used is a smell). */
  touch(capId) {
    const rec = this.#store.getCapabilities()[capId];
    if (!rec) return;
    rec.uses++;
    rec.lastUsedAt = new Date().toISOString();
    this.#store.putCapability(capId, rec);
  }

  /**
   * Does this capability authorise `method` on this exact property of this
   * exact connection? Everything is compared — a capability for one binding
   * must not work on another that happens to share a property name.
   */
  permits(rec, { realm, node, context, role, profile, conn, property, write }) {
    if (rec.realm !== realm || rec.node !== node || rec.context !== context ||
      rec.role !== role || rec.profile !== profile || rec.conn !== conn) return false;

    if (property !== undefined && !rec.properties.includes(property)) return false;

    if (write && rec.direction === 'read') return false;
    if (!write && rec.direction === 'write') return false;

    return true;
  }
}
