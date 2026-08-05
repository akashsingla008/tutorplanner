// Same-origin off-device backup endpoint.
//
// Why this exists: on 2026-08-05 the browser evicted this app's localStorage and
// every on-device backup died with it - autoBackups, cleanupBackups and the
// live data share one storage bucket, so they share one fate. A copy has to
// live somewhere the browser cannot reclaim.
//
// Deliberately dependency-free: it talks to Vercel KV over its REST API using
// the global fetch in the Node runtime, so the project stays a static site with
// no package.json, no build step, and no npm install.
//
// Being same-origin also means the existing CSP (connect-src 'self') needs no
// change - an external service like Supabase would have required loosening it.
//
// Required environment variables (Vercel project settings):
//   KV_REST_API_URL    | injected automatically when a KV store is connected
//   KV_REST_API_TOKEN  | injected automatically when a KV store is connected
//   MM_SYNC_TOKEN      | a passphrase you choose; the app sends it as a header
//
// Until those are set every request returns 503 and the app carries on exactly
// as before, so deploying this cannot break anything.

const LATEST_KEY = 'mm:backup:latest';
const HISTORY_KEY = 'mm:backup:history';
const HISTORY_LIMIT = 30;
const MAX_BYTES = 4 * 1024 * 1024; // generous: real payloads are ~150 KB

function isConfigured() {
  return Boolean(
    process.env.KV_REST_API_URL &&
    process.env.KV_REST_API_TOKEN &&
    process.env.MM_SYNC_TOKEN
  );
}

// Single Redis command via the Upstash REST API.
async function redis(command) {
  const response = await fetch(process.env.KV_REST_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`KV request failed (${response.status}): ${detail.slice(0, 200)}`);
  }

  const payload = await response.json();
  return payload.result;
}

// Constant-time-ish comparison so the token can't be probed byte by byte.
function tokenMatches(provided, expected) {
  if (typeof provided !== 'string' || provided.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

function summarise(payload) {
  const data = (payload && payload.data) || {};
  return {
    savedAt: new Date().toISOString(),
    exportDate: payload && payload.exportDate,
    version: payload && payload.version,
    classes: Array.isArray(data.classes) ? data.classes.length : 0,
    expenses: Array.isArray(data.expenses) ? data.expenses.length : 0,
    students: data.studentRates ? Object.keys(data.studentRates).length : 0,
    payments: data.paymentStatus ? Object.keys(data.paymentStatus).length : 0
  };
}

module.exports = async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');

  if (!isConfigured()) {
    return response.status(503).json({
      error: 'sync-not-configured',
      message: 'Connect a Vercel KV store and set MM_SYNC_TOKEN to enable cloud backup.'
    });
  }

  if (!tokenMatches(request.headers['x-mm-token'], process.env.MM_SYNC_TOKEN)) {
    return response.status(401).json({ error: 'unauthorized' });
  }

  try {
    if (request.method === 'GET') {
      if (request.query && request.query.history) {
        const rows = await redis(['LRANGE', HISTORY_KEY, 0, HISTORY_LIMIT - 1]);
        const history = (rows || []).map(row => {
          try { return JSON.parse(row); } catch (e) { return null; }
        }).filter(Boolean);
        return response.status(200).json({ history });
      }

      const raw = await redis(['GET', LATEST_KEY]);
      if (!raw) {
        return response.status(404).json({ error: 'no-backup-yet' });
      }
      return response.status(200).json(JSON.parse(raw));
    }

    if (request.method === 'POST') {
      const payload = request.body;

      // Refuse anything that isn't a recognisable export, so a bug on the
      // client can't overwrite a good cloud copy with junk.
      if (!payload || typeof payload !== 'object' || !payload.data || !Array.isArray(payload.data.classes)) {
        return response.status(400).json({ error: 'invalid-payload' });
      }

      const serialised = JSON.stringify(payload);
      if (serialised.length > MAX_BYTES) {
        return response.status(413).json({ error: 'payload-too-large', bytes: serialised.length });
      }

      // Never let an empty class list replace a non-empty stored copy. This is
      // the same guard saveClasses() applies locally: a wipe must not propagate.
      if (payload.data.classes.length === 0) {
        const existing = await redis(['GET', LATEST_KEY]);
        if (existing) {
          let previousCount = 0;
          try { previousCount = JSON.parse(existing).data.classes.length; } catch (e) { previousCount = 0; }
          if (previousCount > 0) {
            return response.status(409).json({
              error: 'refused-empty-overwrite',
              message: `Refused to replace ${previousCount} stored classes with 0.`,
              storedClasses: previousCount
            });
          }
        }
      }

      const meta = summarise(payload);
      await redis(['SET', LATEST_KEY, serialised]);
      await redis(['LPUSH', HISTORY_KEY, JSON.stringify(meta)]);
      await redis(['LTRIM', HISTORY_KEY, 0, HISTORY_LIMIT - 1]);

      return response.status(200).json({ ok: true, ...meta });
    }

    response.setHeader('Allow', 'GET, POST');
    return response.status(405).json({ error: 'method-not-allowed' });
  } catch (error) {
    return response.status(500).json({ error: 'kv-failure', message: String(error.message || error) });
  }
};
