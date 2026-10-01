// A tiny local stand-in for the parts of Supabase Filler uses, for e2e tests
// without Docker or a cloud project:
//   Auth (GoTrue):  POST /auth/v1/otp, POST /auth/v1/verify, GET /auth/v1/user,
//                   POST /auth/v1/token?grant_type=refresh_token, POST /auth/v1/logout
//   REST (PostgREST): /rest/v1/vault_blobs  GET (select), POST (insert), PATCH (update with version=eq.N)
//                   /rest/v1/ai_usage     GET (the caller's own rows, like RLS)
//   Functions:      /functions/v1/health, ai-classify, ai-generate — the REAL handlers from
//                   supabase/functions (Node runs them with type stripping), with in-memory
//                   quota and cache, and the scripted model (supabase/tests/fake-llm.ts)
//                   behind the real Gemini adapter.
//   Test helpers:   GET /__mock/code?email=…  (the last emailed code, like Inbucket)
//                   GET /__mock/db            (everything stored, to prove it is ciphertext)
//                   GET /__mock/ai            (prompts the "model" received, provider call count)
//                   POST /__mock/ai           { mode: 'up'|'down'|'unconfigured', limitCalls }
//                   POST /__mock/reset
// It enforces the same rules as the real RLS policies: a user only reads and
// writes their own row, and versions must increase by exactly one.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createGateway } from '../supabase/functions/_shared/ai/gateway.ts';
import { handleClassify } from '../supabase/functions/ai-classify/handler.ts';
import { handleGenerate } from '../supabase/functions/ai-generate/handler.ts';
import { handleHealth } from '../supabase/functions/health/handler.ts';
import { fakeProviderFetch } from '../supabase/tests/fake-llm.ts';

const port = Number(process.env.MOCK_SUPABASE_PORT ?? 54321);
const ANON_KEY = process.env.MOCK_SUPABASE_ANON_KEY ?? 'test-anon-key';

let users = new Map(); // email → { id, email }
let codes = new Map(); // email → code
let tokens = new Map(); // access or refresh token → userId
let vault = new Map(); // userId → row

// ---- AI state
const freshAi = () => ({
  mode: 'up',
  limitCalls: 200,
  prompts: [],
  usage: new Map(),
  cache: new Map(),
});
let ai = freshAi();
const today = () => new Date().toISOString().slice(0, 10);

function aiEnv() {
  const vars = {
    AI_PROVIDER: 'gemini',
    GEMINI_API_KEY: ai.mode === 'unconfigured' ? '' : 'mock-gemini-key',
    AI_MODEL_FAST: 'mock-flash',
    AI_MODEL_SMART: 'mock-pro',
    LIMIT_AI_CLASSIFY_CALLS: String(ai.limitCalls),
    LIMIT_AI_GENERATE_CALLS: String(ai.limitCalls),
    AI_RETRIES: '1',
  };
  return { get: (name) => vars[name] };
}

function aiDeps() {
  const env = aiEnv();
  const provider = fakeProviderFetch(ai.mode === 'down' ? { status: 503 } : {});
  const recordingFetch = async (url, init) => {
    const response = await provider.fetch(url, init);
    for (const call of provider.calls.splice(0)) ai.prompts.push(call.prompt);
    return response;
  };
  const row = (userId, endpoint) => {
    const key = `${userId}|${today()}|${endpoint}`;
    if (!ai.usage.has(key))
      ai.usage.set(key, { user_id: userId, day: today(), endpoint, calls: 0, tokens: 0 });
    return ai.usage.get(key);
  };
  return {
    env,
    verifyToken: async (jwt) => {
      const id = tokens.get(jwt);
      return id ? { id } : null;
    },
    gateway: createGateway({ env, fetch: recordingFetch, sleep: async () => undefined }),
    consumeQuota: async ({ userId, endpoint, limits }) => {
      const r = row(userId, endpoint);
      if (r.calls >= limits.maxCalls || (limits.maxTokens > 0 && r.tokens >= limits.maxTokens))
        return 'user_limit';
      r.calls += 1;
      return 'ok';
    },
    recordTokens: async ({ userId, endpoint, tokens: n }) => {
      row(userId, endpoint).tokens += n;
    },
    cache: {
      get: async (hash) => ai.cache.get(hash) ?? null,
      set: async (hash, _endpoint, value) => void ai.cache.set(hash, value),
    },
  };
}

/** Runs a real Edge Function handler for a Node request. */
async function runFunction(req, res, handler) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
    method: req.method,
    headers: Object.entries(req.headers).filter(([, v]) => typeof v === 'string'),
    ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }),
  });
  const response = await handler(request, aiDeps());
  const headers = Object.fromEntries(response.headers.entries());
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

const json = (res, status, body) => {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });

function session(user) {
  const access = `access-${randomUUID()}`;
  const refresh = `refresh-${randomUUID()}`;
  tokens.set(access, user.id);
  tokens.set(refresh, user.id);
  return {
    access_token: access,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: refresh,
    user: {
      id: user.id,
      aud: 'authenticated',
      role: 'authenticated',
      email: user.email,
      app_metadata: {},
      user_metadata: {},
      created_at: new Date().toISOString(),
    },
  };
}

function userFrom(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
  const id = m ? tokens.get(m[1]) : undefined;
  return id ? [...users.values()].find((u) => u.id === id) : undefined;
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  // Edge Functions: preflight and CORS are the handlers' own (they only answer the extension).
  if (url.pathname === '/functions/v1/health') return runFunction(req, res, handleHealth);
  if (url.pathname === '/functions/v1/ai-classify') return runFunction(req, res, handleClassify);
  if (url.pathname === '/functions/v1/ai-generate') return runFunction(req, res, handleGenerate);

  if (req.method === 'OPTIONS') return json(res, 204);

  // ---- test helpers
  if (url.pathname === '/__mock/code')
    return json(res, 200, {
      code: codes.get((url.searchParams.get('email') ?? '').toLowerCase()) ?? null,
    });
  if (url.pathname === '/__mock/db')
    return json(res, 200, { vault_blobs: [...vault.values()], users: users.size });
  if (url.pathname === '/__mock/ai') {
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (body.mode) ai.mode = body.mode;
      if (body.limitCalls) ai.limitCalls = body.limitCalls;
      if (body.clearCache) ai.cache = new Map();
    }
    return json(res, 200, {
      mode: ai.mode,
      providerCalls: ai.prompts.length,
      prompts: ai.prompts,
      usage: [...ai.usage.values()],
    });
  }
  if (url.pathname === '/__mock/reset') {
    ai = freshAi();
    users = new Map();
    codes = new Map();
    tokens = new Map();
    vault = new Map();
    return json(res, 200, { ok: true });
  }

  if (req.headers.apikey !== ANON_KEY) return json(res, 401, { message: 'Invalid API key' });

  // ---- auth
  if (url.pathname === '/auth/v1/otp' && req.method === 'POST') {
    const { email } = await readBody(req);
    const normalized = String(email ?? '').toLowerCase();
    if (!normalized.includes('@'))
      return json(res, 400, { error_code: 'validation_failed', msg: 'Invalid email' });
    if (!users.has(normalized)) users.set(normalized, { id: randomUUID(), email: normalized });
    codes.set(normalized, String(Math.floor(100000 + Math.random() * 900000)));
    return json(res, 200, {});
  }
  if (url.pathname === '/auth/v1/verify' && req.method === 'POST') {
    const { email, token } = await readBody(req);
    const normalized = String(email ?? '').toLowerCase();
    if (!codes.has(normalized) || codes.get(normalized) !== token) {
      return json(res, 403, { error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
    }
    codes.delete(normalized);
    return json(res, 200, session(users.get(normalized)));
  }
  if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
    const { refresh_token } = await readBody(req);
    const id = tokens.get(refresh_token);
    const user = id && [...users.values()].find((u) => u.id === id);
    return user
      ? json(res, 200, session(user))
      : json(res, 400, { error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
  }
  if (url.pathname === '/auth/v1/user' && req.method === 'GET') {
    const user = userFrom(req);
    return user
      ? json(res, 200, session(user).user)
      : json(res, 401, { error_code: 'bad_jwt', msg: 'invalid JWT' });
  }
  if (url.pathname === '/auth/v1/logout') return json(res, 204);

  // ---- rest: vault_blobs, with RLS-equivalent rules
  if (url.pathname === '/rest/v1/vault_blobs') {
    const user = userFrom(req);
    if (!user)
      return json(res, 401, { code: '42501', message: 'permission denied for table vault_blobs' });
    const own = vault.get(user.id);
    if (req.method === 'GET') return json(res, 200, own ? [own] : []);
    if (req.method === 'POST') {
      if (own)
        return json(res, 409, {
          code: '23505',
          message: 'duplicate key value violates unique constraint "vault_blobs_pkey"',
        });
      const body = await readBody(req);
      const row = { ...body, user_id: user.id, updated_at: new Date().toISOString() };
      vault.set(user.id, row);
      return json(res, 201, [row]);
    }
    if (req.method === 'PATCH') {
      const expected = /^eq\.(\d+)$/.exec(url.searchParams.get('version') ?? '');
      if (!own || !expected || own.version !== Number(expected[1])) return json(res, 200, []);
      const body = await readBody(req);
      if (body.version !== own.version + 1) {
        return json(res, 400, {
          code: '40001',
          message: 'vault version must increase by exactly one',
        });
      }
      const row = { ...own, ...body, user_id: user.id, updated_at: new Date().toISOString() };
      vault.set(user.id, row);
      return json(res, 200, [row]);
    }
  }
  // ---- rest: ai_usage (read own rows only)
  if (url.pathname === '/rest/v1/ai_usage' && req.method === 'GET') {
    const user = userFrom(req);
    if (!user) return json(res, 200, []);
    const day = /^eq\.(.+)$/.exec(url.searchParams.get('day') ?? '')?.[1];
    return json(
      res,
      200,
      [...ai.usage.values()]
        .filter((r) => r.user_id === user.id && (!day || r.day === day))
        .map(({ endpoint, calls, tokens: t }) => ({ endpoint, calls, tokens: t })),
    );
  }
  return json(res, 404, { message: `Not found: ${req.method} ${url.pathname}` });
}).listen(port, '127.0.0.1', () => console.log(`Mock Supabase at http://127.0.0.1:${port}`));
