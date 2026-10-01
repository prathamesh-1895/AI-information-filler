import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { as, createUser, freshDb } from './db';

/** PLAYBOOK Task 7.1 DONE: user A cannot read or change user B's rows, and nobody sees plaintext. */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const blob = (version: number, device = 'device-a') => [
  version,
  device,
  JSON.stringify({ salt: 'c2FsdA==', iterations: 600000 }),
  JSON.stringify({ iv: 'aXZpdml2aXZpdg==', ciphertext: 'Y2lwaGVy' }),
  'aXZpdml2aXZpdg==',
  'b3BhcXVlLWNpcGhlcnRleHQ=',
];
const INSERT =
  'insert into public.vault_blobs (version, device_id, kdf, verifier, iv, ciphertext) values ($1, $2, $3, $4, $5, $6)';

let db: PGlite;
beforeEach(async () => {
  db = await freshDb();
  await createUser(db, A, 'a@example.com');
  await createUser(db, B, 'b@example.com');
});

const rows = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
const fails = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
};

describe('profiles', () => {
  it('are created by the sign-up trigger and readable only by their owner', async () => {
    expect(await rows('select id, plan from public.profiles order by id')).toEqual([
      { id: A, plan: 'free' },
      { id: B, plan: 'free' },
    ]);
    expect(await as(db, 'authenticated', A, () => rows('select id from public.profiles'))).toEqual([
      { id: A },
    ]);
    expect(
      await as(db, 'anon', null, () => fails(() => rows('select id from public.profiles'))),
    ).toBe(true);
  });

  it('let users rename themselves but never change their plan or other profiles', async () => {
    await as(db, 'authenticated', A, () =>
      rows(`update public.profiles set display_name = 'Priya' where id = $1`, [A]),
    );
    expect(await rows('select display_name from public.profiles where id = $1', [A])).toEqual([
      { display_name: 'Priya' },
    ]);
    expect(
      await as(db, 'authenticated', A, () =>
        fails(() => rows(`update public.profiles set plan = 'free' where id = $1`, [A])),
      ),
    ).toBe(true);
    await as(db, 'authenticated', A, () =>
      rows(`update public.profiles set display_name = 'hacked' where id = $1`, [B]),
    );
    expect(await rows('select display_name from public.profiles where id = $1', [B])).toEqual([
      { display_name: null },
    ]);
  });
});

describe('vault_blobs', () => {
  it('each user reads and writes only their own encrypted snapshot', async () => {
    await as(db, 'authenticated', A, () => rows(INSERT, blob(1)));
    await as(db, 'authenticated', B, () => rows(INSERT, blob(1, 'device-b')));
    expect(
      await as(db, 'authenticated', A, () =>
        rows('select user_id, device_id from public.vault_blobs'),
      ),
    ).toEqual([{ user_id: A, device_id: 'device-a' }]);
    expect(
      await as(db, 'authenticated', B, () => rows('select user_id from public.vault_blobs')),
    ).toEqual([{ user_id: B }]);
  });

  it('cannot insert, update or delete for someone else', async () => {
    await as(db, 'authenticated', B, () => rows(INSERT, blob(1, 'device-b')));
    // Inserting with B's id while signed in as A violates the policy.
    expect(
      await as(db, 'authenticated', A, () =>
        fails(() =>
          rows(
            `insert into public.vault_blobs (user_id, version, device_id, kdf, verifier, iv, ciphertext) values ($7, $1, $2, $3, $4, $5, $6)`,
            [...blob(1), B],
          ),
        ),
      ),
    ).toBe(true);
    await as(db, 'authenticated', A, () =>
      rows(`update public.vault_blobs set ciphertext = 'x', version = 2 where user_id = $1`, [B]),
    );
    await as(db, 'authenticated', A, () =>
      rows('delete from public.vault_blobs where user_id = $1', [B]),
    );
    expect(
      await rows('select version, ciphertext from public.vault_blobs where user_id = $1', [B]),
    ).toEqual([{ version: 1, ciphertext: 'b3BhcXVlLWNpcGhlcnRleHQ=' }]);
  });

  it('anonymous visitors see nothing', async () => {
    await as(db, 'authenticated', A, () => rows(INSERT, blob(1)));
    expect(
      await as(db, 'anon', null, () => fails(() => rows('select * from public.vault_blobs'))),
    ).toBe(true);
  });

  it('versions must go up by exactly one (no stale overwrites)', async () => {
    await as(db, 'authenticated', A, () => rows(INSERT, blob(1)));
    const update = (expected: number, next: number) =>
      as(db, 'authenticated', A, () =>
        rows(
          `update public.vault_blobs set version = $2, ciphertext = 'bmV3' where user_id = $3 and version = $1 returning version`,
          [expected, next, A],
        ),
      );
    expect(await update(1, 2)).toEqual([{ version: 2 }]);
    expect(await update(1, 2)).toEqual([]); // a stale device expecting v1 updates nothing
    expect(await fails(() => update(2, 5))).toBe(true);
  });
});

describe('ai_usage and the quota function', () => {
  it('users can read their own usage but cannot write or reset it', async () => {
    await rows(`select public.consume_ai_quota($1, 'ai-classify', 100, 10, 100000)`, [A]);
    expect(
      await as(db, 'authenticated', A, () =>
        rows('select endpoint, calls, tokens from public.ai_usage'),
      ),
    ).toEqual([{ endpoint: 'ai-classify', calls: 1, tokens: 100 }]);
    expect(await as(db, 'authenticated', B, () => rows('select * from public.ai_usage'))).toEqual(
      [],
    );
    expect(
      await as(db, 'authenticated', A, () =>
        fails(() => rows(`update public.ai_usage set calls = 0`)),
      ),
    ).toBe(true);
    expect(
      await as(db, 'authenticated', A, () => fails(() => rows(`delete from public.ai_usage`))),
    ).toBe(true);
  });

  it('only the service role may count usage; the limit is enforced atomically', async () => {
    expect(
      await as(db, 'authenticated', A, () =>
        fails(() => rows(`select public.consume_ai_quota($1, 'ai-classify', 1, 10, 1000)`, [A])),
      ),
    ).toBe(true);
    const results = [];
    for (let i = 0; i < 4; i++) {
      const [r] = await as(db, 'service_role', null, () =>
        rows(`select public.consume_ai_quota($1, 'ai-generate', 10, 3, 100000) as ok`, [A]),
      );
      results.push((r as { ok: boolean }).ok);
    }
    expect(results).toEqual([true, true, true, false]);
  });
});

describe('ai_cache and feedback', () => {
  it('the AI cache is invisible to users and writable only by the service role', async () => {
    const hash = 'a'.repeat(64);
    await as(db, 'service_role', null, () =>
      rows(
        `insert into public.ai_cache (hash, endpoint, response) values ($1, 'ai-classify', '{}')`,
        [hash],
      ),
    );
    expect(
      await as(db, 'authenticated', A, () => fails(() => rows('select * from public.ai_cache'))),
    ).toBe(true);
    expect(
      await as(db, 'authenticated', A, () =>
        fails(() =>
          rows(`insert into public.ai_cache (hash, endpoint, response) values ($1, 'x', '{}')`, [
            'b'.repeat(64),
          ]),
        ),
      ),
    ).toBe(true);
  });

  it('feedback can be added and read by its owner only, and not edited', async () => {
    await as(db, 'authenticated', A, () =>
      rows(
        `insert into public.feedback (kind, payload) values ('draft_up', '{"field":"overview"}')`,
      ),
    );
    expect(
      await as(db, 'authenticated', A, () => rows('select kind from public.feedback')),
    ).toEqual([{ kind: 'draft_up' }]);
    expect(
      await as(db, 'authenticated', B, () => rows('select kind from public.feedback')),
    ).toEqual([]);
    expect(
      await as(db, 'authenticated', A, () =>
        fails(() => rows(`update public.feedback set kind = 'other'`)),
      ),
    ).toBe(true);
    expect(
      await as(db, 'authenticated', A, () =>
        fails(() => rows(`insert into public.feedback (user_id, kind) values ($1, 'other')`, [B])),
      ),
    ).toBe(true);
  });
});

describe('schema hygiene', () => {
  it('has row level security enabled on every public table', async () => {
    const tables = await rows(
      `select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by relname`,
    );
    expect(tables).toEqual(
      ['ai_cache', 'ai_usage', 'feedback', 'profiles', 'vault_blobs'].map((relname) => ({
        relname,
        relrowsecurity: true,
      })),
    );
  });

  it('pins search_path on every function it defines (no search-path hijacking)', async () => {
    const fns = await rows(
      `select proname, proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' order by proname`,
    );
    for (const fn of fns as Array<{ proname: string; proconfig: string[] | null }>) {
      expect(fn.proconfig, fn.proname).toContain('search_path=""');
    }
  });
});

describe('control', () => {
  it('the harness really enforces RLS: switching it off would expose other users', async () => {
    await as(db, 'authenticated', B, () => rows(INSERT, blob(1, 'device-b')));
    await db.exec('alter table public.vault_blobs disable row level security');
    expect(
      await as(db, 'authenticated', A, () => rows('select user_id from public.vault_blobs')),
    ).toEqual([{ user_id: B }]);
  });
});
