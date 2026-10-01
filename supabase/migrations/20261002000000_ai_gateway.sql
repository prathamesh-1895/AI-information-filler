-- Phase 8: AI gateway usage limits.
--  * A global daily counter across all users (protects the shared free-tier key).
--  * consume_ai_call(): checks the user's and the global limit BEFORE counting,
--    so a refused call is not counted, and says which limit was hit.
--  * record_ai_tokens(): adds the real token usage after the provider replies.
-- Both are security definer, execute granted to service_role only (Edge Functions).

create table public.ai_usage_global (
  day date primary key default current_date,
  calls integer not null default 0 check (calls >= 0),
  tokens integer not null default 0 check (tokens >= 0)
);

alter table public.ai_usage_global enable row level security;
revoke all on public.ai_usage_global from anon, authenticated;

-- Returns 'ok', 'user_limit' or 'global_limit'. A token limit of 0 means "no token limit".
create function public.consume_ai_call(
  p_user uuid,
  p_endpoint text,
  p_max_calls integer,
  p_max_tokens integer,
  p_global_max_calls integer,
  p_global_max_tokens integer
) returns text
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  used_calls integer;
  used_tokens integer;
  all_calls integer;
  all_tokens integer;
begin
  insert into public.ai_usage (user_id, day, endpoint)
  values (p_user, current_date, p_endpoint)
  on conflict (user_id, day, endpoint) do nothing;
  select calls, tokens into used_calls, used_tokens
    from public.ai_usage
    where user_id = p_user and day = current_date and endpoint = p_endpoint
    for update;
  if used_calls >= p_max_calls or (p_max_tokens > 0 and used_tokens >= p_max_tokens) then
    return 'user_limit';
  end if;

  insert into public.ai_usage_global (day) values (current_date)
  on conflict (day) do nothing;
  select calls, tokens into all_calls, all_tokens
    from public.ai_usage_global
    where day = current_date
    for update;
  if (p_global_max_calls > 0 and all_calls >= p_global_max_calls)
     or (p_global_max_tokens > 0 and all_tokens >= p_global_max_tokens) then
    return 'global_limit';
  end if;

  update public.ai_usage set calls = calls + 1
    where user_id = p_user and day = current_date and endpoint = p_endpoint;
  update public.ai_usage_global set calls = calls + 1 where day = current_date;
  return 'ok';
end;
$$;

create function public.record_ai_tokens(
  p_user uuid,
  p_endpoint text,
  p_tokens integer
) returns void
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  if p_tokens <= 0 then
    return;
  end if;
  insert into public.ai_usage as u (user_id, day, endpoint, tokens)
  values (p_user, current_date, p_endpoint, p_tokens)
  on conflict (user_id, day, endpoint) do update set tokens = u.tokens + p_tokens;
  insert into public.ai_usage_global as g (day, tokens)
  values (current_date, p_tokens)
  on conflict (day) do update set tokens = g.tokens + p_tokens;
end;
$$;

revoke execute on function public.consume_ai_call(uuid, text, integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_ai_call(uuid, text, integer, integer, integer, integer) to service_role;
revoke execute on function public.record_ai_tokens(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.record_ai_tokens(uuid, text, integer) to service_role;
