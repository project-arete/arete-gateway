// Small shared helpers: errors, validation, JSON body handling.

export const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const ROLES = ['provider', 'consumer'];

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function badRequest(message) {
  return new ApiError(400, 'bad_request', message);
}

export function notFound(message) {
  return new ApiError(404, 'not_found', message);
}

export function validateId(value, label) {
  if (typeof value !== 'string' || !ID_RE.test(value))
    throw badRequest(
      `${label} must be 1-64 chars of [A-Za-z0-9._-], got: ${JSON.stringify(value)}`,
    );
  return value;
}

export function validateRole(role) {
  if (!ROLES.includes(role))
    throw badRequest(`role must be provider|consumer, got: ${role}`);
  return role;
}

export function sendJson(res, status, body) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

export function sendError(res, err) {
  const status = err.status || 500;
  const code = err.code || 'internal';
  sendJson(res, status, { error: { code, message: err.message } });
}

export function readBody(req, limit = 262144) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new ApiError(413, 'too_large', 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(badRequest('body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Deep equality for small JSON bodies (declaration conflict detection).
export function deepEqual(a, b) {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

function normalize(v) {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, normalize(v[k])]),
    );
  return v;
}
