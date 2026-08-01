# Placement, naming, and browser clients

> **Status: current, and the main open work on the gateway.** Drafted as a new
> §6 for the local API doc (pushing "Design notes & open questions" to §7) and
> still unmerged there, because the v0.1 document has been overtaken more
> broadly — see the notice at the top of `local-api-v0.1.md`.
>
> Nothing here is implemented yet beyond the CORS allowlist and the SSE
> `?token=` path. §6.4's conclusion — that per-app tokens are *required* the
> moment the gateway binds beyond loopback — is the reason this matters: the
> capability tokens now in the gateway are the right shape for it, so the
> remaining work is smaller than when this was written.

---

## 6. Placement, naming, and browser clients

Nothing in this API says where the gateway runs. The contract — local bearer token, REST writes, read-only connections, SSE/webhook events — is identical whether the base URL is a loopback address, a LAN hostname, or a public HTTPS endpoint. Placement is therefore a deployment choice per device population, not an architectural one. Three placements cover the space:

| Placement | Base URL shape | Serves | Notes |
|---|---|---|---|
| **Localhost** | `http://localhost:8420/v0` | Apps and browser clients on the same machine | Default binding. Browsers exempt localhost from mixed-content blocking, so HTTPS-served PWAs can call it directly. |
| **LAN** | `https://gw.<name>:8420/v0` | Every device on the network, phones included | Requires the network-exposure opt-in, real TLS (see 6.2), and per-app tokens (see 6.3). Host on always-on hardware. |
| **Hosted** | `https://gw.<realm-host>/v0` | Any device, anywhere | A gateway instance deployed realm-side. Subsumes the token-relay pattern: what was a protocol shim becomes a deployment mode of this component. |

One placement is excluded by construction: **a phone never hosts a gateway**. The gateway's contract is to be the always-connected realm participant — persistent realm connection, declarations held live, events flowing. Mobile OS lifecycles suspend backgrounded apps within seconds, so a phone-resident gateway exists only while foregrounded, which inverts the declare-once-and-forget promise of §4.2. Phones are always clients.

### 6.1 Naming and discovery

Two distinct mechanisms, both optional:

- **Naming (mDNS).** On the LAN placement, the gateway is reachable by its host's mDNS name (`<host>.local`) with zero configuration — advertised automatically on Apple platforms, resolved natively by LAN clients including mobile browsers. This survives DHCP reassignment; no IP appears in any client config.
- **Discovery (DNS-SD).** The gateway SHOULD advertise `_arete-gw._tcp` so native applications can find it without knowing even the hostname — apps discover, they don't configure addresses, matching the substrate's own posture. Browsers cannot consume DNS-SD; discovery is a native-app affordance, and browser clients use the configured name.

### 6.2 TLS reality

The mixed-content exemption is **localhost-only**. An HTTPS-served app calling `http://<host>.local:8420` is blocked as mixed content, and no public CA issues certificates for `.local` names — mDNS naming alone cannot carry browser traffic. The escape is a real DNS name with a private A record: point `gw.<domain>` at the gateway host's LAN IP and obtain a certificate via DNS-01 challenge. The result is a properly certified HTTPS endpoint whose traffic never leaves the network. Recommended posture: mDNS/DNS-SD for native naming and discovery; real-DNS-plus-DNS-01 wherever a browser is a client.

### 6.3 Browser clients

Browser-based apps (PWAs) are first-class consumers of this API, with three consequences the contract must state:

1. **CORS.** A PWA served from a public origin calling the gateway is a cross-origin request. The gateway config carries an **origin allowlist** alongside the local-token config; without an entry, browsers block every call. Default: empty (no browser origins).
2. **SSE auth.** `EventSource` cannot set an `Authorization` header. The SSE endpoint therefore additionally accepts the bearer token as a query parameter (`GET /events?stream=sse&token=…`), and clients able to use fetch-based streaming SHOULD prefer the header. Without this, the claim that webhooks and SSE are equivalent fails for browsers.
3. **Event path.** Browsers cannot receive webhooks at all. For browser clients, SSE is the *only* live event path; polling `GET …/connections` is the fallback. (§4.6's "webhooks and SSE are equivalent" is amended to "equivalent for HTTP-server-capable clients.")

### 6.4 Security consequence

Design-note 5's open question — whether per-app tokens with per-node scoping can wait — is answered by placement: **they can wait only at localhost**. The moment the gateway binds beyond loopback (LAN or hosted), a single shared bearer token means any device on the network can write any node's properties. LAN and hosted placements require per-app tokens scoped to node subtrees in v0.

---

*Amendment to (renumbered) §7 note 5: replace "Evaluate whether per-app tokens … are needed in v0 or can wait" with "Per-app tokens are required for any non-loopback binding; see §6.4."*
