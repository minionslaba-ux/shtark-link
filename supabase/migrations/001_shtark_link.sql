-- Shtark Link: корпоративный мессенджер на Supabase.
-- Все объекты с префиксом sl_, чтобы не пересекаться с другими приложениями проекта.

-- ============ Настройки (только для сервера) ============
create table public.sl_settings (
  key text primary key,
  value text not null
);
alter table public.sl_settings enable row level security; -- политик нет: читает только service_role
insert into public.sl_settings (key, value) values
  ('invite_code', upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8))),
  ('hook_secret', md5(random()::text || clock_timestamp()::text) || md5(random()::text));

-- ============ Сотрудники ============
create table public.sl_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  login text not null unique check (login ~ '^[a-z0-9._-]{2,32}$'),
  name text not null check (length(name) between 1 and 64),
  is_admin boolean not null default false,
  last_active timestamptz,
  created_at timestamptz not null default now()
);
alter table public.sl_profiles enable row level security;

create or replace function public.sl_is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from sl_profiles where id = auth.uid())
$$;

create policy sl_profiles_select on public.sl_profiles for select to authenticated using (public.sl_is_member());

-- ============ Каналы ============
create table public.sl_channels (
  id bigserial primary key,
  name text not null unique check (length(name) between 1 and 40),
  created_by uuid references public.sl_profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.sl_channels enable row level security;
create policy sl_channels_select on public.sl_channels for select to authenticated using (public.sl_is_member());
create policy sl_channels_insert on public.sl_channels for insert to authenticated
  with check (public.sl_is_member() and created_by = auth.uid());
insert into public.sl_channels (name) values ('общий'), ('флуд');

-- ============ Групповые чаты ============
create table public.sl_groups (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 60),
  created_by uuid references public.sl_profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create table public.sl_group_members (
  group_id bigint not null references public.sl_groups(id) on delete cascade,
  user_id uuid not null references public.sl_profiles(id) on delete cascade,
  primary key (group_id, user_id)
);
create index sl_group_members_user on public.sl_group_members(user_id);
alter table public.sl_groups enable row level security;
alter table public.sl_group_members enable row level security;

create or replace function public.sl_in_group(p_group bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from sl_group_members where group_id = p_group and user_id = auth.uid())
$$;
create policy sl_groups_select on public.sl_groups for select to authenticated using (public.sl_in_group(id));
create policy sl_group_members_select on public.sl_group_members for select to authenticated using (public.sl_in_group(group_id));

-- Доступ к чату: 'c:<id>' канал, 'g:<id>' группа, 'd:<uuid>:<uuid>' личка (uuid по возрастанию)
create or replace function public.sl_can_access(p_chat text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare parts text[];
begin
  if auth.uid() is null or not exists (select 1 from sl_profiles where id = auth.uid()) then return false; end if;
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

-- Участники чата (для рассылки push; только для сервера)
create or replace function public.sl_chat_member_ids(p_chat text) returns uuid[]
language plpgsql stable security definer set search_path = public as $$
declare parts text[] := string_to_array(p_chat, ':');
begin
  if parts[1] = 'c' then return array(select id from sl_profiles);
  elsif parts[1] = 'g' then return array(select user_id from sl_group_members where group_id = parts[2]::bigint);
  elsif parts[1] = 'd' then return array[parts[2]::uuid, parts[3]::uuid];
  end if;
  return array[]::uuid[];
end $$;
revoke execute on function public.sl_chat_member_ids(text) from public, anon, authenticated;

-- ============ Сообщения ============
create table public.sl_messages (
  id bigserial primary key,
  chat text not null check (length(chat) <= 100),
  user_id uuid not null references public.sl_profiles(id) on delete cascade,
  text text not null default '' check (length(text) <= 4000),
  file jsonb, -- {path, name, mime, size}
  system boolean not null default false,
  created_at timestamptz not null default now()
);
create index sl_messages_chat on public.sl_messages(chat, id desc);
alter table public.sl_messages enable row level security;
create policy sl_messages_select on public.sl_messages for select to authenticated using (public.sl_can_access(chat));
create policy sl_messages_insert on public.sl_messages for insert to authenticated with check (
  user_id = auth.uid() and not system and public.sl_can_access(chat)
  and (text <> '' or file is not null)
  and (file is null or left(file->>'path', length(chat) + 1) = replace(chat, ':', '_') || '/')
);

-- Служебное сообщение в чат (только из функций)
create or replace function public.sl_system_message(p_chat text, p_text text) returns void
language sql security definer set search_path = public as $$
  insert into sl_messages (chat, user_id, text, system) values (p_chat, auth.uid(), p_text, true);
$$;
revoke execute on function public.sl_system_message(text, text) from public, anon, authenticated;

-- ============ Операции с группами ============
create or replace function public.sl_create_group(p_name text, p_members uuid[]) returns bigint
language plpgsql security definer set search_path = public as $$
declare gid bigint; me text;
begin
  if not sl_is_member() then raise exception 'Нет доступа'; end if;
  p_name := btrim(coalesce(p_name, ''));
  if p_name = '' or length(p_name) > 60 then raise exception 'Укажите название чата'; end if;
  if coalesce(array_length(array_remove(p_members, auth.uid()), 1), 0) = 0 then raise exception 'Выберите хотя бы одного участника'; end if;
  insert into sl_groups (name, created_by) values (p_name, auth.uid()) returning id into gid;
  insert into sl_group_members (group_id, user_id)
    select gid, u from (select auth.uid() as u union select unnest(p_members)) x
    where exists (select 1 from sl_profiles where id = x.u)
    on conflict do nothing;
  select name into me from sl_profiles where id = auth.uid();
  perform sl_system_message('g:' || gid, me || ' создал(а) чат «' || p_name || '»');
  return gid;
end $$;

create or replace function public.sl_add_group_members(p_group bigint, p_members uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare added text; me text;
begin
  if not sl_in_group(p_group) then raise exception 'Нет доступа'; end if;
  with ins as (
    insert into sl_group_members (group_id, user_id)
    select p_group, u from unnest(p_members) u where exists (select 1 from sl_profiles where id = u)
    on conflict do nothing returning user_id
  ) select string_agg(p.name, ', ') into added from ins join sl_profiles p on p.id = ins.user_id;
  if added is not null then
    select name into me from sl_profiles where id = auth.uid();
    perform sl_system_message('g:' || p_group, me || ' добавил(а): ' || added);
  end if;
end $$;

create or replace function public.sl_rename_group(p_group bigint, p_name text) returns void
language plpgsql security definer set search_path = public as $$
declare me text;
begin
  if not sl_in_group(p_group) then raise exception 'Нет доступа'; end if;
  p_name := btrim(coalesce(p_name, ''));
  if p_name = '' or length(p_name) > 60 then raise exception 'Укажите название'; end if;
  update sl_groups set name = p_name where id = p_group;
  select name into me from sl_profiles where id = auth.uid();
  perform sl_system_message('g:' || p_group, me || ' переименовал(а) чат в «' || p_name || '»');
end $$;

create or replace function public.sl_leave_group(p_group bigint) returns void
language plpgsql security definer set search_path = public as $$
declare me text;
begin
  if not sl_in_group(p_group) then raise exception 'Нет доступа'; end if;
  select name into me from sl_profiles where id = auth.uid();
  perform sl_system_message('g:' || p_group, me || ' покинул(а) чат');
  delete from sl_group_members where group_id = p_group and user_id = auth.uid();
end $$;

-- ============ Календарь ============
create table public.sl_events (
  id bigserial primary key,
  user_id uuid not null default auth.uid() references public.sl_profiles(id) on delete cascade,
  title text not null check (length(title) between 1 and 200),
  note text not null default '' check (length(note) <= 4000),
  date date not null,
  time text check (time ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  shared boolean not null default false,
  done boolean not null default false,
  created_at timestamptz not null default now()
);
create index sl_events_date on public.sl_events(date);
alter table public.sl_events enable row level security;
create policy sl_events_select on public.sl_events for select to authenticated
  using (public.sl_is_member() and (shared or user_id = auth.uid()));
create policy sl_events_insert on public.sl_events for insert to authenticated
  with check (public.sl_is_member() and user_id = auth.uid());
create policy sl_events_update on public.sl_events for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy sl_events_delete on public.sl_events for delete to authenticated using (user_id = auth.uid());

-- Отметить «выполнено» в общем деле может любой
create or replace function public.sl_set_event_done(p_id bigint, p_done boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  update sl_events set done = p_done
  where id = p_id and sl_is_member() and (shared or user_id = auth.uid());
  if not found then raise exception 'Дело не найдено'; end if;
end $$;

-- ============ Задачи ============
create table public.sl_tasks (
  id bigserial primary key,
  title text not null check (length(title) between 1 and 200),
  description text not null default '' check (length(description) <= 8000),
  created_by uuid not null default auth.uid() references public.sl_profiles(id) on delete cascade,
  assignee_id uuid not null references public.sl_profiles(id) on delete cascade,
  due_date date not null,
  due_time text check (due_time ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  priority smallint not null default 0 check (priority in (0, 1)),
  status text not null default 'new' check (status in ('new', 'in_progress', 'done')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
alter table public.sl_tasks enable row level security;
create policy sl_tasks_select on public.sl_tasks for select to authenticated using (public.sl_is_member());
create policy sl_tasks_insert on public.sl_tasks for insert to authenticated
  with check (public.sl_is_member() and created_by = auth.uid() and status = 'new');
create policy sl_tasks_delete on public.sl_tasks for delete to authenticated using (created_by = auth.uid());

create table public.sl_task_comments (
  id bigserial primary key,
  task_id bigint not null references public.sl_tasks(id) on delete cascade,
  user_id uuid not null default auth.uid() references public.sl_profiles(id) on delete cascade,
  text text not null check (length(text) between 1 and 4000),
  system boolean not null default false,
  created_at timestamptz not null default now()
);
create index sl_task_comments_task on public.sl_task_comments(task_id, id);
alter table public.sl_task_comments enable row level security;
create policy sl_task_comments_select on public.sl_task_comments for select to authenticated using (public.sl_is_member());
create policy sl_task_comments_insert on public.sl_task_comments for insert to authenticated
  with check (public.sl_is_member() and user_id = auth.uid() and not system);
create policy sl_task_comments_delete on public.sl_task_comments for delete to authenticated
  using (user_id = auth.uid() and not system);

-- Изменение задачи: автор — всё, исполнитель — только статус. Пишет историю.
create or replace function public.sl_update_task(p_id bigint, p jsonb) returns public.sl_tasks
language plpgsql security definer set search_path = public as $$
declare t sl_tasks; n sl_tasks; me text; only_status boolean;
  st jsonb := '{"new":"Новая","in_progress":"В работе","done":"Выполнена"}';
begin
  select * into t from sl_tasks where id = p_id;
  if not found or not sl_is_member() then raise exception 'Задача не найдена'; end if;
  only_status := coalesce((select bool_and(k = 'status') from jsonb_object_keys(p) k), false);
  if t.created_by <> auth.uid() and not (t.assignee_id = auth.uid() and only_status) then
    raise exception '%', case when t.assignee_id = auth.uid() then 'Исполнитель может менять только статус'
                              else 'Менять задачу может только автор или исполнитель' end;
  end if;
  n := t;
  if p ? 'title' then n.title := btrim(p->>'title'); if n.title = '' then raise exception 'Укажите, что нужно сделать'; end if; end if;
  if p ? 'description' then n.description := coalesce(p->>'description', ''); end if;
  if p ? 'assigneeId' then
    n.assignee_id := (p->>'assigneeId')::uuid;
    if not exists (select 1 from sl_profiles where id = n.assignee_id) then raise exception 'Выберите исполнителя'; end if;
  end if;
  if p ? 'dueDate' then n.due_date := (p->>'dueDate')::date; end if;
  if p ? 'dueTime' then n.due_time := nullif(p->>'dueTime', ''); end if;
  if p ? 'priority' then n.priority := case when (p->>'priority')::boolean then 1 else 0 end; end if;
  if p ? 'status' then
    if (p->>'status') not in ('new', 'in_progress', 'done') then raise exception 'Некорректный статус'; end if;
    n.status := p->>'status';
    if n.status <> t.status then n.completed_at := case when n.status = 'done' then now() end; end if;
  end if;
  update sl_tasks set title = n.title, description = n.description, assignee_id = n.assignee_id,
    due_date = n.due_date, due_time = n.due_time, priority = n.priority, status = n.status,
    completed_at = n.completed_at, updated_at = now()
  where id = p_id returning * into n;

  select name into me from sl_profiles where id = auth.uid();
  if n.status <> t.status then
    insert into sl_task_comments (task_id, user_id, text, system)
    values (p_id, auth.uid(), me || ': статус «' || (st->>t.status) || '» → «' || (st->>n.status) || '»', true);
  end if;
  if n.assignee_id <> t.assignee_id then
    insert into sl_task_comments (task_id, user_id, text, system)
    values (p_id, auth.uid(), me || ' передал(а) задачу: ' || (select name from sl_profiles where id = n.assignee_id), true);
  end if;
  if n.due_date <> t.due_date or n.due_time is distinct from t.due_time then
    insert into sl_task_comments (task_id, user_id, text, system)
    values (p_id, auth.uid(), me || ' изменил(а) срок: ' || to_char(t.due_date, 'DD.MM.YYYY') || coalesce(' ' || t.due_time, '')
      || ' → ' || to_char(n.due_date, 'DD.MM.YYYY') || coalesce(' ' || n.due_time, ''), true);
  end if;
  return n;
end $$;

-- Задачи со счётчиком комментариев (права — как у таблиц)
create view public.sl_tasks_v with (security_invoker = on) as
  select t.*, (select count(*) from public.sl_task_comments c where c.task_id = t.id and not c.system)::int as comment_count
  from public.sl_tasks t;

-- ============ Push-подписки (только сервер) ============
create table public.sl_push_subs (
  endpoint text primary key,
  user_id uuid not null references public.sl_profiles(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
alter table public.sl_push_subs enable row level security;

-- «Я сейчас в приложении» — чтобы не слать push тем, у кого Shtark Link открыт
create or replace function public.sl_heartbeat() returns void
language sql security definer set search_path = public as $$
  update sl_profiles set last_active = now() where id = auth.uid();
$$;

-- ============ Администратор ============
create or replace function public.sl_admin_info() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from sl_profiles where id = auth.uid() and is_admin) then raise exception 'Только для администратора'; end if;
  return jsonb_build_object('invite', (select value from sl_settings where key = 'invite_code'));
end $$;

create or replace function public.sl_new_invite() returns text
language plpgsql security definer set search_path = public as $$
declare code text := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
begin
  if not exists (select 1 from sl_profiles where id = auth.uid() and is_admin) then raise exception 'Только для администратора'; end if;
  update sl_settings set value = code where key = 'invite_code';
  return code;
end $$;

-- ============ Файлы ============
insert into storage.buckets (id, name, public, file_size_limit)
values ('sl-files', 'sl-files', false, 52428800)
on conflict (id) do nothing;

create policy sl_files_select on storage.objects for select to authenticated
  using (bucket_id = 'sl-files' and public.sl_can_access(replace(split_part(name, '/', 1), '_', ':')));
create policy sl_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'sl-files' and public.sl_can_access(replace(split_part(name, '/', 1), '_', ':')));

-- ============ Realtime ============
alter publication supabase_realtime add table
  public.sl_messages, public.sl_tasks, public.sl_task_comments, public.sl_events,
  public.sl_groups, public.sl_group_members, public.sl_profiles, public.sl_channels;

-- Закрытые каналы присутствия / «печатает» / звонков: топики 'sl:*', только сотрудники
create policy sl_realtime_select on realtime.messages for select to authenticated
  using (realtime.topic() like 'sl:%' and public.sl_is_member());
create policy sl_realtime_insert on realtime.messages for insert to authenticated
  with check (realtime.topic() like 'sl:%' and public.sl_is_member());

-- ============ Push по событиям (через edge-функцию sl-push) ============
create or replace function public.sl_hook() returns trigger
language plpgsql security definer set search_path = public as $$
declare secret text;
begin
  if TG_TABLE_NAME in ('sl_messages', 'sl_task_comments') then
    if NEW.system then return NEW; end if;
  end if;
  select value into secret from sl_settings where key = 'hook_secret';
  perform net.http_post(
    url := 'https://xqgibyazilueurdqufso.supabase.co/functions/v1/sl-push',
    body := jsonb_build_object('hook', TG_TABLE_NAME, 'op', TG_OP, 'actor', auth.uid(),
      'new', case when TG_OP <> 'DELETE' then to_jsonb(NEW) end,
      'old', case when TG_OP <> 'INSERT' then to_jsonb(OLD) end),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sl-hook', secret),
    timeout_milliseconds := 5000);
  return coalesce(NEW, OLD);
exception when others then
  return coalesce(NEW, OLD); -- push не должен ломать отправку сообщения
end $$;

create trigger sl_messages_push after insert on public.sl_messages for each row execute function public.sl_hook();
create trigger sl_task_comments_push after insert on public.sl_task_comments for each row execute function public.sl_hook();
create trigger sl_tasks_push after insert or update or delete on public.sl_tasks for each row execute function public.sl_hook();

-- Права на функции: по умолчанию EXECUTE есть у PUBLIC — снимаем и выдаём только сотрудникам
do $$
declare f text;
begin
  foreach f in array array[
    'sl_is_member()', 'sl_in_group(bigint)', 'sl_can_access(text)',
    'sl_create_group(text, uuid[])', 'sl_add_group_members(bigint, uuid[])', 'sl_rename_group(bigint, text)',
    'sl_leave_group(bigint)', 'sl_set_event_done(bigint, boolean)', 'sl_update_task(bigint, jsonb)',
    'sl_heartbeat()', 'sl_admin_info()', 'sl_new_invite()'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke execute on function public.sl_hook() from public, anon, authenticated;
revoke execute on function public.sl_system_message(text, text) from public, anon, authenticated;
revoke execute on function public.sl_chat_member_ids(text) from public, anon, authenticated;
