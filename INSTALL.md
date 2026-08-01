# Installing the Arete Gateway

The gateway is a small Node service. There is no build step and no bundler:
you clone or download it, install dependencies, point it at a realm, and run
it.

## What it is, and what it is not

It lets an application take part in a CNS/CP realm **without embedding the
SDK**. Realm-side it is a full participant; system-side it speaks plain HTTP
and Server-Sent Events, so an app declares capabilities, watches connections
appear, and exchanges properties over ordinary REST calls.

**This release is a localhost component.** It binds to `127.0.0.1` and has a
single API token, which is safe when only things on the same machine can
reach it. Running it on a network address for other machines to use is *not*
supported yet — see [Limits](#limits) below.

## Requirements

- **Node 18 or later** (`node --version`). The gateway uses `fetch` and
  `AbortSignal.timeout`, so 16 will not do.
- A CNS/CP realm to connect to. If you do not have one,
  [Arete Hosting](https://aretehosting.com) will create one in a few clicks.
- Outbound access to `cp.padi.io`, where Connection Profiles are resolved.

## Install

```bash
git clone https://github.com/project-arete/arete-gateway.git
cd arete-gateway
npm install
```

`npm install` also applies this project's patches to the Arete SDK — off-Pi
system identity, per-socket TLS, keepalive, real error propagation. They run
from `postinstall`, so a plain install is enough; you do not run anything by
hand. If you ever need to reapply them, `npm run patch`.

## Configure

```bash
cp config.example.json config.json
```

Then edit `config.json`. The minimum is one realm:

```json
{
  "port": 8420,
  "bind": "127.0.0.1",
  "systemName": "My Gateway",
  "realms": {
    "myrealm": {
      "protocol": "wss:",
      "host": "myrealm.aretehosting.com",
      "port": 443,
      "token": ""
    }
  }
}
```

- **`systemName`** is how this gateway appears in the realm. Give it something
  you will recognise in Monitor.
- **`token`** is the realm's access token, if it requires one. It is read from
  this file and never echoed by any endpoint.
- **`localToken`** is optional. Leave it out and one is generated on first run
  and written to `data/local-token` — that is the credential your apps use.

`config.json` is gitignored, so your realm token will not be committed.

## Run

```bash
npm start
```

You should see:

```
[gateway] listening on http://127.0.0.1:8420/v0
[realm:myrealm] connected to myrealm.aretehosting.com as system <uuid>
```

On macOS, `Run-gateway.command` does the same thing from Finder.

Open **http://localhost:8420/ui** for the console. It asks once for the API
token — the contents of `data/local-token`, or whatever you set as
`localToken`. The console shows realm connectivity, everything this gateway
has declared, live properties, connections as they appear, webhooks, and the
event stream.

## First call

```bash
B=http://127.0.0.1:8420/v0
H="Authorization: Bearer $(cat data/local-token)"

curl -X PUT -H "$H" $B/realms/myrealm/nodes/my-light -d '{"name":"Lobby Light"}'
curl -X PUT -H "$H" $B/realms/myrealm/nodes/my-light/contexts/lobby -d '{"name":"Lobby"}'
curl -X PUT -H "$H" \
  $B/realms/myrealm/nodes/my-light/contexts/lobby/declarations/consumer/padi.light \
  -d '{"properties":{"cState":"0"}}'
curl -N -H "$H" "$B/events?stream=sse"
```

Declare a matching provider elsewhere in the same context and a connection
appears — you never create one. See the README for the full API.

## Limits

Worth knowing before you rely on it:

- **Localhost only.** One API token grants everything the gateway can do, so
  anything that can reach the port can act as this gateway. That is fine on
  loopback and not fine on a network. Per-app tokens are the next piece of
  work; until then, do not change `bind`.
- **Capability tokens are the exception** — a device that only needs one
  property on one connection can be given a token scoped to exactly that,
  rather than the API token. See the README.
- **Realm tokens are stored in plaintext** in `config.json`. Acceptable for a
  local component; revisit before anything multi-user.
- **Browsers other than the console** need `corsOrigins` set, and cannot
  authenticate an SSE stream via headers — the stream accepts `?token=` for
  that reason.
- **No replay of events from while the gateway was down.** State is re-derived
  from the realm on reconnect.

## Troubleshooting

**`realm sent no snapshot (dead or not a CNS realm)`** — the realm accepted
the socket but served nothing. Usually means its broker is up while its store
is unreachable; check the realm, not the gateway.

**`422 unknown_profile`** — the profile is not registered at `cp.padi.io`. An
unregistered profile would never bind, so the gateway refuses it up front
rather than letting you wait for a match that cannot happen.

**`422 not_propagated`** — you wrote a declaration-level property that has no
`propagate` flag. Write it on the connection instead
(`…/connections/{conn}/properties/{prop}`).

**`503 realm_unreachable`** — property writes need a live realm. Declarations
made while offline are kept and replayed on reconnect; property writes are
not.

**Nothing binds.** Both sides must be in the same context with complementary
roles and the same profile. `GET /realms/{realm}/contexts/{ctx}/participants`
shows who the realm thinks is there.

## Tests

```bash
npm run test:e2e           # the walkthrough, bind, events, write-back, retraction
npm run test:webhooks      # delivery, HMAC, retry, filters
npm run test:capabilities  # device tokens — mostly what they cannot do
npm run test:peers         # peer identification with three providers
npm run test:console       # the console, driven in a DOM
```

They run against `test.aretehosting.com` by default; set `E2E_REALM`,
`E2E_PROTOCOL` and `E2E_PORT` to use your own. Each suite retracts what it
declared, so runs leave nothing behind.
