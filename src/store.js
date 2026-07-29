// Persistent gateway state: API-attached realms + the declaration tree.
// Declarations are persisted so the gateway can replay them on restart and
// realm reconnect (conditionally — see realm.js value-wiper protection).

import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'state.json');
    this.state = { realms: {}, tree: {} };
    if (fs.existsSync(this.file)) {
      try {
        this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch (e) {
        console.error(`[store] could not parse ${this.file}: ${e.message} — starting empty`);
      }
    }
    this.state.realms = this.state.realms ?? {};
    this.state.tree = this.state.tree ?? {};
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  // ----- realms (API-attached; config-declared realms are not stored here) -----

  getRealms() {
    return this.state.realms;
  }

  putRealm(name, cfg) {
    this.state.realms[name] = cfg;
    this.save();
  }

  deleteRealm(name) {
    delete this.state.realms[name];
    delete this.state.tree[name];
    this.save();
  }

  // ----- declaration tree -----

  getTree(realm) {
    this.state.tree[realm] = this.state.tree[realm] ?? { nodes: {} };
    return this.state.tree[realm];
  }

  getNode(realm, node) {
    return this.getTree(realm).nodes[node];
  }

  putNode(realm, node, body) {
    const tree = this.getTree(realm);
    const existing = tree.nodes[node] ?? { contexts: {} };
    tree.nodes[node] = {
      ...existing,
      name: body.name,
      upstream: !!body.upstream,
    };
    this.save();
    return tree.nodes[node];
  }

  getContext(realm, node, ctx) {
    return this.getNode(realm, node)?.contexts?.[ctx];
  }

  putContext(realm, node, ctx, body) {
    const n = this.getNode(realm, node);
    const existing = n.contexts[ctx] ?? { declarations: {} };
    n.contexts[ctx] = { ...existing, name: body.name };
    this.save();
    return n.contexts[ctx];
  }

  getDeclaration(realm, node, ctx, role, profile) {
    return this.getContext(realm, node, ctx)?.declarations?.[`${role}/${profile}`];
  }

  putDeclaration(realm, node, ctx, role, profile, body) {
    const c = this.getContext(realm, node, ctx);
    c.declarations[`${role}/${profile}`] = {
      properties: body.properties ?? {},
      declaredAt: new Date().toISOString(),
    };
    this.save();
    return c.declarations[`${role}/${profile}`];
  }
}
