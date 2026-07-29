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

1. **`DELETE …/declarations/{role}/{profile}` returns 501.** Retraction is not
   implementable today: SDK v0.1.6 has no delete command, the CNS wire has no
   key delete (`put key null` writes a literal `"null"` and can create parent
   keys), and the spec lists DELETE as an open TODO. This is the concrete
   forcing function for wire-level delete (raise with realm-side owners).
   Consequence: §4.4's only exit path ("retract the declaration; the substrate
   severs") does not exist yet either.
2. **Declaration-level property writes require the `propagate` flag.** §4.3
   says declaration-level writes "fan out to all bound connections" — on the
   wire that is only true for propagate-flagged properties. Writing a
   non-propagated property at capability level returns 422 `not_propagated`
   pointing at the per-connection (addressed) endpoint. Writing the peer
   role's property returns 422 `wrong_role_property`.
3. **No `connection.deleted` event.** Connection lifecycle is a spec TODO,
   status is absent from the wire, and without delete there is no retraction
   to observe. Rather than emit an event we cannot back with wire truth, v0
   omits it. `connection.updated` is likewise omitted (property changes are
   already first-class events).
4. **Webhooks are phase 2; SSE is the v0 event surface.** Same envelopes,
   `Last-Event-ID` resume against a 10k in-memory ring buffer. Event IDs carry
   a boot epoch, so a resume from a previous gateway process is detected (full
   buffer replay) instead of silently gapping. `POST /webhooks/{hook}/test`
   would also break the doc's own "no POST" claim (design note 1) — worth
   fixing in the doc when webhooks land.
5. **Profiles are validated against the registry at declaration time**
   (422 `unknown_profile`) — stricter than the doc, which validates nothing.
   Turns the "silent no-bind" failure mode into an immediate, explainable
   error.
6. **`DELETE /realms/{realm}` is local detach only** — the realm-side
   registrations remain (no wire delete). The response says so.
7. **Offline behavior:** node/context/declaration PUTs while the realm is
   unreachable are persisted and answered `202` (`state: "pending"`), replayed
   on reconnect — per the doc's declarations-only queueing rule. Property
   writes while offline fail `503 realm_unreachable`.
8. **Peer identification is best-effort.** The wire does not (observedly)
   label a connection with its peer; `connection.created` carries a peer
   derived from complementary-role participants in the same context. With >2
   participants this can be ambiguous — connection-lifecycle spec work is the
   real fix.

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
| PUT/GET/DELETE | `…/declarations/{role}/{profile}` | 201/200/409; DELETE → 501 |
| GET/PUT | `…/declarations/…/properties[/{prop}]` | capability level; PUT needs `propagate` |
| GET | `…/declarations/…/connections[/{conn}]` | read-only; appear via Match/Bind |
| GET/PUT | `…/connections/{conn}/properties[/{prop}]` | merged view / addressed write |
| GET | `/realms/{r}/systems`, `…/contexts`, `…/contexts/{ctx}/participants` | live-state introspection |
| GET | `/events` | JSON recent, or `?stream=sse` (+ `realm`/`node`/`context`/`role`/`profile`/`type` filters) |

## Testing

```bash
npm run test:e2e        # live E2E against test.aretehosting.com (E2E_REALM=… to override)
```

Spawns the gateway plus an independent SDK peer (the "switch"), runs the §5
walkthrough plus the corrected-behavior negative cases, and asserts the full
bind → events → write-back → merged-view loop. Leaves small e2e systems on the
realm (no wire delete).

## Security posture (v0)

Local bearer token (`data/local-token`, 0600) on every call; realm credentials
live in gateway config only and are never echoed by any endpoint; binds to
127.0.0.1 unless configured otherwise. Realm tokens in `config.json` /
`data/state.json` are stored in plaintext — acceptable for a local dev
gateway, revisit (keychain/secret store) before anything multi-user.
Per-app tokens with per-node scoping: deliberately deferred, per design doc
open question 5.
