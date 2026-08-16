-- ================================================================
--  JavelinMC: пик онлайна ЗА СЕГОДНЯ в статистике админки
--  Куда вставить: https://supabase.com/dashboard/project/zdticfhywbyfzxfmypff/sql/new
--  Ctrl+A -> вставить всё -> Run. Ожидается: Success. No rows returned.
--
--  Зачем: сейчас в базе хранится только пик за ВСЁ время (ключ peak_online).
--  Пик именно за сегодня посчитать задним числом нельзя — его нужно копить.
--  Поэтому здесь heartbeat начинает вести ещё два значения: пик за текущие сутки
--  и дату этих суток. При смене даты счётчик сам обнуляется.
-- ================================================================


-- ---------- 1) две новые строки в настройках ----------
insert into public.config (key, value) values ('peak_today','0')      on conflict (key) do nothing;
insert into public.config (key, value) values ('peak_today_date','')  on conflict (key) do nothing;


-- ---------- 2) heartbeat теперь копит и дневной пик ----------
-- Всё прежнее сохранено слово в слово: срок хранения 60 дней, счётчик онлайна,
-- пик за всё время. Добавлены только строки про peak_today.
create or replace function public.heartbeat(p_id text, p_nick text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
  today text := to_char(now() at time zone 'UTC', 'YYYY-MM-DD');
  saved text;
begin
  if p_id is null or length(p_id) < 8 or length(p_id) > 64 then
    return 0;
  end if;

  insert into public.presence (client_id, nick, last_seen)
  values (p_id, nullif(left(coalesce(p_nick,''),32),''), now())
  on conflict (client_id) do update
    set last_seen = now(),
        nick = coalesce(excluded.nick, presence.nick);

  delete from public.presence where last_seen < now() - interval '60 days';

  select count(*) into n from public.presence where last_seen > now() - interval '90 seconds';

  -- пик за всё время
  update public.config set value = n::text
   where key = 'peak_online' and coalesce(value,'0')::int < n;

  -- пик за сегодня: если сутки сменились — начинаем счёт заново
  select value into saved from public.config where key = 'peak_today_date';
  if saved is distinct from today then
    update public.config set value = today where key = 'peak_today_date';
    update public.config set value = n::text  where key = 'peak_today';
  else
    update public.config set value = n::text
     where key = 'peak_today' and coalesce(value,'0')::int < n;
  end if;

  return n;
end $$;


-- ---------- 3) отдаём новое значение в статистику админки ----------
-- Обёртка вокруг твоей admin_stats: берёт её ответ и добавляет туда peak_today.
-- Саму admin_stats не трогаем — она как была, так и остаётся.
create or replace function public.admin_stats_v2(p_token text, p_pass text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare base json; pt text;
begin
  if not exists (select 1 from public.admin_auth where token = p_token and pass = p_pass) then
    return json_build_object('ok', false, 'error', 'нет доступа');
  end if;

  select public.admin_stats(p_token, p_pass) into base;
  select value into pt from public.config where key = 'peak_today';

  return (base::jsonb || jsonb_build_object('peak_today', coalesce(pt,'0')::int))::json;
end $$;


-- ---------- 4) права ----------
grant execute on function public.heartbeat(text, text)        to anon;
grant execute on function public.admin_stats_v2(text, text)   to anon;


-- ---------- проверка (не обязательно) ----------
-- select key, value from public.config where key like 'peak%';
