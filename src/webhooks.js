// Webhook delivery (design doc §4.6).
//
// Same envelopes SSE carries, pushed to an app's HTTP endpoint. The delivery
// contract, and why each part is the way it is:
//
//   AT-LEAST-ONCE      a delivery that fails is retried; the app dedupes on
//                      eventId. Never at-most-once — losing a connection.created
//                      silently is worse than seeing it twice.
//   ORDERED PER HOOK   one delivery in flight per hook, so events arrive in the
//                      order they happened. The doc asks for per-connection
//                      ordering; per-hook is strictly stronger and much simpler
//                      to reason about.
//   SIGNED             HMAC-SHA256 over the exact bytes sent, in
//                      X-Arete-Signature, so a receiver can verify origin.
//   BOUNDED            a dead endpoint must not grow memory without limit, so
//                      each hook has a capped queue and gives up after 24h.
//
// Deliberately NOT here: delivery of events that occurred while the gateway was
// down. The realm is the source of truth and the gateway re-derives state on
// reconnect; replaying a stale event log across restarts would produce
// confident lies about the present.

import crypto from 'node:crypto';
import { eventMatches } from './events.js';

const MAX_QUEUE = 1000;          // per hook
const GIVE_UP_MS = 24 * 60 * 60 * 1000;
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;

export class WebhookManager {
  #store;
  #hub;
  #hooks = new Map();   // id -> { record, queue:[], sending, timer, stats }
  #log;

  constructor({ store, hub, log }) {
    this.#store = store;
    this.#hub = hub;
    this.#log = log ?? (() => {});

    for (const [id, record] of Object.entries(store.getWebhooks())) {
      this.#hooks.set(id, this.#blank(record));
    }

    this.#hub.onEvent((evt) => this.#fanout(evt));
  }

  #blank(record) {
    return {
      record,
      queue: [],
      sending: false,
      timer: null,
      stats: { delivered: 0, failed: 0, dropped: 0, lastStatus: null, lastError: null, lastAt: null },
    };
  }

  // ---------------- registration ----------------

  list() {
    return [...this.#hooks.entries()].map(([hook, h]) => this.#describe(hook, h));
  }

  get(hook) {
    const h = this.#hooks.get(hook);
    return h ? this.#describe(hook, h) : null;
  }

  /** The secret is write-only: stored, never echoed. */
  #describe(hook, h) {
    return {
      hook,
      url: h.record.url,
      events: h.record.events ?? null,
      filter: h.record.filter ?? null,
      hasSecret: !!h.record.secret,
      createdAt: h.record.createdAt,
      queued: h.queue.length,
      ...h.stats,
    };
  }

  put(hook, body) {
    const record = {
      url: body.url,
      secret: body.secret ?? '',
      events: Array.isArray(body.events) && body.events.length ? body.events : null,
      filter: body.filter ?? null,
      createdAt: this.#hooks.get(hook)?.record.createdAt ?? new Date().toISOString(),
    };

    this.#store.putWebhook(hook, record);

    const existing = this.#hooks.get(hook);
    if (existing) {
      existing.record = record;          // keep queue and stats across an update
    } else {
      this.#hooks.set(hook, this.#blank(record));
    }
    return this.get(hook);
  }

  delete(hook) {
    const h = this.#hooks.get(hook);
    if (h?.timer) clearTimeout(h.timer);
    this.#hooks.delete(hook);
    return this.#store.deleteWebhook(hook);
  }

  /**
   * Fire a synthetic event at one hook, end to end.
   *
   * DELIBERATELY bypasses the hook's event/filter selection: this is a
   * connectivity check, and one that silently delivered nothing because the
   * hook filters out webhook.test would be worse than useless.
   */
  test(hook) {
    const h = this.#hooks.get(hook);
    if (!h) return false;
    this.#enqueue(hook, h, {
      eventId: `evt_test_${crypto.randomBytes(6).toString('hex')}`,
      type: 'webhook.test',
      occurredAt: new Date().toISOString(),
      data: { note: 'synthetic event from POST /v0/webhooks/{hook}/test' },
    });
    return true;
  }

  // ---------------- delivery ----------------

  #fanout(evt) {
    for (const [hook, h] of this.#hooks) {
      const { events, filter } = h.record;
      if (events && !events.includes(evt.type)) continue;
      if (filter && !eventMatches(evt, filter)) continue;
      this.#enqueue(hook, h, evt);
    }
  }

  #enqueue(hook, h, evt) {
    if (h.queue.length >= MAX_QUEUE) {
      // Drop the OLDEST: a wedged endpoint should not stop us delivering what
      // is happening now, and the newest events describe the current state.
      h.queue.shift();
      h.stats.dropped++;
    }
    h.queue.push({ evt, attempt: 0, firstTried: Date.now(), backoff: BACKOFF_START_MS });
    this.#pump(hook, h);
  }

  async #pump(hook, h) {
    if (h.sending || h.timer || h.queue.length === 0) return;
    h.sending = true;

    const item = h.queue[0];
    let ok = false;
    let status = null;
    let error = null;

    try {
      const res = await this.#send(h.record, item.evt);
      status = res.status;
      ok = res.ok;
      if (!ok) error = `HTTP ${res.status}`;
    } catch (e) {
      error = e?.name === 'TimeoutError' ? 'timeout' : String(e?.message ?? e).slice(0, 200);
    }

    h.sending = false;
    h.stats.lastAt = new Date().toISOString();
    h.stats.lastStatus = status;

    if (ok) {
      h.queue.shift();
      h.stats.delivered++;
      h.stats.lastError = null;
      this.#pump(hook, h);
      return;
    }

    h.stats.failed++;
    h.stats.lastError = error;
    item.attempt++;

    if (Date.now() - item.firstTried > GIVE_UP_MS) {
      this.#log('warn', `webhook ${hook}: giving up on ${item.evt.eventId} after 24h (${error})`);
      h.queue.shift();
      h.stats.dropped++;
      this.#pump(hook, h);
      return;
    }

    // Retry the SAME event before anything after it: ordering is the promise.
    const wait = Math.min(item.backoff, BACKOFF_MAX_MS);
    item.backoff = Math.min(item.backoff * 2, BACKOFF_MAX_MS);
    this.#log('debug', `webhook ${hook}: ${error} — retry in ${wait}ms (attempt ${item.attempt})`);

    h.timer = setTimeout(() => {
      h.timer = null;
      this.#pump(hook, h);
    }, wait);
    if (h.timer.unref) h.timer.unref();
  }

  async #send(record, evt) {
    const body = JSON.stringify(evt);
    const headers = {
      'Content-Type': 'application/json',
      'X-Arete-Event': evt.type,
      'X-Arete-Event-Id': evt.eventId,
    };

    if (record.secret) {
      // Sign the exact bytes we send, so a receiver can recompute it without
      // guessing at serialisation.
      headers['X-Arete-Signature'] =
        'sha256=' + crypto.createHmac('sha256', record.secret).update(body).digest('hex');
    }

    return fetch(record.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  stop() {
    for (const h of this.#hooks.values()) {
      if (h.timer) clearTimeout(h.timer);
    }
  }
}
