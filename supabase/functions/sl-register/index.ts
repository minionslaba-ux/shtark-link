// Shtark Link — регистрация сотрудника по коду-приглашению.
// Создаёт пользователя Supabase Auth (без письма-подтверждения) и профиль sl_profiles.
// Первый зарегистрированный становится администратором (видит код приглашения).
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
export const emailFor = (login: string) => `${login}@shtark-link.invalid`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  try {
    const b = await req.json().catch(() => ({}));
    const login = String(b.login || '').trim().toLowerCase();
    const name = String(b.name || '').trim();
    const password = String(b.password || '');
    const invite = String(b.invite || '').trim().toUpperCase();
    if (!/^[a-z0-9._-]{2,32}$/.test(login)) return json({ error: 'Логин: 2–32 символа, латиница, цифры, точка, дефис' }, 400);
    if (!name || name.length > 64) return json({ error: 'Укажите имя и фамилию' }, 400);
    if (password.length < 6) return json({ error: 'Пароль — минимум 6 символов' }, 400);

    const { data: enabled } = await db.from('sl_settings').select('value').eq('key', 'invite_enabled').maybeSingle();
    if (enabled?.value === 'false') return json({ error: 'Самостоятельная регистрация выключена. Попросите администратора добавить вас.' }, 403);
    const { data: code } = await db.from('sl_settings').select('value').eq('key', 'invite_code').single();
    if (!code?.value || invite !== code.value) return json({ error: 'Неверный код приглашения. Спросите его у администратора.' }, 403);

    const { data: taken } = await db.from('sl_profiles').select('id').eq('login', login).maybeSingle();
    if (taken) return json({ error: 'Такой логин уже занят' }, 409);

    const { data: created, error } = await db.auth.admin.createUser({
      email: emailFor(login), password, email_confirm: true,
      user_metadata: { app: 'shtark-link', name },
    });
    if (error || !created.user) {
      const msg = /already|exists|registered/i.test(error?.message || '') ? 'Такой логин уже занят' : 'Не удалось создать пользователя: ' + (error?.message || '');
      return json({ error: msg }, 400);
    }
    const { count } = await db.from('sl_profiles').select('id', { count: 'exact', head: true });
    const { error: pe } = await db.from('sl_profiles').insert({ id: created.user.id, login, name, is_admin: (count || 0) === 0 });
    if (pe) {
      await db.auth.admin.deleteUser(created.user.id);
      return json({ error: 'Не удалось создать профиль: ' + pe.message }, 500);
    }
    return json({ ok: true, email: emailFor(login) });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
