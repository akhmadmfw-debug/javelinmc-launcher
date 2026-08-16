# Живой счётчик онлайна — что выполнить в Supabase

Один раз. Supabase → слева **SQL Editor** (`</>`) → **New query** → вставить всё ниже → **Run**.
Внизу должно написать **Success**.

```sql
-- ===== Кто сейчас держит лаунчер открытым =====
create table if not exists public.presence (
  client_id text primary key,          -- постоянный номер копии лаунчера
  nick      text,                      -- ник (для админки, необязательно)
  last_seen timestamptz not null default now()
);

create index if not exists presence_last_seen_idx on public.presence (last_seen);

-- Читать/писать напрямую нельзя: политик нет, работаем только через функции ниже
alter table public.presence enable row level security;

-- Лаунчер отмечается раз в 30 секунд и получает в ответ текущий онлайн
create or replace function public.heartbeat(p_id text, p_nick text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  if p_id is null or length(p_id) < 8 or length(p_id) > 64 then
    return 0;                                    -- мусорные id игнорируем
  end if;

  insert into public.presence (client_id, nick, last_seen)
  values (p_id, nullif(left(coalesce(p_nick,''),32),''), now())
  on conflict (client_id) do update
    set last_seen = now(),
        nick = coalesce(excluded.nick, presence.nick);

  delete from public.presence where last_seen < now() - interval '1 hour';   -- уборка старья

  select count(*) into n from public.presence where last_seen > now() - interval '90 seconds';
  return n;
end $$;

-- Просто узнать онлайн, ничего не отмечая
create or replace function public.get_online()
returns integer
language sql
security definer
set search_path = public
as $$
  select count(*)::int from public.presence where last_seen > now() - interval '90 seconds';
$$;

-- Лаунчер закрыли — убрать себя из счётчика сразу
create or replace function public.presence_leave(p_id text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.presence where client_id = p_id;
$$;

grant execute on function public.heartbeat(text, text) to anon;
grant execute on function public.get_online()          to anon;
grant execute on function public.presence_leave(text)  to anon;

-- Максимум слотов (то самое «180»). Меняешь тут — меняется у всех, без пересборки.
insert into public.config (key, value) values ('online_max','180')
on conflict (key) do update set value = excluded.value;
```

## Как проверить, что работает

В том же SQL Editor:

```sql
select public.heartbeat('test-client-0001','ТестНик');   -- вернёт 1
select public.get_online();                              -- вернёт 1
select * from public.presence;                           -- увидишь строку
select public.presence_leave('test-client-0001');        -- убрать тестовую запись
```

## Что теперь показывает число в углу лаунчера

- **слева** — сколько лаунчеров открыто прямо сейчас (отметка свежее 90 секунд);
- **справа** — максимум слотов из таблицы `config`, ключ `online_max` (по умолчанию 180);
- если в админке переключить сервер в «Тех. работы» — вместо числа будет красная надпись.

Игрок закрыл лаунчер → пропадает из счётчика сразу; если компьютер выключился жёстко →
пропадёт сам через 90 секунд.

## Приватность

Наружу от игрока уходит только его постоянный случайный номер (тот же, что используется
для входа Ely.by) и ник. Токены, пароли, IP — нет. Таблица закрыта RLS: прочитать список
через ключ лаунчера нельзя, только вызвать три функции выше.
