-- ====== JavelinMC: статистика игроков для админки ======
-- Куда: https://supabase.com/dashboard/project/zdticfhywbyfzxfmypff/sql/new
-- Ctrl+A -> вставить всё -> Run. Ожидается: Success. No rows returned. Один раз.

-- 1) пик онлайна пишем прямо в config (обновляется на каждом heartbeat)
insert into public.config (key, value) values ('peak_online','0')
on conflict (key) do nothing;

-- heartbeat теперь ещё и запоминает пик онлайна за всё время
create or replace function public.heartbeat(p_id text, p_nick text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  if p_id is null or length(p_id) < 8 or length(p_id) > 64 then
    return 0;
  end if;
  insert into public.presence (client_id, nick, last_seen)
  values (p_id, nullif(left(coalesce(p_nick,''),32),''), now())
  on conflict (client_id) do update
    set last_seen = now(),
        nick = coalesce(excluded.nick, presence.nick);
  delete from public.presence where last_seen < now() - interval '1 hour';
  select count(*) into n from public.presence where last_seen > now() - interval '90 seconds';
  -- запомнить пик, если побит
  update public.config set value = n::text
   where key = 'peak_online' and coalesce(value,'0')::int < n;
  return n;
end $$;

-- 2) сводная статистика + рост регистраций по дням (за 90 дней)
create or replace function public.admin_stats(p_token text, p_pass text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare ok boolean; daily json;
begin
  select public.check_admin(p_token, p_pass) into ok;
  if not ok then return json_build_object('ok', false, 'error', 'нет доступа'); end if;

  select coalesce(json_agg(x order by x.d), '[]'::json) into daily from (
    select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as d, count(*) as c
    from public.users
    where created_at > now() - interval '90 days'
    group by 1
  ) x;

  return json_build_object(
    'ok', true,
    'total',   (select count(*) from public.users),
    'blocked', (select count(*) from public.users where blocked),
    'linked',  (select count(*) from public.users where ely_uuid is not null),
    'new7',    (select count(*) from public.users where created_at > now() - interval '7 days'),
    'new30',   (select count(*) from public.users where created_at > now() - interval '30 days'),
    'online',  (select count(*) from public.presence where last_seen > now() - interval '90 seconds'),
    'peak',    coalesce((select value from public.config where key = 'peak_online'), '0'),
    'daily',   daily
  );
end $$;

-- 3) написать игроку: сообщение появится у него в лаунчере (раздел «Связь»)
create or replace function public.admin_message_user(p_token text, p_pass text, p_nick text, p_text text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare ok boolean;
begin
  select public.check_admin(p_token, p_pass) into ok;
  if not ok then return json_build_object('ok', false, 'error', 'нет доступа'); end if;
  if coalesce(trim(p_text),'') = '' then return json_build_object('ok', false, 'error', 'пустое сообщение'); end if;

  insert into public.messages (nick, category, body, reply, reply_at, read)
  values (lower(trim(p_nick)), 'Сообщение от администрации', '(написал администратор)', p_text, now(), false);
  return json_build_object('ok', true);
end $$;

grant execute on function public.heartbeat(text, text)                to anon;
grant execute on function public.admin_stats(text, text)              to anon;
grant execute on function public.admin_message_user(text, text, text, text) to anon;
