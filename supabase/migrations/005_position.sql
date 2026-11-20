-- Должность сотрудника (задаёт администратор; при самостоятельной регистрации — сам сотрудник)
alter table public.sl_profiles add column position text not null default '' check (length(position) <= 60);
