// Console smoke test.
//
// ui/index.html is a single file with no build step and no framework, so
// nothing catches a typo'd selector or a handler wired to an id that does not
// exist — the page just quietly does nothing. This loads the real page in a
// DOM with a stubbed fetch and drives it, asserting the parts that carry
// behaviour rather than the parts that carry pixels.
//
// Usage: npm run test:console   (needs jsdom; skips cleanly without it)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.log('jsdom not installed (npm install) — skipping console test.');
  process.exit(0);
}

const results = [];
const check = (label, ok, detail) => {
  results.push({ label, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? '  — ' + detail : ''}`);
};

// ---------- the fake gateway ----------
const CONN = 'conn-abc123';
const DECL_BASE = '/v0/realms/test/nodes/n1/contexts/c1/declarations/consumer/padi.light';

const state = {
  hooks: [{
    hook: 'my-hook', url: 'http://127.0.0.1:9000/arete', events: ['property.changed'],
    filter: null, hasSecret: true, createdAt: '2026-07-31T00:00:00Z',
    queued: 0, delivered: 7, failed: 2, dropped: 0, lastStatus: 500,
    lastError: 'HTTP 500', lastAt: '2026-07-31T00:00:01Z',
  }],
  capabilities: [],
  minted: null,
  deleted: [],
  tested: [],
};

function reply(url, opts = {}) {
  const method = opts.method ?? 'GET';
  const p = url.replace(/^https?:\/\/[^/]+/, '');

  if (p === '/v0/status') return { realms: [{ realm: 'test', state: 'connected', host: 'h', port: 443 }] };
  if (p === '/v0/realms') return [{ realm: 'test', state: 'connected', host: 'h' }];

  if (p === '/v0/realms/test/nodes') {
    return [{
      realm: 'test', node: 'n1', name: 'Node One', upstream: false,
      contexts: [{
        realm: 'test', node: 'n1', context: 'c1', name: 'Ctx One',
        declarations: [{
          realm: 'test', node: 'n1', context: 'c1', role: 'consumer', profile: 'padi.light',
          state: 'declared', properties: { cState: '0' }, connections: 1,
        }],
      }],
    }];
  }

  if (p === `${DECL_BASE}/connections`) {
    return [{
      conn: CONN, state: 'bound',
      properties: { cState: '0', sOut: '1' },
      attributes: { provider: 'cns/peer-system-id/nodes/sw/contexts/c1' },
    }];
  }

  if (p === `${DECL_BASE}/connections/${CONN}/capabilities`) {
    if (method === 'POST') {
      const body = JSON.parse(opts.body);
      state.minted = body;
      const rec = {
        capId: 'cap_deadbeef', conn: CONN, properties: body.properties,
        direction: body.direction, label: body.label ?? '', uses: 0,
        token: 'acap_SECRET_TOKEN_VALUE',
      };
      state.capabilities.push({ ...rec, token: undefined });
      return rec;
    }
    return state.capabilities;
  }

  if (p.startsWith(`${DECL_BASE}/connections/${CONN}/capabilities/`) && method === 'DELETE') {
    state.deleted.push(p.split('/').pop());
    return { revoked: true };
  }

  if (p === '/v0/webhooks') return state.hooks;
  if (p.endsWith('/test') && method === 'POST') { state.tested.push(p); return { queued: true }; }
  if (p.startsWith('/v0/webhooks/') && method === 'PUT') {
    const id = p.split('/').pop();
    state.hooks.push({ hook: id, url: JSON.parse(opts.body).url, events: JSON.parse(opts.body).events ?? null,
      hasSecret: !!JSON.parse(opts.body).secret, queued: 0, delivered: 0, failed: 0 });
    return state.hooks[state.hooks.length - 1];
  }
  if (p.startsWith('/v0/webhooks/') && method === 'DELETE') {
    state.hooks = state.hooks.filter((h) => h.hook !== p.split('/').pop());
    return { deleted: true };
  }
  return {};
}

const html = fs.readFileSync(path.join(root, 'ui', 'index.html'), 'utf8');

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'http://127.0.0.1:8420/ui',
  beforeParse(win) {
    win.localStorage.setItem('agw.token', 'test-token');
    win.localStorage.setItem('agw.base', '');
    win.fetch = async (url, opts) => ({
      ok: true, status: 200,
      json: async () => reply(String(url), opts),
    });
    // EventSource is not in jsdom; the console only needs it not to throw.
    win.EventSource = class { constructor() { this.readyState = 0; } addEventListener() {} close() {} };
    win.alert = () => {};
    win.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    win.HTMLDialogElement.prototype.close = function () { this.open = false; };
  },
});

const win = dom.window;
const $ = (s) => win.document.querySelector(s);
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

await settle(400);

try {
  // ---------- webhooks panel ----------
  check('webhook panel lists the registered hook',
    $('#hooks').textContent.includes('my-hook'), $('#hooks').textContent.slice(0, 80));
  check('webhook shows delivery stats',
    /7 delivered/.test($('#hooks').textContent) && /2 failed/.test($('#hooks').textContent),
    $('#hooks').textContent.replace(/\s+/g, ' ').slice(0, 120));
  check('webhook secret is never rendered',
    !$('#hooks').textContent.includes('whsec') && $('#hooks').textContent.includes('signed'));

  $('[data-hook-test]').click();
  await settle(200);
  check('Test button calls the test endpoint', state.tested.length === 1, JSON.stringify(state.tested));

  // register dialog
  $('#hookaddbtn').click();
  await settle();
  check('Add opens the register dialog with event choices',
    $('#hookdlg').open && $('#h_events').querySelectorAll('input').length >= 5);

  $('#h_id').value = 'from-console';
  $('#h_url').value = 'http://127.0.0.1:9100/x';
  $('#h_events').querySelector('input[value="connection.created"]').checked = true;
  $('#h_save').click();
  await settle(250);
  check('registering adds the hook', state.hooks.some((h) => h.hook === 'from-console'),
    JSON.stringify(state.hooks.map((h) => h.hook)));
  check('only the ticked event is sent',
    state.hooks.find((h) => h.hook === 'from-console')?.events?.join() === 'connection.created');

  // ---------- capabilities on a connection ----------
  const mint = $('[data-cap-mint]');
  check('connection offers a mint button', !!mint);
  check('mint button carries the connection and its properties',
    mint?.dataset.capMint === CONN && JSON.parse(mint.dataset.capProps).includes('cState'),
    mint?.dataset.capProps);

  check('connection shows the peer from the record',
    $('.conn')?.textContent.includes('peer'), $('.conn')?.textContent.slice(0, 90));

  mint.click();
  await settle();
  check('mint dialog opens listing this connection\'s properties',
    $('#capdlg').open && $('#cap_props').querySelectorAll('input').length === 2);

  $('#cap_props').querySelector('input[value="cState"]').checked = true;
  $('#cap_dir').value = 'readwrite';
  $('#cap_label').value = 'wall switch';
  $('#cap_save').click();
  await settle(250);

  check('minting posts the chosen properties and direction',
    state.minted?.properties.join() === 'cState' && state.minted?.direction === 'readwrite',
    JSON.stringify(state.minted));
  check('the token is shown once, in its own dialog',
    $('#tokendlg').open && $('#tok_value').value === 'acap_SECRET_TOKEN_VALUE');
  check('token dialog states the scope',
    $('#tok_scope').textContent.includes('readwrite') && $('#tok_scope').textContent.includes(CONN),
    $('#tok_scope').textContent);

  $('#tok_close').click();
  await settle();

  // revoke
  await settle(300);
  const rev = $('[data-cap-revoke]');
  check('minted capability appears on the connection', !!rev);
  if (rev) {
    rev.click();
    await settle(250);
    check('revoke calls DELETE for that capability', state.deleted.includes('cap_deadbeef'),
      JSON.stringify(state.deleted));
  } else {
    check('revoke calls DELETE for that capability', false, 'no revoke button rendered');
  }
} catch (err) {
  check('console ran without throwing', false, err.message);
}

// Anything the page logged as an error is a failure we would otherwise miss.
const failed = results.filter((r) => !r.ok);
console.log(`\n=== console: ${results.length - failed.length}/${results.length} passed ===`);
dom.window.close();
process.exit(failed.length ? 1 : 0);
