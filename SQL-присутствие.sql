-- ================================================================
--  JavelinMC: «в сети» и «был N назад» в админке
--  Куда вставить: https://supabase.com/dashboard/project/zdticfhywbyfzxfmypff/sql/new
--  Ctrl+A -> вставить всё -> Run. Ожидается: Success. No rows returned.
--  Выполнить один раз. Повторный запуск ничего не испортит.
-- ================================================================


-- ---------- 1) таблица отметок (страховка, если её вдруг нет) ----------
create table if not exists public.presence (
  client_id text primary key,
  nick      text,
  last_seen timestamptz not null default now()
);

create index if not exists presence_last_seen_idx on public.presence (last_seen desc);
create index if not exists presence_nick_idx      on public.presence (lower(nick));


-- ---------- 2) храним отметки дольше ----------
-- Раньше heartbeat удалял всё старше ЧАСА. Из-за этого админка не могла показать
-- «был 2 дня назад» — сведения просто пропадали, и у всех висело «не заходил».
-- Теперь держим 60 дней. Таблица маленькая: одна строка на одну копию лаунчера.
-- Внутри функции изменена ровно одна строка (срок хранения). Счётчик онлайна и
-- запись пика работают точно так же, как раньше.
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

  delete from public.presence where last_seen < now() - interval '60 days';

  select count(*) into n from public.presence where last_seen > now() - interval '90 seconds';

  update public.config set value = n::text
   where key = 'peak_online' and coalesce(value,'0')::int < n;

  return n;
end $$;


-- ---------- 3) сведения для админки ----------
-- Отдаёт { ok: true, users: [ { nick, last_seen, online }, ... ] }.
-- Ровно это и читает вкладка «Пользователи»: зелёное «в сети», серое «был 5 мин назад»
-- или «не заходил», если отметок нет вообще.
-- Один игрок может держать лаунчер на двух компьютерах — берём самую свежую отметку.
create or replace function public.admin_presence(p_token text, p_pass text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare res json;
begin
  -- доступ только по паре токен+пароль из admin_auth
  if not exists (select 1 from public.admin_auth where token = p_token and pass = p_pass) then
    return json_build_object('ok', false, 'error', 'нет доступа');
  end if;

  select coalesce(json_agg(t order by t.last_seen desc), '[]'::json)
    into res
    from (
      select (array_agg(nick order by last_seen desc))[1]          as nick,
             max(last_seen)                                        as last_seen,
             (max(last_seen) > now() - interval '90 seconds')       as online
        from public.presence
       where nick is not null and btrim(nick) <> ''
       group by lower(nick)
    ) t;

  return json_build_object('ok', true, 'users', res);
end $$;


-- ---------- 4) права ----------
-- Лаунчер обращается к базе публичным ключом (anon), поэтому право на вызов нужно ему.
-- Сами таблицы при этом остаются закрытыми: функции объявлены security definer,
-- а admin_presence отдаёт что-либо только после проверки токена и пароля.
grant execute on function public.heartbeat(text, text)       to anon;
grant execute on function public.admin_presence(text, text)  to anon;


-- ---------- проверка (не обязательно) ----------
-- Раскомментируй и подставь свой токен с паролем, чтобы посмотреть ответ:
-- select public.admin_presence('ТОКЕН', 'ПАРОЛЬ');
