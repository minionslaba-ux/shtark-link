-- Результат последней доставки push на устройство (для диагностики)
alter table public.sl_push_subs add column last_status int, add column last_error text, add column last_at timestamptz;

-- Удаление сообщений: своё — автор, любое — администратор
create policy sl_messages_delete on public.sl_messages for delete to authenticated
  using (not system and public.sl_is_member() and (user_id = auth.uid()
    or exists (select 1 from public.sl_profiles where id = auth.uid() and is_admin and not disabled)));
-- Файлы удалённых сообщений: автор файла может удалить свой файл
create policy sl_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'sl-files' and owner_id = auth.uid()::text);
