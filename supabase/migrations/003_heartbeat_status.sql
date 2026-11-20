-- «Я в приложении» + проверка, что доступ не отключён (false — аккаунт отключён)
drop function if exists public.sl_heartbeat();
create function public.sl_heartbeat() returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update sl_profiles set last_active = now() where id = auth.uid() and not disabled;
  return found;
end $$;
revoke execute on function public.sl_heartbeat() from public, anon;
grant execute on function public.sl_heartbeat() to authenticated;
