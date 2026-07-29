// E2E peer: a plain patched-SDK provider (the "switch") that binds against the
// gateway's consumer declaration in the same context, writes sOut, and waits
// to observe the consumer's cState reply on the connection.
//
// Usage: ARETE_SYSTEM_ID=<uuid> node test/peer-provider.js <host> <ctxId>

import { Client } from 'arete-sdk';

const [, , host, ctxId] = process.argv;
if (!host || !ctxId) {
  console.error('usage: peer-provider.js <host> <ctxId>');
  process.exit(2);
}

const NODE_ID = 'gw-e2e-peer';
const PROFILE = 'padi.light';

const client = new Client({ protocol: 'wss:', host, port: 443 });
// Arm the first-message waiter BEFORE waitForOpen: the SDK emits 'open' on the
// first MESSAGE, which can arrive while waitForOpen is still polling.
const snapshot = new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('no snapshot')), 12000);
  client.on('open', () => {
    clearTimeout(t);
    resolve();
  });
});
await client.waitForOpen(10000);
await snapshot;

const system = await client.system('GW E2E Peer');
const node = await system.node(NODE_ID, 'Peer Node', false);
const ctx = await node.context(ctxId, 'Peer View');

const prefix = `cns/${system.id}/nodes/${NODE_ID}/contexts/${ctxId}/provider/${PROFILE}`;

// Value-wiper protection, same rule as the gateway: only declare if absent.
if (client.get(`${prefix}/version`) === null) {
  await ctx.provider(PROFILE);
}
await client.put(`${prefix}/properties/sLabel`, 'E2E Switch');
console.log('PEER READY');

// Wait for the broker to bind us.
const connRe = new RegExp(`^${prefix.replace(/[.]/g, '\\.')}/connections/([^/]+)/`);
let connId = null;
const bindStart = Date.now();
while (Date.now() - bindStart < 60000 && !connId) {
  for (const k of Object.keys(client.keys)) {
    const m = k.match(connRe);
    if (m) {
      connId = m[1];
      break;
    }
  }
  if (!connId) await new Promise((r) => setTimeout(r, 400));
}
if (!connId) {
  console.log('PEER NO-BIND');
  process.exit(1);
}
console.log(`PEER BOUND ${connId}`);

await client.put(`${prefix}/properties/sOut`, '1');
console.log('PEER WROTE sOut=1');

// Wait to see the consumer's cState=1 mirrored onto our side of the connection.
const cKey = `${prefix}/connections/${connId}/properties/cState`;
const seeStart = Date.now();
while (Date.now() - seeStart < 30000) {
  if (client.get(cKey) === '1') {
    console.log('PEER SAW cState=1');
    client.dispose();
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 300));
}
console.log('PEER TIMEOUT waiting for cState');
process.exit(1);
