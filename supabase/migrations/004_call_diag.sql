-- Диагностика звонков: каждое устройство во время звонка пишет технические показатели (без звука и содержимого)
create table public.sl_call_diag (
  user_id uuid not null references public.sl_profiles(id) on delete cascade,
  device text not null,
  chat text,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, device)
);
alter table public.sl_call_diag enable row level security;
create policy sl_call_diag_select on public.sl_call_diag for select to authenticated using (user_id = auth.uid());
create policy sl_call_diag_insert on public.sl_call_diag for insert to authenticated with check (user_id = auth.uid() and public.sl_is_member());
create policy sl_call_diag_update on public.sl_call_diag for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
