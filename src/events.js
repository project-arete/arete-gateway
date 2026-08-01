// Event hub: in-memory ring buffer (10k events) + SSE fan-out with
// Last-Event-ID resume. Event IDs carry a boot epoch so a resume attempt from
// a previous gateway process is detected (client gets full buffer replay
// rather than a silent gap).

const MAX_EVENTS = 10000;

export class EventHub {
  #buf = [];
  #seq = 0;
  #boot = Date.now().toString(36);
  #subs = new Set(); // { res, filter }
  #listeners = new Set(); // programmatic consumers (webhook delivery)

  /**
   * Register an in-process consumer of every event. Used by webhook delivery,
   * which needs the same envelopes SSE gets but has to queue and retry them.
   * Returns an unsubscribe function.
   */
  onEvent(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  emit(type, fields) {
    const evt = {
      eventId: `evt_${this.#boot}_${String(++this.#seq).padStart(8, '0')}`,
      type,
      occurredAt: new Date().toISOString(),
      ...fields,
    };
    this.#buf.push(evt);
    if (this.#buf.length > MAX_EVENTS) this.#buf.shift();
    for (const sub of this.#subs) {
      if (matches(evt, sub.filter)) writeSse(sub.res, evt);
    }
    // Listeners must never break event emission for everyone else.
    for (const fn of this.#listeners) {
      try {
        fn(evt);
      } catch {
        /* a broken consumer is its own problem */
      }
    }
    return evt;
  }

  recent(filter, limit = 100) {
    const out = [];
    for (let i = this.#buf.length - 1; i >= 0 && out.length < limit; i--) {
      if (matches(this.#buf[i], filter)) out.push(this.#buf[i]);
    }
    return out.reverse();
  }

  subscribe(req, res, filter) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': arete-gateway event stream\n\n');

    // Resume: replay everything after Last-Event-ID (or the full buffer if the
    // ID is from a previous boot / unknown).
    const lastId = req.headers['last-event-id'];
    let replayFrom = 0;
    if (lastId) {
      const idx = this.#buf.findIndex((e) => e.eventId === lastId);
      replayFrom = idx >= 0 ? idx + 1 : 0;
    } else {
      replayFrom = this.#buf.length; // no resume: live only
    }
    for (let i = replayFrom; i < this.#buf.length; i++) {
      if (matches(this.#buf[i], filter)) writeSse(res, this.#buf[i]);
    }

    const sub = { res, filter };
    this.#subs.add(sub);
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* cleanup below */
      }
    }, 25000);
    req.on('close', () => {
      clearInterval(ping);
      this.#subs.delete(sub);
    });
  }
}

function writeSse(res, evt) {
  try {
    res.write(`id: ${evt.eventId}\nevent: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
  } catch {
    /* subscriber going away; close handler cleans up */
  }
}

// Exported so webhook delivery applies exactly the same filter semantics as
// SSE — one definition, so the two paths cannot drift.
export function eventMatches(evt, filter) {
  return matches(evt, filter);
}

function matches(evt, filter) {
  if (!filter) return true;
  for (const k of ['realm', 'node', 'context', 'role', 'profile', 'type']) {
    if (filter[k] !== undefined && evt[k] !== filter[k]) return false;
  }
  return true;
}
