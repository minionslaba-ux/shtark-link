// Shtark Link — push-уведомления (Web Push).
// 1) Вызовы из базы (триггеры sl_hook, заголовок x-sl-hook): новое сообщение, задача, комментарий.
// 2) Вызовы из приложения (Authorization: Bearer <токен сотрудника>):
//    { action: 'vapid' } — открытый ключ; 'subscribe' { sub }; 'unsubscribe' { endpoint };
//    'test' — тестовое уведомление себе; 'ring' { chat } — «входящий звонок» тем, у кого приложение закрыто.
// Тем, кто сейчас в приложении (last_active < 60 с), push не отправляется — вкладка покажет уведомление сама.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

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
const b64u = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const short = (s: string, n = 140) => (s.length > n ? s.slice(0, n) + '…' : s);
const fmtDue = (d: string, t: string | null) => d.split('-').reverse().join('.') + (t ? ' ' + t : '');

async function setting(key: string) {
  const { data } = await db.from('sl_settings').select('value').eq('key', key).maybeSingle();
  return data?.value as string | undefined;
}

// Ключи VAPID создаются при первом обращении и хранятся в закрытой таблице sl_settings
let vapidCache: { pub: string; priv: string } | null = null;
async function vapid() {
  if (vapidCache) return vapidCache;
  let pub = await setting('vapid_pub'), priv = await setting('vapid_priv');
  if (!pub || !priv) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    pub = b64u(await crypto.subtle.exportKey('raw', kp.publicKey));
    priv = (await crypto.subtle.exportKey('jwk', kp.privateKey)).d!;
    await db.from('sl_settings').upsert([{ key: 'vapid_pub', value: pub }, { key: 'vapid_priv', value: priv }], { onConflict: 'key', ignoreDuplicates: true });
    pub = await setting('vapid_pub'); priv = await setting('vapid_priv'); // если две функции создали ключи одновременно
  }
  vapidCache = { pub: pub!, priv: priv! };
  webpush.setVapidDetails('mailto:noreply@shtark-link.invalid', vapidCache.pub, vapidCache.priv);
  return vapidCache;
}

async function names(ids: string[]) {
  const { data } = await db.from('sl_profiles').select('id, name').in('id', ids);
  return new Map((data || []).map((p: { id: string; name: string }) => [p.id, p.name]));
}

type Payload = { title: string; body: string; url: string; tag: string; ttl?: number; urgency?: string; requireInteraction?: boolean };

async function send(userIds: string[], p: Payload, { force = false } = {}) {
  let ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return 0;
  if (!force) {
    const since = new Date(Date.now() - 60_000).toISOString();
    const { data: active } = await db.from('sl_profiles').select('id').in('id', ids).gt('last_active', since);
    const skip = new Set((active || []).map((a: { id: string }) => a.id));
    ids = ids.filter((id) => !skip.has(id));
    if (!ids.length) return 0;
  }
  await vapid();
  const { data: subs } = await db.from('sl_push_subs').select('*').in('user_id', ids);
  const body = JSON.stringify({ icon: '/icon-192.png', badge: '/icon-192.png', ...p });
  let sent = 0;
  await Promise.all((subs || []).map(async (s: { endpoint: string; p256dh: string; auth: string }) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body,
        { TTL: p.ttl ?? 86400, urgency: (p.urgency as 'normal') || 'normal' });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db.from('sl_push_subs').delete().eq('endpoint', s.endpoint);
    }
  }));
  return sent;
}

async function chatTitle(chat: string) {
  if (chat.startsWith('c:')) {
    const { data } = await db.from('sl_channels').select('name').eq('id', Number(chat.slice(2))).maybeSingle();
    return data ? '# ' + data.name : '';
  }
  if (chat.startsWith('g:')) {
    const { data } = await db.from('sl_groups').select('name').eq('id', Number(chat.slice(2))).maybeSingle();
    return data?.name || '';
  }
  return '';
}

async function members(chat: string): Promise<string[]> {
  const { data } = await db.rpc('sl_chat_member_ids', { p_chat: chat });
  return (data || []) as string[];
}

// ---------- события из базы ----------
async function onHook(b: any) {
  const { hook, op, actor } = b;
  const n = b.new, o = b.old;
  if (hook === 'sl_messages' && op === 'INSERT') {
    const nm = await names([n.user_id]);
    const author = nm.get(n.user_id) || 'Сотрудник';
    const text = n.text || (n.file ? '📎 ' + n.file.name : '');
    const title = await chatTitle(n.chat);
    const to = (await members(n.chat)).filter((id) => id !== n.user_id);
    return send(to, title
      ? { title, body: short(`${author}: ${text}`), url: `/#chat=${n.chat}`, tag: n.chat }
      : { title: author, body: short(text), url: `/#chat=${n.chat}`, tag: n.chat });
  }
  if (hook === 'sl_tasks') {
    const t = n || o;
    const nm = await names([actor, t.created_by].filter(Boolean));
    const who = nm.get(actor) || nm.get(t.created_by) || 'Сотрудник';
    const url = `/#task=${t.id}`, tag = `task-${t.id}`;
    const due = n ? fmtDue(n.due_date, n.due_time) : '';
    if (op === 'INSERT') {
      return send([n.assignee_id].filter((id) => id !== n.created_by),
        { title: '📋 Новая задача', body: `${who}: ${n.title} — срок ${due}`, url, tag });
    }
    if (op === 'DELETE') {
      return send([o.assignee_id].filter((id) => id !== actor), { title: '📋 Задача отменена', body: `${who}: ${o.title}`, url: '/#tasks', tag });
    }
    if (op === 'UPDATE') {
      if (n.assignee_id !== o.assignee_id) {
        return send([n.assignee_id].filter((id) => id !== actor), { title: '📋 Новая задача', body: `${who}: ${n.title} — срок ${due}`, url, tag });
      }
      if (n.status !== o.status) {
        const label = ({ done: '✅ Задача выполнена', in_progress: '▶ Задача в работе', new: '↩ Задача снова открыта' } as Record<string, string>)[n.status];
        return send([n.created_by, n.assignee_id].filter((id) => id !== actor), { title: label, body: `${who}: ${n.title}`, url, tag });
      }
      return send([n.assignee_id].filter((id) => id !== actor), { title: '✏️ Задача изменена', body: `${who}: ${n.title} — срок ${due}`, url, tag });
    }
  }
  if (hook === 'sl_task_comments' && op === 'INSERT') {
    const { data: t } = await db.from('sl_tasks').select('id, title, created_by, assignee_id').eq('id', n.task_id).maybeSingle();
    if (!t) return 0;
    const nm = await names([n.user_id]);
    return send([t.created_by, t.assignee_id].filter((id: string) => id !== n.user_id),
      { title: `💬 ${t.title}`, body: short(`${nm.get(n.user_id) || 'Сотрудник'}: ${n.text}`), url: `/#task=${t.id}`, tag: `task-${t.id}` });
  }
  return 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));

    // из базы
    const hookKey = req.headers.get('x-sl-hook');
    if (hookKey) {
      if (hookKey !== (await setting('hook_secret'))) return json({ error: 'forbidden' }, 403);
      return json({ sent: await onHook(body) });
    }

    // из приложения
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: u } = await db.auth.getUser(token);
    const uid = u?.user?.id;
    const { data: me } = uid ? await db.from('sl_profiles').select('id, name').eq('id', uid).maybeSingle() : { data: null };
    if (!me) return json({ error: 'Не авторизован' }, 401);

    switch (body.action) {
      case 'vapid':
        return json({ publicKey: (await vapid()).pub });
      case 'subscribe': {
        const s = body.sub || {};
        const ep = String(s.endpoint || ''), p256dh = String(s.keys?.p256dh || ''), auth = String(s.keys?.auth || '');
        if (!/^https:\/\//.test(ep) || ep.length > 1000 || !p256dh || !auth || p256dh.length > 200 || auth.length > 100) return json({ error: 'Некорректная подписка' }, 400);
        const { error } = await db.from('sl_push_subs').upsert({ endpoint: ep, user_id: me.id, p256dh, auth }, { onConflict: 'endpoint' });
        return error ? json({ error: error.message }, 500) : json({ ok: true });
      }
      case 'unsubscribe':
        await db.from('sl_push_subs').delete().eq('endpoint', String(body.endpoint || '')).eq('user_id', me.id);
        return json({ ok: true });
      case 'test':
        return json({ sent: await send([me.id], { title: 'Shtark Link', body: 'Уведомления работают 🎉', url: '/', tag: 'test' }, { force: true }) });
      case 'ring': {
        const chat = String(body.chat || '');
        const list = await members(chat);
        if (!list.includes(me.id)) return json({ error: 'Нет доступа' }, 403);
        const title = await chatTitle(chat);
        return json({ sent: await send(list.filter((id) => id !== me.id), {
          title: '📞 Входящий звонок', body: title ? `${me.name} начал(а) звонок в «${title}»` : `${me.name} звонит вам`,
          url: `/#chat=${chat}`, tag: `call-${chat}`, ttl: 45, urgency: 'high', requireInteraction: true,
        }) });
      }
    }
    return json({ error: 'Неизвестное действие' }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
