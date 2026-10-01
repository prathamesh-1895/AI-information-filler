/**
 * A real Postgres (PGlite, in-process WASM) with the bits of Supabase the
 * migrations rely on: the `auth` schema, `auth.uid()`, and the
 * anon / authenticated / service_role roles with Supabase's default grants.
 * Lets the RLS rules be proven without Docker or a cloud project.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const SUPABASE_STUB = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
-- Supabase grants table privileges to these roles by default; RLS does the real work.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

const migrationsDir = new URL('../migrations/', import.meta.url);

export async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUB);
  for (const file of readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    await db.exec(readFileSync(new URL(file, migrationsDir), 'utf8'));
  }
  return db;
}

export type Role = 'anon' | 'authenticated' | 'service_role';

/** Runs `fn` as a Supabase role (and user), the way PostgREST would. */
export async function as<T>(
  db: PGlite,
  role: Role,
  userId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  await db.exec(`set role ${role}`);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId ?? '']);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
}

export async function createUser(db: PGlite, id: string, email: string): Promise<void> {
  await db.query('insert into auth.users (id, email) values ($1, $2)', [id, email]);
}
