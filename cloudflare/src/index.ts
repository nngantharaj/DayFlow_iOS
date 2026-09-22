/**
 * DayFlow Workers API — persists full JSON app state into D1.
 * Routes:
 *   POST /api/v1/stores           → creates store, returns { id }
 *   GET  /api/v1/stores/:id       → { payload, updated_at }
 *   PUT  /api/v1/stores/:id       ← body JSON = full DayFlow state object
 *                                   X-Expected-Updated-At: CAS token from last GET/PUT
 *                                   X-Force-Write: 1 skips CAS (empty-store seed)
 */

export interface Env {
  DAYFLOW_DB: D1Database;
}

const MAX_BYTES = 2_000_000;

const cors = (req?: Request, extra: Record<string, string> = {}) => {
  const origin = (req && req.headers.get('Origin')) || '*';
  const reqHeaders =
    (req && req.headers.get('Access-Control-Request-Headers')) ||
    'Content-Type, Authorization, X-Expected-Updated-At, X-Force-Write, X-Requested-With';
  return {
    'Access-Control-Allow-Origin': !origin || origin === 'null' ? '*' : origin,
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': reqHeaders,
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
    ...extra,
  };
};

function json(data: unknown, status = 200, req?: Request): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(req) },
  });
}

function parsePayload(raw: string | null | undefined): unknown {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

function nowTs(): number {
  return Date.now();
}

function d1Changes(result: { meta?: { changes?: number; rows_written?: number } }): number {
  const meta = result.meta || {};
  return Number(meta.changes ?? meta.rows_written ?? 0);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(request) });
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/$/, '');
      const m = /^\/api\/v1\/stores(?:\/([^/]+))?$/.exec(path);

      if (!m) {
        return json({ error: 'not_found' }, 404, request);
      }

      const storeId = m[1];

      if (request.method === 'POST' && path === '/api/v1/stores') {
        const id = crypto.randomUUID();
        const empty = '{}';
        const ts = nowTs();
        await env.DAYFLOW_DB.prepare(
          'INSERT INTO stores (id, payload, updated_at) VALUES (?, ?, ?)'
        )
          .bind(id, empty, ts)
          .run();
        return json({ id }, 200, request);
      }

      if (!storeId) {
        return json({ error: 'bad_request' }, 400, request);
      }

      if (request.method === 'GET') {
        const row = await env.DAYFLOW_DB.prepare(
          'SELECT payload, updated_at FROM stores WHERE id = ?'
        )
          .bind(storeId)
          .first<{ payload: string; updated_at: number }>();

        if (!row) {
          return json({ error: 'not_found' }, 404, request);
        }
        return json({ payload: parsePayload(row.payload), updated_at: row.updated_at }, 200, request);
      }

      if (request.method === 'PUT') {
        const ct = request.headers.get('Content-Type') || '';
        if (!ct.includes('application/json')) {
          return json({ error: 'expected_json' }, 415, request);
        }
        const raw = await request.text();
        if (!raw.length) {
          return json({ error: 'empty_body' }, 400, request);
        }
        const enc = new TextEncoder();
        if (enc.encode(raw).length > MAX_BYTES) {
          return json({ error: 'payload_too_large' }, 413, request);
        }
        try {
          JSON.parse(raw);
        } catch {
          return json({ error: 'invalid_json' }, 400, request);
        }

        const force = (request.headers.get('X-Force-Write') || '') === '1';
        const expectedRaw = request.headers.get('X-Expected-Updated-At');
        const ts = nowTs();

        const upsert = () =>
          env.DAYFLOW_DB.prepare(
            `INSERT INTO stores (id, payload, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               payload = excluded.payload,
               updated_at = excluded.updated_at`
          )
            .bind(storeId, raw, ts)
            .run();

        if (!force && expectedRaw !== null && expectedRaw !== '') {
          const expected = Number(expectedRaw);
          if (!Number.isFinite(expected)) {
            return json({ error: 'bad_request' }, 400, request);
          }
          const cas = await env.DAYFLOW_DB.prepare(
            'UPDATE stores SET payload = ?, updated_at = ? WHERE id = ? AND updated_at = ?'
          )
            .bind(raw, ts, storeId, expected)
            .run();
          if (d1Changes(cas) > 0) {
            return json({ ok: true, updated_at: ts }, 200, request);
          }
          const existing = await env.DAYFLOW_DB.prepare(
            'SELECT payload, updated_at FROM stores WHERE id = ?'
          )
            .bind(storeId)
            .first<{ payload: string; updated_at: number }>();
          if (!existing) {
            await upsert();
            return json({ ok: true, updated_at: ts }, 200, request);
          }
          return json(
            { error: 'conflict', updated_at: existing.updated_at, payload: parsePayload(existing.payload) },
            409,
            request
          );
        }

        await upsert();
        return json({ ok: true, updated_at: ts }, 200, request);
      }

      return json({ error: 'method_not_allowed' }, 405, request);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return json({ error: 'server_error', message: msg }, 500, request);
    }
  },
};
