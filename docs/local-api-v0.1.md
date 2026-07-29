# Arete Gateway — Local Service API, Design Proposal v0.1

> **Purpose.** The Arete Gateway is a general-purpose component that lets existing applications participate in CNS/CP realms without embedding the SDK. It has two faces: realm-side it is a full CNS/CP participant (built on the Arete SDK); system-side it exposes **this local REST API**, which any application (ONUMA System, Semantic Bridge, any System X app) consumes to declare capabilities, observe governed connections, exchange properties, and receive event callbacks.
>
> Design goals: **small surface, stable contract, idempotent by construction, event-faithful.** An application should be able to participate meaningfully with four calls and one webhook.

---

## 1. Architecture in one diagram

```
┌─────────────────┐   local REST + webhooks   ┌──────────────────┐   CNS/CP (SDK/WSS)   ┌────────────┐
│  Existing apps   │ ◄───────────────────────► │  Arete Gateway   │ ◄──────────────────► │  Realm(s)  │
│  (System X, SB)  │                           │  (this API)      │                      │  (Arete)   │
└─────────────────┘                           └──────────────────┘                      └────────────┘
```

The gateway may connect to **one or more realms** simultaneously. Everything an app does through this API is scoped by a `realm` handle.

**Division of labor across the six-step pattern:** the app (via this API) performs **Register** and **Declare**. The substrate performs **Reconcile, Match, Bind**. Connections therefore *appear* to the app — they are never created by it. This asymmetry is the architecture, and the API enforces it: declarations are writable; connections are read-only resources that materialize, carry live properties, and disappear.

## 2. Conventions

- Base URL: `http://localhost:8420/v0` (port configurable; `/v0` signals pre-1.0 contract)
- Auth: `Authorization: Bearer <local-token>` on every call. The gateway holds realm credentials/tokens in its own config; **apps never see realm credentials.**
- All writes are **PUT with client-chosen IDs** (or stable name-derived IDs), making every operation idempotent under retry. No POST-creates for declarations. This mirrors the substrate's own guarantee: at-least-once delivery, idempotent steps, no retry storm can double-bind.
- IDs are opaque strings ≤ 64 chars, `[A-Za-z0-9._-]`. Profile strings are runtime-form (e.g. `padi.light` — no prefix).
- Content type `application/json`. Errors: `{ "error": { "code": "...", "message": "..." } }` with conventional HTTP statuses. `409` = conflicting redeclaration (same ID, different body); `503` = realm unreachable (gateway queues nothing across realm outage except declarations, which it replays on reconnect).

## 3. Resource model

```
/realms/{realm}                                  — realm handle (config-declared or API-attached)
/realms/{realm}/nodes/{node}                     — the app's node(s)
  .../contexts/{ctx}                             — contexts the node participates in
    .../declarations/{role}/{profile}            — capability declarations (role = provider|consumer)
      .../properties/{prop}                      — properties declared/written at capability level
      .../connections/{conn}                     — bound connections (READ-ONLY; appear via Match/Bind)
        .../properties/{prop}                    — per-connection properties (read; write own-side)
/webhooks/{hook}                                 — callback registrations
/events                                          — SSE stream (optional alternative to webhooks)
/status                                          — gateway + realm connectivity, versions
```

## 4. Endpoints

### 4.1 Realm attachment (usually config-file, but API-available)

```
PUT  /realms/{realm}                    body: { "host": "anto.arete-hosting.com", "token": "…" }
GET  /realms                            → [ { "realm": "anto", "state": "connected", … } ]
GET  /realms/{realm}                    → { "state": "connected|connecting|error", "systemId": "…" }
DELETE /realms/{realm}
```

### 4.2 Registration & declaration (the app's write surface)

```
PUT  /realms/{r}/nodes/{node}
     body: { "name": "ONUMA Gateway", "upstream": false }

PUT  /realms/{r}/nodes/{node}/contexts/{ctx}
     body: { "name": "RE1 Level 2 Mechanical" }

PUT  /realms/{r}/nodes/{node}/contexts/{ctx}/declarations/{role}/{profile}
     role ∈ provider|consumer; profile e.g. "padi.light", "onuma.context"
     body: { "properties": { "cState": "0" } }        // optional initial property values
```

Redeclaring with an identical body is a no-op (200). The gateway persists declarations and **replays them on gateway restart and realm reconnect** — the app declares once and forgets.

```
DELETE .../declarations/{role}/{profile}              // retract capability; realm unbinds accordingly
GET    /realms/{r}/nodes/{node}                       // introspection at any level of the tree
```

### 4.3 Properties (the data plane)

```
PUT  .../declarations/{role}/{profile}/properties/{prop}         body: { "value": "1" }
GET  .../declarations/{role}/{profile}/properties
PUT  .../connections/{conn}/properties/{prop}                    // write own-side property on one binding
GET  .../connections/{conn}/properties                           // merged view: both sides' current values
```

Semantics follow the profile's contract (e.g. `padi.light`: provider writes `sOut`, consumer writes `cState`). Property writes at declaration level fan out to all bound connections of that declaration; writes at connection level target one binding.

### 4.4 Connections (read-only — the substrate's output)

```
GET  .../declarations/{role}/{profile}/connections
     → [ { "conn": "c-8x1…", "peer": { "node": "…", "context": "…", "role": "provider" },
           "state": "bound", "since": "2026-07-28T19:41:02Z" } ]
GET  .../connections/{conn}                                       // detail incl. properties
```

No PUT/POST/DELETE on connections. To end participation, retract the declaration; the substrate severs.

### 4.5 Live-state introspection (read the operational reality)

```
GET  /realms/{r}/systems                          // what participants exist in the realm
GET  /realms/{r}/contexts                         // contexts visible to this gateway's registrations
GET  /realms/{r}/contexts/{ctx}/participants     // who is declared in a context, by role/profile
```

This is the "see what's live" surface: which participants exist, what's bound, what the operational reality currently is. (Scope note: visibility is whatever the realm's governance grants this gateway's registration — the API exposes it, never expands it.)

### 4.6 Webhooks (the callback API)

```
PUT  /webhooks/{hook}
     body: {
       "url": "http://localhost:9000/arete-events",
       "secret": "whsec_…",                            // HMAC-SHA256 of body in X-Arete-Signature
       "events": [ "connection.created", "connection.updated", "connection.deleted",
                    "property.changed", "realm.connected", "realm.disconnected" ],
       "filter": { "realm": "anto", "profile": "padi.light" }     // optional narrowing
     }
GET  /webhooks        DELETE /webhooks/{hook}
POST /webhooks/{hook}/test                              // fires a synthetic event end-to-end
```

**Event envelope** (one event per delivery; strict per-connection ordering; at-least-once with exponential backoff for 24h; `eventId` for dedupe):

```json
{
  "eventId": "evt_01J…",
  "type": "connection.created",
  "occurredAt": "2026-07-28T19:41:02Z",
  "realm": "anto",
  "node": "onuma-gw", "context": "re1-l2-mech",
  "role": "consumer", "profile": "padi.light",
  "conn": "c-8x1…",
  "data": { "peer": { "node": "switch-7", "role": "provider" } }
}
```

`property.changed` carries `{ "property": "sOut", "value": "1", "previous": "0", "origin": "peer|self" }`.

For apps that prefer pull: `GET /events?stream=sse&filter=…` provides the same envelopes over Server-Sent Events with `Last-Event-ID` resume. Webhooks and SSE are equivalent; polling `GET …/connections` is the degenerate fallback. All three exist because System X's ability to *receive* HTTP varies more than its ability to *send* it.

## 5. Minimal participation walkthrough (the four-call promise)

A light app, end to end:

```
1  PUT /realms/anto/nodes/onuma-light                                { "name": "Lobby Light" }
2  PUT /realms/anto/nodes/onuma-light/contexts/re1-lobby             { "name": "RE1 Lobby" }
3  PUT .../contexts/re1-lobby/declarations/consumer/padi.light       { "properties": { "cState": "0" } }
4  PUT /webhooks/light-events    { "url": "…", "events": ["property.changed","connection.created"] }
```

Then: a `connection.created` event arrives when the substrate binds a switch; `property.changed (sOut)` events drive the light; the app writes back `PUT …/properties/cState`. Done — governed, per-event, auditable participation with no SDK in the app.

## 6. Design notes & open questions for evaluation

1. **Idempotency-first shape.** PUT-with-ID everywhere is deliberate: it makes the local API inherit the substrate's conformance posture (at-least-once, idempotent under retry, no duplicate bindings) instead of fighting it. Evaluate whether any operation genuinely needs POST semantics; the claim is none do.
2. **Connections are read-only.** This is the API teaching the architecture: apps declare, the substrate binds. If an evaluator finds themselves wanting `POST /connections`, that is the address-centric habit the substrate exists to replace — the friction is pedagogical.
3. **Context handling is deliberately thin.** `{ctx}` is an opaque ID + display name here. Anything richer (how context participates in matching, policy) is realm-side governance and out of this API's scope by design.
4. **Multi-realm.** The `{realm}` scope is the entire multi-realm story at the API level; the gateway multiplexes internally. Evaluate whether apps ever need cross-realm atomicity (claim: no).
5. **Security posture.** Local bearer token; realm credentials never cross the local API; webhook HMAC; localhost-default binding with explicit opt-in for network exposure. Evaluate whether per-app tokens with per-node scoping are needed in v0 or can wait.
6. **What deliberately does not exist:** profile authoring/registry endpoints (CP definitions are governed artifacts, not app-writable), realm policy administration, and any bulk import — all are either governance surfaces or premature.
7. **Open question — property write conflicts:** when a declaration-level property write fans out while a connection-level write targets one binding, last-write-wins per key per side is the proposed rule. Evaluate against real sequences (multi-switch light is the test case).
8. **Open question — event replay depth:** SSE `Last-Event-ID` resume implies the gateway retains an event log; proposed retention 24h / 10k events per hook. Sufficient for restart-resilience of a building app?

---
*v0.1 — 2026-07-28. Companion artifacts to be drafted next: the gateway's declared CP surface (the `api.*` / semantic-context profile family) and the RE1 connector configuration. This document is the system-side face only.*
