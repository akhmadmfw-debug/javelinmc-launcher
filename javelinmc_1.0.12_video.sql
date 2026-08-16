-- ============================================================
-- JavelinMC 1.0.12 — видео в сообщениях
-- Вставь это целиком в Supabase → SQL Editor и нажми Run.
-- Бакет media уже создан (public). Этот скрипт:
--  1) разрешает лаунчеру загружать файлы в бакет media и читать их;
--  2) учит send_message принимать ссылку на видео;
--  3) учит admin_list_messages отдавать видео в админку.
-- Безопасно: существующие сообщения не трогаются.
-- ============================================================

-- (1) Права на бакет media: загрузка (insert) и чтение (select)
drop policy if exists "media_upload" on storage.objects;
drop policy if exists "media_read"   on storage.objects;

create policy "media_upload"
  on storage.objects for insert
  to anon, authenticated
  with check (bucket_id = 'media');

create policy "media_read"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'media');

-- (2) send_message теперь принимает и фото, и ссылку на видео
drop function if exists public.send_message(text, text, text, jsonb);

create or replace function public.send_message(
  p_nick      text,
  p_category  text,
  p_text      text,
  p_photos    jsonb default '[]'::jsonb,
  p_video     text  default null
) returns json
  language plpgsql
  security definer
  set search_path to 'public'
as $function$
begin
  -- сообщение не пустое, если есть текст ИЛИ фото ИЛИ видео
  if coalesce(trim(p_text),'') = ''
     and (p_photos is null or jsonb_array_length(p_photos) = 0)
     and coalesce(p_video,'') = '' then
    return json_build_object('ok', false, 'error', 'Пустое сообщение');
  end if;

  insert into messages(nick, category, body, payload)
  values(
    coalesce(nullif(trim(p_nick), ''), 'Гость'),
    coalesce(p_category, 'Связь'),
    left(coalesce(p_text, ''), 2000),
    jsonb_build_object(
      'photos', coalesce(p_photos, '[]'::jsonb),
      'video',  p_video
    )
  );

  return json_build_object('ok', true);
end;
$function$;

-- (3) admin_list_messages теперь отдаёт фото и видео
create or replace function public.admin_list_messages(p_token text, p_pass text)
  returns json
  language plpgsql
  security definer
  set search_path to 'public'
as $function$
begin
  if not exists(select 1 from admin_auth where token = p_token and pass = p_pass) then
    return json_build_object('ok', false, 'error', 'Нет прав.');
  end if;

  return json_build_object(
    'ok', true,
    'messages', coalesce((
      select json_agg(json_build_object(
        'id',       id,
        'nick',     nick,
        'category', category,
        'body',     body,
        'created',  to_char(created_at, 'DD.MM.YYYY HH24:MI'),
        'reply',    reply,
        'reply_at', to_char(reply_at, 'DD.MM.YYYY HH24:MI'),
        'photos',   coalesce(payload->'photos', '[]'::jsonb),
        'video',    payload->>'video'
      ) order by created_at desc)
      from messages
    ), '[]'::json)
  );
end;
$function$;
