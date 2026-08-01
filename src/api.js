// HTTP API — the system-side face. Routes follow the v0.1 design doc with the
// wire-truth corrections listed in README.md (501 on DELETE declaration,
// propagate-flag enforcement, registry validation of profiles, no
// connection.deleted event).

import {
  ApiError,
  badRequest,
  notFound,
  validateId,
  validateRole,
  sendJson,
  readBody,
  deepEqual,
} from './util.js';
import { writerRole } from './registry.js';

// The complete event catalogue. connection.updated from the v0.1 doc is
// deliberately absent — it is not observable on the wire. connection.deleted
// IS, now that retraction exists.
const EVENT_TYPES = [
  'connection.created',
  'connection.deleted',
  'property.changed',
  'realm.connected',
  'realm.disconnected',
  'webhook.test',
];

export function createApi({ cfg, store, manager, hub, registry, webhooks, capabilities }) {
  return async function handle(req, res, url, auth = { kind: 'local' }) {
    const segs = url.pathname.split('/').filter(Boolean); // ['v0', ...]
    if (segs[0] !== 'v0') throw notFound(`unknown path ${url.pathname} (API lives under /v0)`);
    segs.shift();
    const method = req.method;

    // A capability token is not a weaker local token — it authorises exactly
    // one property operation on one connection. Handle it on its own path and
    // never fall through into the general API.
    if (auth.kind === 'capability') {
      return handleCapabilityRequest({ req, res, url, segs, method, cap: auth.cap });
    }

    // ---- /v0/status ----
    if (segs[0] === 'status' && segs.length === 1 && method === 'GET') {
      return sendJson(res, 200, {
        gateway: 'arete-gateway',
        version: '0.1.0',
        uptimeSec: Math.floor(process.uptime()),
        realms: manager.describeAll(),
      });
    }

    // ---- /v0/events ----
    if (segs[0] === 'events' && segs.length === 1 && method === 'GET') {
      const filter = pickFilter(url.searchParams);
      if (url.searchParams.get('stream') === 'sse') {
        return hub.subscribe(req, res, filter);
      }
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 1000);
      return sendJson(res, 200, { events: hub.recent(filter, limit) });
    }

    // ---- /v0/webhooks ----
    if (segs[0] === 'webhooks') {
      if (segs.length === 1 && method === 'GET') {
        return sendJson(res, 200, webhooks.list());
      }

      const hookId = validateId(segs[1], 'webhook');

      if (segs.length === 2) {
        if (method === 'PUT') {
          const body = await readBody(req);
          if (typeof body.url !== 'string' || !/^https?:\/\//i.test(body.url))
            throw badRequest('webhook body requires an http(s) "url"');
          if (body.events !== undefined && !Array.isArray(body.events))
            throw badRequest('"events" must be an array of event types');
          if (Array.isArray(body.events)) {
            const unknown = body.events.filter((e) => !EVENT_TYPES.includes(e));
            if (unknown.length)
              throw new ApiError(422, 'unknown_event_type',
                `unknown event type(s): ${unknown.join(', ')} — known: ${EVENT_TYPES.join(', ')}`);
          }
          return sendJson(res, 200, webhooks.put(hookId, body));
        }
        if (method === 'GET') {
          const hook = webhooks.get(hookId);
          if (!hook) throw notFound(`no webhook '${hookId}'`);
          return sendJson(res, 200, hook);
        }
        if (method === 'DELETE') {
          if (!webhooks.delete(hookId)) throw notFound(`no webhook '${hookId}'`);
          return sendJson(res, 200, { hook: hookId, deleted: true });
        }
        throw methodNotAllowed(method);
      }

      if (segs[2] === 'test' && segs.length === 3 && method === 'POST') {
        if (!webhooks.test(hookId)) throw notFound(`no webhook '${hookId}'`);
        return sendJson(res, 202, {
          hook: hookId,
          queued: true,
          note: 'a synthetic webhook.test event has been queued for delivery',
        });
      }

      throw notFound(`no route for ${method} ${url.pathname}`);
    }

    // ---- /v0/realms ----
    if (segs[0] === 'realms') {
      if (segs.length === 1 && method === 'GET') {
        return sendJson(res, 200, manager.describeAll());
      }

      const realmName = validateId(segs[1], 'realm');

      if (segs.length === 2) {
        if (method === 'PUT') {
          const body = await readBody(req);
          return sendJson(res, 200, manager.attach(realmName, body));
        }
        if (method === 'GET') return sendJson(res, 200, manager.describe(realmName));
        if (method === 'DELETE') {
          manager.detach(realmName);
          return sendJson(res, 200, {
            realm: realmName,
            detached: true,
            note: 'local detach only — realm-side registrations remain (the wire has no delete)',
          });
        }
        throw methodNotAllowed(method);
      }

      const realm = manager.get(realmName);

      // ---- live-state introspection ----
      if (segs[2] === 'systems' && segs.length === 3 && method === 'GET') {
        realm.requireClient();
        return sendJson(res, 200, realm.listSystems());
      }
      if (segs[2] === 'contexts' && segs.length === 3 && method === 'GET') {
        realm.requireClient();
        return sendJson(res, 200, realm.listContexts());
      }
      if (segs[2] === 'contexts' && segs[4] === 'participants' && segs.length === 5 && method === 'GET') {
        realm.requireClient();
        return sendJson(res, 200, realm.listParticipants(validateId(segs[3], 'context')));
      }

      // ---- nodes tree ----
      if (segs[2] === 'nodes' && segs.length === 3 && method === 'GET') {
        // List all nodes declared through this gateway (console/introspection).
        const tree = store.getTree(realmName);
        return sendJson(
          res,
          200,
          Object.entries(tree.nodes).map(([id, n]) => describeNode(realm, realmName, id, n)),
        );
      }
      if (segs[2] === 'nodes') {
        return handleNodes({ req, res, method, segs, realmName, realm, store, registry });
      }
    }

    throw notFound(`no route for ${method} ${url.pathname}`);
  };

  /**
   * The device path. A capability names one connection and a set of properties
   * on it, so exactly two things are permitted:
   *
   *   GET  …/connections/{conn}/properties            read the merged view
   *   PUT  …/connections/{conn}/properties/{prop}     write a named property
   *
   * Anything else — another connection, another property, the declaration
   * tree, events, webhooks, minting further capabilities — is refused. The
   * path is matched against the capability rather than the capability being
   * checked against the path, so a route we forget to think about fails
   * closed.
   */
  async function handleCapabilityRequest({ req, res, url, segs, method, cap }) {
    const deny = (msg) => new ApiError(403, 'capability_scope', msg);

    // Expected shape: realms/{r}/nodes/{n}/contexts/{c}/declarations/{role}/{profile}/connections/{conn}/properties[/{prop}]
    if (segs[0] !== 'realms' || segs[2] !== 'nodes' || segs[4] !== 'contexts' ||
      segs[6] !== 'declarations' || segs[9] !== 'connections' || segs[11] !== 'properties')
      throw deny('this credential may only read or write properties on its own connection');

    const scope = {
      realm: segs[1], node: segs[3], context: segs[5],
      role: segs[7], profile: segs[8], conn: segs[10],
    };
    const property = segs[12];
    const write = method === 'PUT';

    if (method !== 'GET' && method !== 'PUT') throw methodNotAllowed(method);
    if (write && property === undefined) throw badRequest('a property name is required');

    if (!capabilities.permits(cap, { ...scope, property, write }))
      throw deny(
        `this credential authorises ${cap.direction} on ${cap.properties.join(', ')} ` +
        `of connection ${cap.conn} only`);

    const realm = manager.get(scope.realm);
    realm.requireClient();

    // The binding must still exist. When the substrate severs, a capability
    // refers to nothing — which is what makes revocation free.
    const conn = realm.connection(scope.node, scope.context, scope.role, scope.profile, scope.conn);
    if (!conn) throw new ApiError(410, 'connection_gone',
      'the connection this credential refers to no longer exists');

    capabilities.touch(cap.capId);

    if (!write) {
      // Only the properties this capability names — not the merged view.
      const visible = {};
      for (const p of cap.properties) if (p in conn.properties) visible[p] = conn.properties[p];
      return sendJson(res, 200, visible);
    }

    const body = await readBody(req);
    // Same CP checks an app gets: a capability can never exceed what the
    // gateway itself may write on this side of the binding.
    await checkPropertyWrite(registry, scope.profile, scope.role, property, { requirePropagate: false });
    await realm.putConnectionProperty(
      scope.node, scope.context, scope.role, scope.profile, scope.conn, property, body.value ?? '');

    return sendJson(res, 200, {
      property, value: String(body.value ?? ''), scope: 'connection', conn: scope.conn, via: 'capability',
    });
  }

  async function handleNodes({ req, res, method, segs, realmName, realm, store, registry }) {
    const nodeId = validateId(segs[3], 'node');

    // PUT/GET /realms/{r}/nodes/{node}
    if (segs.length === 4) {
      if (method === 'PUT') {
        const body = await readBody(req);
        if (typeof body.name !== 'string' || !body.name) throw badRequest('node body requires "name"');
        const node = store.putNode(realmName, nodeId, body);
        const wire = await tryWire(realm, (r) => r.registerNode(nodeId, node));
        return sendJson(res, wire.ok ? 200 : 202, {
          realm: realmName,
          node: nodeId,
          name: node.name,
          upstream: node.upstream,
          state: wire.ok ? 'registered' : 'pending',
          ...(wire.ok ? {} : { note: wire.note }),
        });
      }
      if (method === 'GET') {
        const node = store.getNode(realmName, nodeId);
        if (!node) throw notFound(`no node '${nodeId}' declared through this gateway`);
        return sendJson(res, 200, describeNode(realm, realmName, nodeId, node));
      }
      if (method === 'DELETE') {
        if (!store.getNode(realmName, nodeId)) throw notFound(`no node '${nodeId}'`);
        realm.requireClient();
        const prefix = await realm.retractNode(nodeId);
        store.deleteNode(realmName, nodeId);
        return sendJson(res, 200, {
          realm: realmName, node: nodeId, retracted: true, prefix,
          note: 'node and everything beneath it removed; the substrate severs affected connections',
        });
      }
      throw methodNotAllowed(method);
    }

    if (segs[4] !== 'contexts') throw notFound(`no route`);
    const ctxId = validateId(segs[5], 'context');
    const node = store.getNode(realmName, nodeId);
    if (!node) throw notFound(`no node '${nodeId}' — PUT the node first`);

    // PUT/GET /realms/{r}/nodes/{n}/contexts/{ctx}
    if (segs.length === 6) {
      if (method === 'PUT') {
        const body = await readBody(req);
        if (typeof body.name !== 'string' || !body.name) throw badRequest('context body requires "name"');
        const ctx = store.putContext(realmName, nodeId, ctxId, body);
        const wire = await tryWire(realm, (r) => r.registerContext(nodeId, ctxId, ctx));
        return sendJson(res, wire.ok ? 200 : 202, {
          realm: realmName,
          node: nodeId,
          context: ctxId,
          name: ctx.name,
          state: wire.ok ? 'registered' : 'pending',
          ...(wire.ok ? {} : { note: wire.note }),
        });
      }
      if (method === 'GET') {
        const ctx = store.getContext(realmName, nodeId, ctxId);
        if (!ctx) throw notFound(`no context '${ctxId}' declared through this gateway`);
        return sendJson(res, 200, describeContext(realm, realmName, nodeId, ctxId, ctx));
      }
      if (method === 'DELETE') {
        if (!store.getContext(realmName, nodeId, ctxId)) throw notFound(`no context '${ctxId}'`);
        realm.requireClient();
        const prefix = await realm.retractContext(nodeId, ctxId);
        store.deleteContext(realmName, nodeId, ctxId);
        return sendJson(res, 200, {
          realm: realmName, node: nodeId, context: ctxId, retracted: true, prefix,
          note: 'context and its declarations removed; the substrate severs affected connections',
        });
      }
      throw methodNotAllowed(method);
    }

    if (segs[6] !== 'declarations') throw notFound('no route');
    const role = validateRole(segs[7]);
    const profile = validateId(segs[8], 'profile');
    const ctx = store.getContext(realmName, nodeId, ctxId);
    if (!ctx) throw notFound(`no context '${ctxId}' — PUT the context first`);

    // /declarations/{role}/{profile}
    if (segs.length === 9) {
      if (method === 'PUT') {
        return putDeclaration({ req, res, realm, realmName, nodeId, ctxId, role, profile });
      }
      if (method === 'GET') {
        const decl = store.getDeclaration(realmName, nodeId, ctxId, role, profile);
        if (!decl) throw notFound(`no declaration ${role}/${profile}`);
        return sendJson(res, 200, describeDeclaration(realm, realmName, nodeId, ctxId, role, profile, decl));
      }
      if (method === 'DELETE') {
        // Retraction — the app's half of the lifecycle. The substrate severs
        // any resulting connections; we never delete a connection ourselves.
        realm.requireClient();
        const prefix = await realm.retractDeclaration(nodeId, ctxId, role, profile);
        store.deleteDeclaration(realmName, nodeId, ctxId, role, profile);
        return sendJson(res, 200, {
          realm: realmName,
          node: nodeId,
          context: ctxId,
          role,
          profile,
          retracted: true,
          prefix,
          note: 'declaration removed; the substrate severs any connections that depended on it',
        });
      }
      throw methodNotAllowed(method);
    }

    const decl = store.getDeclaration(realmName, nodeId, ctxId, role, profile);
    if (!decl) throw notFound(`no declaration ${role}/${profile} — PUT the declaration first`);

    // /declarations/{role}/{profile}/properties[/{prop}]
    if (segs[9] === 'properties') {
      if (segs.length === 10 && method === 'GET') {
        realm.requireClient();
        return sendJson(res, 200, realm.capabilityProperties(nodeId, ctxId, role, profile));
      }
      if (segs.length === 11 && method === 'PUT') {
        const prop = validateId(segs[10], 'property');
        const body = await readBody(req);
        await checkPropertyWrite(registry, profile, role, prop, { requirePropagate: true });
        realm.requireClient();
        await realm.putCapabilityProperty(nodeId, ctxId, role, profile, prop, body.value ?? '');
        return sendJson(res, 200, { property: prop, value: String(body.value ?? ''), scope: 'capability' });
      }
      if (segs.length === 11 && method === 'GET') {
        realm.requireClient();
        const props = realm.capabilityProperties(nodeId, ctxId, role, profile);
        const prop = segs[10];
        if (!(prop in props)) throw notFound(`no property '${prop}'`);
        return sendJson(res, 200, { property: prop, value: props[prop] });
      }
      throw methodNotAllowed(method);
    }

    // /declarations/{role}/{profile}/connections[/{conn}[/properties[/{prop}]]]
    if (segs[9] === 'connections') {
      realm.requireClient();
      if (segs.length === 10 && method === 'GET') {
        return sendJson(res, 200, realm.connections(nodeId, ctxId, role, profile));
      }
      const connId = validateId(segs[10], 'connection');
      const conn = realm.connection(nodeId, ctxId, role, profile, connId);
      if (!conn) throw notFound(`no connection '${connId}'`);

      if (segs.length === 11 && method === 'GET') {
        return sendJson(res, 200, conn);
      }

      // ---- capabilities on this connection (the device-token surface) ----
      if (segs[11] === 'capabilities') {
        const scope = { realm: realmName, node: nodeId, context: ctxId, role, profile, conn: connId };

        if (segs.length === 12 && method === 'POST') {
          const body = await readBody(req);
          const props = body.properties;
          if (!Array.isArray(props) || props.length === 0)
            throw badRequest('capability requires a non-empty "properties" array');

          // Attenuation: a capability may only name properties the gateway is
          // itself permitted to write on this side of the binding. Checked at
          // MINT time so an impossible capability cannot be created at all.
          const wantsWrite = (body.direction ?? 'write') !== 'read';
          if (wantsWrite) {
            for (const p of props) {
              await checkPropertyWrite(registry, profile, role, p, { requirePropagate: false });
            }
          }

          const { token, record } = capabilities.mint(scope, body);
          return sendJson(res, 201, {
            ...record,
            token,
            note: 'the token is shown ONCE and cannot be recovered — only its hash is stored',
          });
        }

        if (segs.length === 12 && method === 'GET') {
          return sendJson(res, 200, capabilities.list(scope));
        }

        if (segs.length === 13 && method === 'DELETE') {
          const capId = validateId(segs[12], 'capability');
          const rec = capabilities.get(capId);
          if (!rec || rec.conn !== connId) throw notFound(`no capability '${capId}' on this connection`);
          capabilities.revoke(capId);
          return sendJson(res, 200, { capId, revoked: true });
        }

        throw methodNotAllowed(method);
      }

      if (segs[11] === 'properties') {
        if (segs.length === 12 && method === 'GET') {
          return sendJson(res, 200, conn.properties); // merged view: both sides' current values
        }
        if (segs.length === 13 && method === 'PUT') {
          const prop = validateId(segs[12], 'property');
          const body = await readBody(req);
          // Addressed write: propagate NOT required, but only our own side's properties.
          await checkPropertyWrite(registry, profile, role, prop, { requirePropagate: false });
          await realm.putConnectionProperty(nodeId, ctxId, role, profile, connId, prop, body.value ?? '');
          return sendJson(res, 200, { property: prop, value: String(body.value ?? ''), scope: 'connection', conn: connId });
        }
        if (segs.length === 13 && method === 'GET') {
          const prop = segs[12];
          if (!(prop in conn.properties)) throw notFound(`no property '${prop}' on connection`);
          return sendJson(res, 200, { property: prop, value: conn.properties[prop] });
        }
      }
      throw methodNotAllowed(method);
    }

    throw notFound('no route');
  }

  async function putDeclaration({ req, res, realm, realmName, nodeId, ctxId, role, profile }) {
    const body = await readBody(req);
    const normalized = { properties: body.properties ?? {} };

    // Registry rule: resolve every CP before use. An unregistered profile will
    // not bind on a live realm (the control plane cannot produce matchable
    // version keys) — refusing here turns a silent no-bind into a clear error.
    const entry = await registry.resolve(profile);
    if (!entry) {
      throw new ApiError(
        422,
        'unknown_profile',
        `profile '${profile}' is not registered at cp.padi.io — it would never bind; register it (padi.test.* for development) first`,
      );
    }

    // Validate initial properties against the CP.
    for (const prop of Object.keys(normalized.properties)) {
      const flag = entry.flags[prop];
      if (!flag) throw new ApiError(422, 'unknown_property', `profile '${profile}' has no property '${prop}'`);
      if (writerRole(flag) !== role)
        throw new ApiError(
          422,
          'wrong_role_property',
          `property '${prop}' is written by the ${writerRole(flag)} — a ${role} declaration cannot set it`,
        );
    }

    const existing = store.getDeclaration(realmName, nodeId, ctxId, role, profile);
    if (existing) {
      if (deepEqual({ properties: existing.properties }, normalized)) {
        return sendJson(res, 200, describeDeclaration(realm, realmName, nodeId, ctxId, role, profile, existing));
      }
      throw new ApiError(
        409,
        'conflicting_redeclaration',
        `declaration ${role}/${profile} already exists with a different body; use the properties endpoints to change values`,
      );
    }

    const decl = store.putDeclaration(realmName, nodeId, ctxId, role, profile, normalized);
    const wire = await tryWire(realm, (r) => r.declareOnWire(nodeId, ctxId, role, profile, decl));
    return sendJson(res, wire.ok ? 201 : 202, {
      ...describeDeclaration(realm, realmName, nodeId, ctxId, role, profile, decl),
      state: wire.ok ? 'declared' : 'pending',
      ...(wire.ok ? {} : { note: wire.note }),
    });
  }

  function describeDeclaration(realm, realmName, nodeId, ctxId, role, profile, decl) {
    const connected = realm.state === 'connected';
    return {
      realm: realmName,
      node: nodeId,
      context: ctxId,
      role,
      profile,
      declaredAt: decl.declaredAt,
      state: connected ? 'declared' : 'pending',
      properties: connected ? realm.capabilityProperties(nodeId, ctxId, role, profile) : decl.properties,
      connections: connected ? realm.connections(nodeId, ctxId, role, profile).length : 0,
    };
  }

  function describeContext(realm, realmName, nodeId, ctxId, ctx) {
    return {
      realm: realmName,
      node: nodeId,
      context: ctxId,
      name: ctx.name,
      declarations: Object.entries(ctx.declarations).map(([key, decl]) => {
        const slash = key.indexOf('/');
        return describeDeclaration(realm, realmName, nodeId, ctxId, key.slice(0, slash), key.slice(slash + 1), decl);
      }),
    };
  }

  function describeNode(realm, realmName, nodeId, node) {
    return {
      realm: realmName,
      node: nodeId,
      name: node.name,
      upstream: node.upstream,
      contexts: Object.entries(node.contexts ?? {}).map(([ctxId, ctx]) =>
        describeContext(realm, realmName, nodeId, ctxId, ctx),
      ),
    };
  }
}

async function checkPropertyWrite(registry, profile, role, prop, { requirePropagate }) {
  const entry = await registry.resolve(profile);
  if (!entry) throw new ApiError(422, 'unknown_profile', `profile '${profile}' not in registry`);
  const flag = entry.flags[prop];
  if (!flag) throw new ApiError(422, 'unknown_property', `profile '${profile}' has no property '${prop}'`);
  if (writerRole(flag) !== role) {
    throw new ApiError(
      422,
      'wrong_role_property',
      `property '${prop}' is written by the ${writerRole(flag)}; this declaration is a ${role}`,
    );
  }
  if (requirePropagate && !flag.propagate) {
    throw new ApiError(
      422,
      'not_propagated',
      `property '${prop}' has no propagate flag — a capability-level write would not broadcast; use the per-connection endpoint (…/connections/{conn}/properties/${prop}) instead`,
    );
  }
}

async function tryWire(realm, fn) {
  if (realm.state !== 'connected') {
    return { ok: false, note: `realm not connected (${realm.state}) — persisted, will replay on reconnect` };
  }
  await fn(realm);
  return { ok: true };
}

function pickFilter(params) {
  const filter = {};
  for (const k of ['realm', 'node', 'context', 'role', 'profile', 'type']) {
    if (params.has(k)) filter[k] = params.get(k);
  }
  return Object.keys(filter).length ? filter : null;
}

function methodNotAllowed(method) {
  return new ApiError(405, 'method_not_allowed', `${method} not allowed here`);
}
