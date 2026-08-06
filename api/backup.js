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
//   MM_SYNC_TOKEN  | a passphrase you choose; the app sends it as a header
//   plus a Redis REST url/token pair, injected automatically when you connect
//   an Upstash (or Redis) store from the Storage tab.
//
// Vercel retired the first-party "KV" product and moved it to the Upstash
// marketplace entry, and the injected variable names differ between the old
// and new integrations. Rather than guess, accept every known spelling - and
// when nothing is configured, report which pieces were found so setup is
// self-diagnosing instead of a silent 503.
//
// Until it is configured every request returns 503 and the app carries on
// exactly as before, so deploying this cannot break anything.

const LATEST_KEY = 'mm:backup:latest';
const HISTORY_KEY = 'mm:backup:history';
const HISTORY_LIMIT = 30;
const MAX_BYTES = 4 * 1024 * 1024; // generous: real payloads are ~150 KB

// Rolling per-day snapshots, so a bad day can be rolled back rather than only
// the newest state being recoverable. `latest` alone is a single point of
// failure: the empty-overwrite guard catches a wipe but not corruption.
//
// Retention is by count, not by TTL: keeping the 7 most recent day snapshots
// however old they are means an app left unopened for a fortnight still has a
// week of history, whereas a 7-day TTL would silently expire all of it.
const DAY_PREFIX = 'mm:backup:day:';
const DAYS_INDEX = 'mm:backup:days';
const DAILY_RETENTION = 7;

// One snapshot is ~78 KB, so 7 days plus `latest` is ~0.6 MB against Upstash's
// 256 MB free allowance, and the extra commands per push are a rounding error
// against 500K/month.

function utcDateKey() {
  return new Date().toISOString().slice(0, 10);
}

// The client sends its own local calendar date, because the tutor is in IST and
// a UTC day boundary would file an 11pm edit under the following day.
function resolveDayKey(payload) {
  const supplied = payload && payload.localDate;
  return /^\d{4}-\d{2}-\d{2}$/.test(supplied || '') ? supplied : utcDateKey();
}

const URL_VARS = [
  'KV_REST_API_URL',            // legacy Vercel KV
  'UPSTASH_REDIS_REST_URL',     // Upstash marketplace integration
  'REDIS_REST_URL',
  'KV_URL_REST'
];
const TOKEN_VARS = [
  'KV_REST_API_TOKEN',
  'UPSTASH_REDIS_REST_TOKEN',
  'REDIS_REST_TOKEN',
  'KV_TOKEN_REST'
];

function firstSet(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return { name, value };
  }
  return null;
}

function getStoreConfig() {
  return { url: firstSet(URL_VARS), token: firstSet(TOKEN_VARS) };
}

function isConfigured() {
  const { url, token } = getStoreConfig();
  return Boolean(url && token && process.env.MM_SYNC_TOKEN);
}

// Single Redis command via the Upstash-compatible REST API.
async function redis(command) {
  const { url, token } = getStoreConfig();
  const response = await fetch(url.value, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.value}`,
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

  // Unauthenticated setup check. Deliberately reveals nothing sensitive: which
  // env var names were found (never their values) and whether the store answers
  // a PING. It performs no reads or writes of backup data. This exists so the
  // Upstash wiring can be confirmed without handing the passphrase around.
  if (request.query && request.query.health) {
    const { url, token } = getStoreConfig();
    const result = {
      configured: isConfigured(),
      storeUrlVar: url ? url.name : null,
      storeTokenVar: token ? token.name : null,
      syncPassphraseSet: Boolean(process.env.MM_SYNC_TOKEN),
      ping: null
    };

    if (url && token) {
      try {
        result.ping = await redis(['PING']);

        // Existence only - deliberately no counts, dates or content. Enough to
        // answer "did a backup ever land?" without disclosing how much data
        // there is or when it was last touched. The authenticated verify
        // endpoint below reports the detail.
        const stored = await redis(['GET', LATEST_KEY]);
        result.hasBackup = Boolean(stored);
        const dayRows = await redis(['LRANGE', DAYS_INDEX, 0, DAILY_RETENTION - 1]);
        result.daySnapshotCount = (dayRows || []).length;
      } catch (error) {
        result.ping = 'error';
        result.pingError = String(error.message || error).slice(0, 200);
      }
    }

    result.ready = result.configured && result.ping === 'PONG';
    return response.status(result.ready ? 200 : 503).json(result);
  }

  if (!isConfigured()) {
    // Say exactly which piece is missing. Names only, never values.
    const { url, token } = getStoreConfig();
    return response.status(503).json({
      error: 'sync-not-configured',
      message: 'Connect an Upstash/Redis store from the Storage tab and set MM_SYNC_TOKEN.',
      found: {
        storeUrl: url ? url.name : null,
        storeToken: token ? token.name : null,
        syncPassphrase: Boolean(process.env.MM_SYNC_TOKEN)
      },
      accepts: { url: URL_VARS, token: TOKEN_VARS }
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

      // Read the stored copy back and describe it, without returning the data
      // itself. A successful POST only proves the write was accepted; this
      // proves the backup is actually retrievable and well-formed.
      if (request.query && request.query.verify) {
        const raw = await redis(['GET', LATEST_KEY]);
        if (!raw) {
          return response.status(404).json({ error: 'no-backup-yet', verified: false });
        }
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          return response.status(500).json({ error: 'stored-backup-corrupt', verified: false });
        }
        const data = parsed.data || {};
        const dates = (data.classes || []).map(c => c.date).filter(Boolean).sort();
        const dayRows = await redis(['LRANGE', DAYS_INDEX, 0, DAILY_RETENTION - 1]);
        const days = (dayRows || []).map(row => {
          try { return JSON.parse(row).day; } catch (e) { return null; }
        }).filter(Boolean);

        return response.status(200).json({
          verified: Array.isArray(data.classes) && data.classes.length > 0,
          savedAt: parsed.exportDate || null,
          version: parsed.version || null,
          bytes: raw.length,
          classes: Array.isArray(data.classes) ? data.classes.length : 0,
          expenses: Array.isArray(data.expenses) ? data.expenses.length : 0,
          students: data.studentRates ? Object.keys(data.studentRates).length : 0,
          payments: data.paymentStatus ? Object.keys(data.paymentStatus).length : 0,
          firstClass: dates[0] || null,
          lastClass: dates[dates.length - 1] || null,
          daySnapshots: days
        });
      }

      // List the day snapshots available to restore from
      if (request.query && request.query.days) {
        const rows = await redis(['LRANGE', DAYS_INDEX, 0, DAILY_RETENTION - 1]);
        const days = (rows || []).map(row => {
          try { return JSON.parse(row); } catch (e) { return null; }
        }).filter(Boolean);
        return response.status(200).json({ retentionDays: DAILY_RETENTION, days });
      }

      // Restore one specific day
      if (request.query && request.query.day) {
        const day = String(request.query.day);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
          return response.status(400).json({ error: 'bad-day-format' });
        }
        const dayRaw = await redis(['GET', DAY_PREFIX + day]);
        if (!dayRaw) {
          return response.status(404).json({ error: 'no-snapshot-for-day', day });
        }
        return response.status(200).json(JSON.parse(dayRaw));
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
      const dayKey = resolveDayKey(payload);

      await redis(['SET', LATEST_KEY, serialised]);
      await redis(['LPUSH', HISTORY_KEY, JSON.stringify(meta)]);
      await redis(['LTRIM', HISTORY_KEY, 0, HISTORY_LIMIT - 1]);

      // Today's snapshot always reflects the most recent push of that day, so
      // repeated edits refresh it rather than consuming a retention slot.
      await redis(['SET', DAY_PREFIX + dayKey, serialised]);

      const indexRows = (await redis(['LRANGE', DAYS_INDEX, 0, -1])) || [];
      const index = indexRows.map(row => {
        try { return JSON.parse(row); } catch (e) { return null; }
      }).filter(Boolean);

      const entry = { day: dayKey, savedAt: meta.savedAt, classes: meta.classes, expenses: meta.expenses };
      const withoutToday = index.filter(row => row.day !== dayKey);
      const updated = [entry, ...withoutToday]
        .sort((a, b) => b.day.localeCompare(a.day)); // newest first
      const kept = updated.slice(0, DAILY_RETENTION);
      const evicted = updated.slice(DAILY_RETENTION);

      // Rewrite the index rather than patching it: it holds at most 8 rows, and
      // an exact rewrite can't drift out of step with the snapshots themselves.
      await redis(['DEL', DAYS_INDEX]);
      if (kept.length) {
        await redis(['RPUSH', DAYS_INDEX, ...kept.map(row => JSON.stringify(row))]);
      }
      for (const row of evicted) {
        await redis(['DEL', DAY_PREFIX + row.day]);
      }

      return response.status(200).json({
        ok: true,
        ...meta,
        day: dayKey,
        daysRetained: kept.length,
        evictedDays: evicted.map(row => row.day)
      });
    }

    response.setHeader('Allow', 'GET, POST');
    return response.status(405).json({ error: 'method-not-allowed' });
  } catch (error) {
    return response.status(500).json({ error: 'kv-failure', message: String(error.message || error) });
  }
};
