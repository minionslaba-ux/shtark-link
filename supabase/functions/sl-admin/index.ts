// Shtark Link — кабинет администратора.
// Только для сотрудников с is_admin. Действия:
//   list — список сотрудников; create { login, name, password, isAdmin } — добавить;
//   disable { id } — отключить (доступ закрыт, история сохраняется); enable { id } — вернуть доступ;
//   password { id, password } — новый пароль; admin { id, isAdmin } — права администратора;
//   profile { id, name, position } — изменить имя и должность.
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
const emailFor = (login: string) => `${login}@shtark-link.invalid`;
const FOREVER = '876000h'; // ~100 лет

async function activeAdmins(exceptId?: string) {
  let q = db.from('sl_profiles').select('id', { count: 'exact', head: true }).eq('is_admin', true).eq('disabled', false);
  if (exceptId) q = q.neq('id', exceptId);
  const { count } = await q;
  return count || 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: u } = await db.auth.getUser(token);
    const { data: me } = u?.user
      ? await db.from('sl_profiles').select('id, name, is_admin, disabled').eq('id', u.user.id).maybeSingle()
      : { data: null };
    if (!me || !me.is_admin || me.disabled) return json({ error: 'Только для администратора' }, 403);

    const b = await req.json().catch(() => ({}));
    const id = String(b.id || '');
    const target = id ? (await db.from('sl_profiles').select('*').eq('id', id).maybeSingle()).data : null;
    if (id && !target) return json({ error: 'Сотрудник не найден' }, 404);

    switch (b.action) {
      case 'list': {
        const { data } = await db.from('sl_profiles')
          .select('id, login, name, position, is_admin, disabled, last_active, created_at').order('disabled').order('name');
        return json({ users: data || [] });
      }
      case 'create': {
        const login = String(b.login || '').trim().toLowerCase();
        const name = String(b.name || '').trim();
        const position = String(b.position || '').trim().slice(0, 60);
        const password = String(b.password || '');
        if (!/^[a-z0-9._-]{2,32}$/.test(login)) return json({ error: 'Логин: 2–32 символа, латиница, цифры, точка, дефис' }, 400);
        if (!name || name.length > 64) return json({ error: 'Укажите имя и фамилию' }, 400);
        if (password.length < 6) return json({ error: 'Пароль — минимум 6 символов' }, 400);
        const { data: taken } = await db.from('sl_profiles').select('id').eq('login', login).maybeSingle();
        if (taken) return json({ error: 'Такой логин уже занят' }, 409);
        const { data: created, error } = await db.auth.admin.createUser({
          email: emailFor(login), password, email_confirm: true, user_metadata: { app: 'shtark-link', name },
        });
        if (error || !created.user) return json({ error: 'Не удалось создать: ' + (error?.message || '') }, 400);
        const { error: pe } = await db.from('sl_profiles').insert({ id: created.user.id, login, name, position, is_admin: !!b.isAdmin });
        if (pe) { await db.auth.admin.deleteUser(created.user.id); return json({ error: pe.message }, 500); }
        return json({ ok: true, id: created.user.id });
      }
      case 'disable': {
        if (id === me.id) return json({ error: 'Нельзя отключить самого себя' }, 400);
        if (target.is_admin && (await activeAdmins(id)) === 0) return json({ error: 'Нельзя отключить последнего администратора' }, 400);
        await db.auth.admin.updateUserById(id, { ban_duration: FOREVER });   // старые сессии перестают обновляться
        await db.from('sl_profiles').update({ disabled: true }).eq('id', id);
        await db.from('sl_group_members').delete().eq('user_id', id);
        await db.from('sl_push_subs').delete().eq('user_id', id);
        return json({ ok: true });
      }
      case 'enable': {
        await db.auth.admin.updateUserById(id, { ban_duration: 'none' });
        await db.from('sl_profiles').update({ disabled: false }).eq('id', id);
        return json({ ok: true });
      }
      case 'password': {
        const password = String(b.password || '');
        if (password.length < 6) return json({ error: 'Пароль — минимум 6 символов' }, 400);
        const { error } = await db.auth.admin.updateUserById(id, { password });
        return error ? json({ error: error.message }, 400) : json({ ok: true });
      }
      case 'profile': {
        const name = String(b.name || '').trim(), position = String(b.position || '').trim().slice(0, 60);
        if (!name || name.length > 64) return json({ error: 'Укажите имя и фамилию' }, 400);
        const { error } = await db.from('sl_profiles').update({ name, position }).eq('id', id);
        return error ? json({ error: error.message }, 400) : json({ ok: true });
      }
      case 'admin': {
        if (!b.isAdmin && target.is_admin && (await activeAdmins(id)) === 0) return json({ error: 'Должен остаться хотя бы один администратор' }, 400);
        await db.from('sl_profiles').update({ is_admin: !!b.isAdmin }).eq('id', id);
        return json({ ok: true });
      }
    }
    return json({ error: 'Неизвестное действие' }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
