-- Filler: initial schema (PLAYBOOK Task 7.1).
--
-- Principles:
--   * Row level security on every table; a user only ever sees their own rows.
--   * No plaintext personal data: the vault is stored as one end-to-end
--     encrypted blob (encrypted on the device with the vault key).
--   * Usage counters and the AI cache are written by Edge Functions
--     (service role) only; users can read their own usage, nothing else.
--   * `(select auth.uid())` instead of `auth.uid()` so the planner evaluates it once per query.

-- ---------------------------------------------------------------- profiles

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  display_name text check (display_name is null or char_length(display_name) <= 100),
  plan text not null default 'free' check (plan in ('free'))
);

alter table public.profiles enable row level security;

create policy "profiles: read own" on public.profiles
  for select to authenticated using (id = (select auth.uid()));

create policy "profiles: update own" on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Users may change their display name, never their plan.
revoke update on public.profiles from anon, authenticated;
grant update (display_name) on public.profiles to authenticated;
revoke insert, delete on public.profiles from anon, authenticated;

-- A profile row appears when an account is created.
create function public.handle_new_user() returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------- vault_blobs

-- One end-to-end encrypted vault snapshot per user. The server never sees
-- the passphrase, the key or any value: `ciphertext` is AES-256-GCM output
-- of the whole snapshot; `kdf` and `verifier` let a new device derive and
-- check the key from the user's passphrase.
create table public.vault_blobs (
  user_id uuid primary key references auth.users (id) on delete cascade default auth.uid(),
  version integer not null check (version >= 1),
  device_id text not null check (char_length(device_id) between 1 and 64),
  kdf jsonb not null check (jsonb_typeof(kdf) = 'object'),
  verifier jsonb not null check (jsonb_typeof(verifier) = 'object'),
  iv text not null check (char_length(iv) between 8 and 64),
  ciphertext text not null check (char_length(ciphertext) <= 30000000),
  updated_at timestamptz not null default now()
);

alter table public.vault_blobs enable row level security;

create policy "vault: read own" on public.vault_blobs
  for select to authenticated using (user_id = (select auth.uid()));
create policy "vault: insert own" on public.vault_blobs
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "vault: update own" on public.vault_blobs
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "vault: delete own" on public.vault_blobs
  for delete to authenticated using (user_id = (select auth.uid()));

-- Optimistic concurrency: every write bumps the version; clients update with
-- `version = <expected>` so a stale device cannot overwrite a newer snapshot.
create function public.vault_blobs_touch() returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' and new.version <> old.version + 1 then
    raise exception 'vault version must increase by exactly one (expected %, got %)', old.version + 1, new.version
      using errcode = '40001';
  end if;
  return new;
end;
$$;

create trigger vault_blobs_touch
  before insert or update on public.vault_blobs
  for each row execute function public.vault_blobs_touch();

-- ---------------------------------------------------------------- ai_usage

create table public.ai_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null default current_date,
  endpoint text not null check (endpoint in ('ai-classify', 'ai-generate', 'ai-vision', 'ai-extract', 'health')),
  calls integer not null default 0 check (calls >= 0),
  tokens integer not null default 0 check (tokens >= 0),
  primary key (user_id, day, endpoint)
);

alter table public.ai_usage enable row level security;

create policy "usage: read own" on public.ai_usage
  for select to authenticated using (user_id = (select auth.uid()));
-- No insert/update/delete policies: only the service role (Edge Functions) writes usage.
revoke insert, update, delete on public.ai_usage from anon, authenticated;

-- Atomically counts one call and reports whether it is within the daily limit.
create function public.consume_ai_quota(
  p_user uuid,
  p_endpoint text,
  p_tokens integer,
  p_max_calls integer,
  p_max_tokens integer
) returns boolean
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  used_calls integer;
  used_tokens integer;
begin
  insert into public.ai_usage as u (user_id, day, endpoint, calls, tokens)
  values (p_user, current_date, p_endpoint, 1, greatest(p_tokens, 0))
  on conflict (user_id, day, endpoint)
  do update set calls = u.calls + 1, tokens = u.tokens + greatest(p_tokens, 0)
  returning calls, tokens into used_calls, used_tokens;
  return used_calls <= p_max_calls and used_tokens <= p_max_tokens;
end;
$$;

revoke execute on function public.consume_ai_quota(uuid, text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_ai_quota(uuid, text, integer, integer, integer) to service_role;

-- ---------------------------------------------------------------- ai_cache

-- Cached AI answers for requests that contain no personal data (classification
-- of field descriptors). Service role only: RLS on, no policies, no grants.
create table public.ai_cache (
  hash text primary key check (hash ~ '^[0-9a-f]{64}$'),
  endpoint text not null,
  response jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.ai_cache enable row level security;
revoke all on public.ai_cache from anon, authenticated;

-- ---------------------------------------------------------------- feedback

-- Thumbs up/down on AI drafts. Payloads are about the draft quality only:
-- the client never puts vault values here.
create table public.feedback (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  kind text not null check (kind in ('draft_up', 'draft_down', 'mapping_wrong', 'other')),
  payload jsonb not null default '{}'::jsonb check (pg_column_size(payload) <= 4096),
  created_at timestamptz not null default now()
);

alter table public.feedback enable row level security;

create policy "feedback: insert own" on public.feedback
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "feedback: read own" on public.feedback
  for select to authenticated using (user_id = (select auth.uid()));
revoke update, delete on public.feedback from anon, authenticated;

-- Anonymous visitors get nothing anywhere.
revoke all on public.profiles, public.vault_blobs, public.ai_usage, public.ai_cache, public.feedback from anon;
