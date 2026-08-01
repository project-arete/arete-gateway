# Arete Gateway

Local REST/SSE face for CNS/CP realm participation. Existing applications
declare capabilities, observe governed connections, and exchange properties
over plain HTTP against `http://localhost:8420/v0` — no SDK embedded in the
app. Realm-side, the gateway is a full CNS/CP participant built on the
[Arete SDK](https://github.com/project-arete/sdk).

Implements the **Arete Gateway — Local Service API, Design Proposal v0.1**
(system-side face), with the wire-truth corrections listed under
[Divergences](#divergences-from-the-v01-design-doc). Architecture background:
[ARETE.md](https://raw.githubusercontent.com/project-arete/sdk/main/ARETE.md).

Verified end-to-end against a live realm (18/18 E2E checks, July 2026): the
§5 four-call walkthrough, brokered bind, `connection.created` /
`property.changed` events with correct `origin`, propagated and addressed
writes, and the introspection surface.

## Quick start

```bash
npm install            # postinstall applies the SDK patches (scripts/patch-sdk.js)
cp config.example.json config.json   # edit realms; token is write-only, never echoed
npm start
```

On first run the gateway generates `data/local-token` (the local API bearer
token) and `data/system-seed` (stable system identity). Every request needs
`Authorization: Bearer <local-token>`; SSE may use `?token=` since
EventSource cannot set headers.

The four-call promise, live:

```bash
B=http://127.0.0.1:8420/v0; H="Authorization: Bearer $(cat data/local-token)"
curl -X PUT -H "$H" $B/realms/test/nodes/my-light -d '{"name":"Lobby Light"}'
curl -X PUT -H "$H" $B/realms/test/nodes/my-light/contexts/lobby1 -d '{"name":"Lobby"}'
curl -X PUT -H "$H" $B/realms/test/nodes/my-light/contexts/lobby1/declarations/consumer/padi.light \
     -d '{"properties":{"cState":"0"}}'
curl -N -H "$H" "$B/events?stream=sse&realm=test"     # connection.created, property.changed…
```

Connections then *appear* — they are never created by the app. Write back with
`PUT …/declarations/consumer/padi.light/properties/cState -d '{"value":"1"}'`.

To leave, retract: `DELETE` the declaration, context or node. The substrate
severs any connections that depended on it — connections are no more deleted
by the app than they were created by it.

## Console

The gateway serves its own live view at **http://localhost:8420/ui** — a
dependency-free single page (`ui/index.html`, no build step) showing realm
connectivity, the declaration tree with live properties, connections as they
materialize, and the SSE event tail. Own-side properties are editable inline;
writes go through the same governed endpoints as any app, so wrong-role and
non-propagated writes surface as the API's 422s verbatim. The page is served
unauthenticated (it holds no secrets); every API call it makes needs the local
token, which it asks for on first load and keeps in browser localStorage.

The console can also point at a *remote* gateway (Settings → Base URL). For
that, the remote gateway must allowlist the page's origin in `corsOrigins`
(config.json; default empty = no cross-origin browser access). The SSE stream
accepts `?token=` because EventSource cannot set an Authorization header —
see docs/placement-naming-draft.md for the placement/browser-client story.

The console shows the full surface: the declaration tree, connections,
webhooks with delivery stats, and per-connection capabilities.

## API reference (OpenAPI)

The API is described by **`docs/openapi.json`** (OpenAPI 3.1) — including the
webhook delivery contract (envelope + `X-Arete-Signature`) via the spec's
`webhooks` section, and both credential kinds as separate security schemes.
The gateway serves it at **`GET /v0/openapi.json`** (unauthenticated — it is
the public contract and holds no secrets), and renders it interactively at
**http://localhost:8420/docs** — Swagger UI loaded from a pinned CDN, so the
repo stays dependency-free; `/docs` needs internet access, curl and the
console do not. Click *Authorize* and paste the local token to use
"Try it out".

Generate a client, import into Postman, or hand the spec URL to an AI
assistant alongside ARETE.md. `npm run test:openapi` keeps the spec honest:
every documented operation must be routed and answer only documented
statuses, and the served spec must be byte-identical to the file. When the
API changes, change the spec in the same commit — the test fails otherwise.

## Field-truth behaviors baked in

These come from live-verified SDK/realm behavior (see ARETE.md gotchas):

1. **Value-wiper protection.** Re-issuing a `providers`/`consumers`
   declaration for an existing capability resets all its property values to
   empty strings, and the empties propagate into every connection. Declaration
   replay (on gateway restart and realm reconnect) is therefore
   **conditional**: if `…/<role>/<profile>/version` already exists in the key
   cache, the declaration command is skipped and the gateway operates on the
   existing key paths. Initial property values are only written on a fresh
   declaration.
2. **Single-use clients, no zombies.** The patched SDK never retries
   internally; on any close the gateway disposes the client and reconnects
   with a fresh one (backoff 5s→60s; 401/403 backs off to 5 min instead of
   retrying forever).
3. **Serial registration.** Registration commands are awaited one at a time —
   bursts get silently dropped by the control plane.
4. **No `.watch()`.** All connection/property state is derived from the key
   cache on `update` events (the SDK's `.watch()` has a null-match crash).
5. **Per-socket TLS.** Self-signed realms use `"insecureTls": true` per realm
   — never the process-wide `NODE_TLS_REJECT_UNAUTHORIZED` toggle, which would
   silently disable verification for *every* realm the gateway holds.
6. **Registry rule enforced.** Every profile is resolved from `cp.padi.io`
   (raw JSON — flags are encoded by key presence) before a declaration is
   accepted. An unregistered profile is refused with 422 `unknown_profile`,
   because it would silently never bind. Registry records are disk-cached for
   offline restart.
7. **Dead-realm detection.** A realm that accepts the socket but never sends a
   first message is treated as dead (`realm sent no snapshot`), not silently
   waited on. Note the SDK emits `open` on the first *message*, not on socket
   open.
8. **One system identity across all realms** (deliberate): the gateway is one
   physical system participating in N realms. Same-host duplicate realm
   handles are refused (409) to prevent double registration.

## Divergences from the v0.1 design doc

Each is deliberate; carry into the v0.2 doc revision.

1. **Declaration-level property writes require the `propagate` flag.** §4.3
   says declaration-level writes "fan out to all bound connections" — on the
   wire that is only true for propagate-flagged properties. Writing a
   non-propagated property at capability level returns 422 `not_propagated`
   pointing at the per-connection (addressed) endpoint. Writing the peer
   role's property returns 422 `wrong_role_property`.
2. **Profiles are validated against the registry at declaration time**
   (422 `unknown_profile`) — stricter than the doc, which validates nothing.
   Turns the "silent no-bind" failure mode into an immediate, explainable
   error.
3. **`DELETE /realms/{realm}` is local detach only.** Detaching a realm stops
   this gateway talking to it; it does not retract what was declared there.
   Retract the nodes first if that is what you meant.
4. **Offline behavior:** node/context/declaration PUTs while the realm is
   unreachable are persisted and answered `202` (`state: "pending"`), replayed
   on reconnect — per the doc's declarations-only queueing rule. Property
   writes while offline fail `503 realm_unreachable`.
5. **`connection.updated` is not emitted.** Property changes are already
   first-class events, so it would carry nothing the consumer does not have.
6. **`POST` exists after all.** Design note 1 claims no operation needs POST.
   Two do, and both are creations the server names:
   `POST …/connections/{conn}/capabilities` (the token is generated, so the
   client cannot choose its id) and `POST /webhooks/{hook}/test` (an action,
   not a resource). The idempotency-first rule holds everywhere else.

### Resolved since v0.1 — the doc is now WRONG about these

Listed separately because the v0.1 doc and earlier revisions of this README
describe behaviour that no longer exists. Anyone reading them will be misled.

* **Retraction works.** `DELETE` on a declaration, context or node retracts
  that subtree. The earlier "returns 501, the wire has no delete" was wrong
  about the wire: `del` and `purge` were reachable all along — the CLI behind
  the realm dispatches them — and the orchestrator severs the peer's side
  correctly. Nothing needed adding to the realm. What was missing was anything
  that asked. (`put key null` really does write a literal `"null"`; that part
  was right, and is why it looked impossible.)
* **`connection.deleted` is emitted.** Removal became observable the moment
  retraction existed: the connection's keys disappear and the gateway emits
  once, when the last one goes.
* **Webhooks are implemented** — see below. SSE remains available and carries
  identical envelopes.
* **The peer is identified, not inferred.** The wire *does* label a connection
  with its far end: alongside the properties it writes an attribute named for
  the opposite role, holding `cns/<system>/nodes/<node>/contexts/<ctx>`. The
  old complementary-role heuristic was a guess, and with more than two
  participants in a context usually the wrong one. It survives only as a last
  resort, refuses to answer when ambiguous, and flags itself `inferred: true`.

## Webhooks

Same envelopes SSE carries, pushed to your endpoint.

```bash
curl -X PUT -H "$H" $B/webhooks/my-hook -d '{
  "url": "http://127.0.0.1:9000/arete",
  "secret": "whsec_…",
  "events": ["connection.created","property.changed","connection.deleted"]
}'
curl -X POST -H "$H" $B/webhooks/my-hook/test     # synthetic event, end to end
```

* **At-least-once** — a failed delivery is retried; dedupe on `eventId`.
  Losing a `connection.created` silently is worse than seeing it twice.
* **Ordered per hook** — one delivery in flight, and a failure retries the
  *same* event before anything behind it.
* **Signed** — `X-Arete-Signature: sha256=…`, HMAC over the exact bytes sent.
* **Bounded** — capped queue per hook (oldest dropped, counted), give up after
  24h, so a dead endpoint cannot grow memory forever.

The secret is stored but never echoed (`hasSecret` only). Unknown event types
are refused at registration rather than silently never matching. `POST /test`
deliberately ignores the hook's filter — it is a connectivity check.

Not implemented deliberately: replay of events from while the gateway was
down. The realm is the source of truth and state is re-derived on reconnect;
replaying a stale log would make confident claims about a present that has
moved on.

## Capabilities (constrained devices)

A device that cannot run the CNS/CP stack still needs to touch one property on
one connection. Give it a capability rather than the gateway's API token.

```bash
curl -X POST -H "$H" $B/realms/test/nodes/my-light/contexts/lobby1\
/declarations/consumer/padi.light/connections/$CONN/capabilities \
  -d '{"properties":["cState"],"direction":"write","label":"wall switch"}'
```

The device then uses the **same** property endpoints an app uses — only the
credential differs, so there is no second data plane.

* **Attenuating** — may only name properties the gateway itself may write on
  this side, checked at mint against the CP's flags. You cannot delegate what
  you do not hold.
* **Narrow** — cannot read the declaration tree, `/status`, `/events` or
  `/webhooks`, cannot mint further capabilities, cannot retract. The request
  path is matched *against* the capability, so unconsidered routes fail closed.
* **Hashed** — only the SHA-256 is stored; the token is returned once and
  cannot be recovered.
* **Self-expiring** — the binding must still exist at use time. When the
  substrate severs, the capability refers to nothing (`410`). Revocation for
  free.
* **Directional** — `read` / `write` / `readwrite`, and a reader sees only the
  properties it names, not the merged view an app gets.

## API summary

Everything under `/v0`, JSON bodies, errors as
`{"error":{"code":…,"message":…}}`.

| Method | Path | Notes |
|---|---|---|
| GET | `/status` | gateway + realm connectivity |
| PUT/GET/DELETE | `/realms/{realm}` | attach (token write-only) / describe / local detach |
| GET | `/realms` | all realms |
| PUT/GET | `/realms/{r}/nodes/{node}` | `{name, upstream}` / introspect subtree |
| PUT/GET | `…/contexts/{ctx}` | `{name}` |
| DELETE | `/realms/{r}/nodes/{node}`, `…/contexts/{ctx}` | retract that subtree |
| PUT/GET/DELETE | `…/declarations/{role}/{profile}` | 201/200/409; DELETE retracts |
| GET/PUT | `…/declarations/…/properties[/{prop}]` | capability level; PUT needs `propagate` |
| GET | `…/declarations/…/connections[/{conn}]` | read-only; appear via Match/Bind |
| GET/PUT | `…/connections/{conn}/properties[/{prop}]` | merged view / addressed write |
| POST/GET | `…/connections/{conn}/capabilities` | mint a device token / list |
| DELETE | `…/connections/{conn}/capabilities/{capId}` | revoke |
| PUT/GET/DELETE | `/webhooks/{hook}` | register / describe / remove |
| POST | `/webhooks/{hook}/test` | fire a synthetic event end to end |
| GET | `/realms/{r}/systems`, `…/contexts`, `…/contexts/{ctx}/participants` | live-state introspection |
| GET | `/events` | JSON recent, or `?stream=sse` (+ `realm`/`node`/`context`/`role`/`profile`/`type` filters) |

Event types: `connection.created`, `connection.deleted`, `property.changed`,
`realm.connected`, `realm.disconnected` (and `webhook.test`).

## Testing

```bash
npm run test:e2e           # the §5 walkthrough, bind, events, write-back, retraction
npm run test:webhooks      # delivery, HMAC, retry, filters
npm run test:capabilities  # device tokens — mostly what they CANNOT do
npm run test:peers         # three providers in one context: is the peer right?
```

All four spawn the gateway plus independent SDK peers and run against a real
realm — `test.aretehosting.com` by default, or set `E2E_REALM`,
`E2E_PROTOCOL` and `E2E_PORT` to point at a local one (etcd + cns-cli +
orchestrator), which is faster and touches nothing shared.

Each suite retracts what it declared, so a run leaves no matchable
declarations behind. That is recent: every run used to leave a permanent
participant, which is how the test realm accumulated 38 systems, 35 of them
dead.

## Security posture (v0)

Local bearer token (`data/local-token`, 0600) on every call; realm credentials
live in gateway config only and are never echoed by any endpoint; binds to
127.0.0.1 unless configured otherwise. Realm tokens in `config.json` /
`data/state.json` are stored in plaintext — acceptable for a local dev
gateway, revisit (keychain/secret store) before anything multi-user.

**Capabilities** are the exception to "one token for everything": a device
gets a credential scoped to one connection and named properties, stored as a
hash. That is also the shape per-app tokens should take when the gateway binds
beyond loopback — which the placement notes say is required, not optional, and
remains the main open item here. See
[docs/placement-naming-draft.md](docs/placement-naming-draft.md) for placement,
mDNS naming, TLS and browser-client constraints.
