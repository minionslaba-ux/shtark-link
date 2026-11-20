// Shtark Link — резервная копия данных (переписка, задачи, календарь и т. д.) в закрытое хранилище sl-backups.
// Запуск: администратор из приложения (Authorization: Bearer) или планировщик раз в неделю (заголовок x-sl-hook).
// Сами файлы (вложения) остаются в хранилище sl-files — в копию попадают их названия и пути.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-sl-hook',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const TABLES = ['sl_profiles', 'sl_channels', 'sl_channel_members', 'sl_groups', 'sl_group_members', 'sl_messages', 'sl_reactions', 'sl_poll_votes',
  'sl_tasks', 'sl_task_comments', 'sl_events', 'sl_calls', 'sl_announcements', 'sl_acks', 'sl_approvals', 'sl_approval_events', 'sl_kb', 'sl_workdays', 'sl_audit'];
const KEEP = 12; // хранить последние 12 копий

async function dumpTable(t: string) {
  const rows: unknown[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(t).select('*').range(from, from + 999);
    if (error) throw new Error(`${t}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const hook = req.headers.get('x-sl-hook');
    let actor: string | null = null;
    if (hook) {
      const { data } = await db.from('sl_settings').select('value').eq('key', 'hook_secret').maybeSingle();
      if (hook !== data?.value) return json({ error: 'forbidden' }, 403);
    } else {
      const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      const { data: u } = await db.auth.getUser(token);
      const { data: me } = u?.user ? await db.from('sl_profiles').select('id, is_admin, disabled').eq('id', u.user.id).maybeSingle() : { data: null };
      if (!me || !me.is_admin || me.disabled) return json({ error: 'Только для администратора' }, 403);
      actor = me.id;
    }
    const out: Record<string, unknown> = { app: 'Shtark Link', created_at: new Date().toISOString(), tables: {} };
    const counts: Record<string, number> = {};
    for (const t of TABLES) { const rows = await dumpTable(t); (out.tables as Record<string, unknown>)[t] = rows; counts[t] = rows.length; }
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
    const name = `backup-${stamp}.json`;
    const body = new TextEncoder().encode(JSON.stringify(out));
    const { error } = await db.storage.from('sl-backups').upload(name, body, { contentType: 'application/json', upsert: true });
    if (error) throw new Error(error.message);
    // старые копии удаляем
    const { data: list } = await db.storage.from('sl-backups').list('', { limit: 1000, sortBy: { column: 'name', order: 'desc' } });
    const old = (list || []).filter((f) => f.name.startsWith('backup-')).slice(KEEP).map((f) => f.name);
    if (old.length) await db.storage.from('sl-backups').remove(old);
    await db.from('sl_audit').insert({ actor, action: actor ? 'Создана резервная копия' : 'Автоматическая резервная копия', target: name, details: { размер_кб: Math.round(body.length / 1024), сообщений: counts.sl_messages, задач: counts.sl_tasks } });
    return json({ ok: true, name, size: body.length, counts });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
