// Shtark Link — пропуск в звонок (токен LiveKit).
// Проверяет, что сотрудник имеет доступ к чату, и выдаёт подписанный токен комнаты.
// Нужны секреты функции: LIVEKIT_URL (wss://…livekit.cloud), LIVEKIT_API_KEY, LIVEKIT_API_SECRET.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const enc = new TextEncoder();
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Токен доступа LiveKit — обычный JWT (HS256) с правами на комнату
async function livekitToken(key: string, secret: string, identity: string, name: string, room: string) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const claims = {
    iss: key, sub: identity, jti: identity, name, nbf: now - 10, exp: now + 2 * 3600,
    video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
  };
  const data = b64u(enc.encode(JSON.stringify(header))) + '.' + b64u(enc.encode(JSON.stringify(claims)));
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
  return data + '.' + b64u(sig);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('LIVEKIT_URL'), key = Deno.env.get('LIVEKIT_API_KEY'), secret = Deno.env.get('LIVEKIT_API_SECRET');
    if (!url || !key || !secret) return json({ error: 'Звонки ещё не настроены: администратору нужно указать ключи LiveKit.' }, 503);

    const auth = req.headers.get('authorization') || '';
    // Клиент с правами самого сотрудника — проверки доступа идут через RLS-функции
    const asUser = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: u } = await asUser.auth.getUser(auth.replace(/^Bearer\s+/i, ''));
    if (!u?.user) return json({ error: 'Не авторизован' }, 401);

    const { chat } = await req.json().catch(() => ({}));
    const { data: ok } = await asUser.rpc('sl_can_access', { p_chat: String(chat || '') });
    if (!ok) return json({ error: 'Нет доступа к этому чату' }, 403);
    const { data: me } = await asUser.from('sl_profiles').select('name').eq('id', u.user.id).single();

    const room = 'sl-' + String(chat).replace(/[^a-zA-Z0-9-]/g, '_');
    return json({ url, room, token: await livekitToken(key, secret, u.user.id, me?.name || 'Сотрудник', room) });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
