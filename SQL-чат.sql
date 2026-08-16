-- ====== JavelinMC: чат с игроком + дата регистрации в списке ======
-- Куда: https://supabase.com/dashboard/project/zdticfhywbyfzxfmypff/sql/new
-- Ctrl+A -> вставить всё -> Run. Один раз. Ожидается: Success. No rows returned.

-- 1) вся переписка с одним игроком (для окна чата)
create or replace function public.admin_user_messages(p_token text, p_pass text, p_nick text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare ok boolean; arr json;
begin
  select public.check_admin(p_token, p_pass) into ok;
  if not ok then return json_build_object('ok', false, 'error', 'нет доступа'); end if;

  select coalesce(json_agg(mj order by ord), '[]'::json) into arr from (
    select json_build_object(
      'id', id,
      'body', body,
      'created', to_char(created_at, 'DD.MM.YYYY HH24:MI'),
      'reply', reply,
      'reply_at', to_char(reply_at, 'DD.MM.YYYY HH24:MI'),
      'category', category
    ) as mj, created_at as ord
    from public.messages
    where nick = lower(trim(p_nick))
  ) q;

  return json_build_object('ok', true, 'messages', arr);
end $$;

-- 2) список пользователей — гарантированно с датой регистрации
create or replace function public.admin_list_users(p_token text, p_pass text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare ok boolean; arr json;
begin
  select public.check_admin(p_token, p_pass) into ok;
  if not ok then return json_build_object('ok', false, 'error', 'нет доступа'); end if;

  select coalesce(json_agg(uj order by ord desc), '[]'::json) into arr from (
    select json_build_object(
      'nick', coalesce(display_nick, nick),
      'blocked', coalesce(blocked, false),
      'created', to_char(created_at, 'YYYY-MM-DD')
    ) as uj, created_at as ord
    from public.users
  ) q;

  return json_build_object('ok', true, 'users', arr);
end $$;

grant execute on function public.admin_user_messages(text, text, text) to anon;
grant execute on function public.admin_list_users(text, text)          to anon;
