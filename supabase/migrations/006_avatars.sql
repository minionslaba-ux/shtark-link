-- Аватарки сотрудников: публичное хранилище sl-avatars, ссылка в sl_profiles.avatar_url
alter table public.sl_profiles add column if not exists avatar_url text not null default '';
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sl-avatars', 'sl-avatars', true, 2097152, array['image/jpeg','image/png','image/webp']) on conflict do nothing;
-- загрузка/удаление — в свою папку <uid>/..., администратор — в любую (см. политики sl_avatars_insert / sl_avatars_delete)
-- sl_set_avatar(p_user, p_url): себе или (админ) любому; ссылка должна вести в sl-avatars/<p_user>/
