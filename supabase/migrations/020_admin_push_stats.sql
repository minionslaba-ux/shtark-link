-- Администратору: у кого из сотрудников включены уведомления и на каких устройствах (без самих адресов подписок)
create or replace function public.sl_admin_push_stats()
returns table (user_id uuid, subs int, apple int, android_chrome int, other int, last_ok timestamptz, failing int)
language sql stable security definer set search_path = public as $$
  select s.user_id,
    count(*)::int,
    count(*) filter (where s.endpoint like '%push.apple.com%')::int,
    count(*) filter (where s.endpoint like '%fcm.googleapis.com%')::int,
    count(*) filter (where s.endpoint not like '%push.apple.com%' and s.endpoint not like '%fcm.googleapis.com%')::int,
    max(s.last_at) filter (where s.last_status between 200 and 299),
    count(*) filter (where s.last_status >= 400)::int
  from sl_push_subs s
  where public.sl_is_admin()
  group by s.user_id
$$;
revoke all on function public.sl_admin_push_stats() from public, anon;
grant execute on function public.sl_admin_push_stats() to authenticated;
