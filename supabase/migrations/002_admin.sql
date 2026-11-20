-- Кабинет администратора: отключение сотрудников и управление регистрацией
alter table public.sl_profiles add column disabled boolean not null default false;
insert into public.sl_settings (key, value) values ('invite_enabled', 'true') on conflict (key) do nothing;

create or replace function public.sl_is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from sl_profiles where id = auth.uid() and not disabled)
$$;

create or replace function public.sl_can_access(p_chat text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare parts text[];
begin
  if auth.uid() is null or not exists (select 1 from sl_profiles where id = auth.uid() and not disabled) then return false; end if;
  parts := string_to_array(p_chat, ':');
  if parts[1] = 'c' and array_length(parts, 1) = 2 and parts[2] ~ '^\d{1,18}$' then
    return exists (select 1 from sl_channels where id = parts[2]::bigint);
  elsif parts[1] = 'g' and array_length(parts, 1) = 2 and parts[2] ~ '^\d{1,18}$' then
    return exists (select 1 from sl_group_members where group_id = parts[2]::bigint and user_id = auth.uid());
  elsif parts[1] = 'd' and array_length(parts, 1) = 3 then
    if parts[2] > parts[3] then return false; end if;
    return auth.uid()::text in (parts[2], parts[3])
      and exists (select 1 from sl_profiles where id::text = parts[2])
      and exists (select 1 from sl_profiles where id::text = parts[3]);
  end if;
  return false;
end $$;

create or replace function public.sl_chat_member_ids(p_chat text) returns uuid[]
language plpgsql stable security definer set search_path = public as $$
declare parts text[] := string_to_array(p_chat, ':');
begin
  if parts[1] = 'c' then return array(select id from sl_profiles where not disabled);
  elsif parts[1] = 'g' then return array(select m.user_id from sl_group_members m join sl_profiles p on p.id = m.user_id where m.group_id = parts[2]::bigint and not p.disabled);
  elsif parts[1] = 'd' then return array(select id from sl_profiles where id in (parts[2]::uuid, parts[3]::uuid) and not disabled);
  end if;
  return array[]::uuid[];
end $$;

create or replace function public.sl_admin_info() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from sl_profiles where id = auth.uid() and is_admin and not disabled) then raise exception 'Только для администратора'; end if;
  return jsonb_build_object(
    'invite', (select value from sl_settings where key = 'invite_code'),
    'inviteEnabled', coalesce((select value from sl_settings where key = 'invite_enabled'), 'true') = 'true');
end $$;

create or replace function public.sl_new_invite() returns text
language plpgsql security definer set search_path = public as $$
declare code text := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
begin
  if not exists (select 1 from sl_profiles where id = auth.uid() and is_admin and not disabled) then raise exception 'Только для администратора'; end if;
  update sl_settings set value = code where key = 'invite_code';
  return code;
end $$;

create or replace function public.sl_set_invite_enabled(p_enabled boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from sl_profiles where id = auth.uid() and is_admin and not disabled) then raise exception 'Только для администратора'; end if;
  insert into sl_settings (key, value) values ('invite_enabled', case when p_enabled then 'true' else 'false' end)
  on conflict (key) do update set value = excluded.value;
end $$;

revoke execute on function public.sl_set_invite_enabled(boolean) from public, anon;
grant execute on function public.sl_set_invite_enabled(boolean) to authenticated;
revoke execute on function public.sl_chat_member_ids(text) from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array['sl_is_member()', 'sl_can_access(text)', 'sl_admin_info()', 'sl_new_invite()'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
