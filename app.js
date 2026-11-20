// Shtark Link — клиент на Supabase.
'use strict';
const CFG = window.SHTARK_CONFIG;
const sb = supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'shtark-link-auth' },
});
const EMAIL_DOMAIN = '@shtark-link.invalid';
const MAX_FILE = 50 * 1024 * 1024;

const $ = (s) => document.querySelector(s);
const state = {
  me: null, users: new Map(), channels: [], groups: new Map(),
  view: 'chat', current: null, messages: new Map(), unread: new Map(), hasMore: new Map(),
  rt: null, db: null, online: new Set(), inCall: new Map(), // userId -> chat
  typingTimers: new Map(), lastTypingSent: 0,
  events: new Map(), loadedRanges: new Set(), calMonth: null, selectedDate: null, calFilter: 'all', reminded: new Set(),
  tasks: new Map(), taskFilter: 'mine', showDone: false, assigneeFilter: '', myTaskEdits: new Map(),
  comments: new Map(), openTaskId: null,
  signed: new Map(), // путь файла -> { url, exp }
  push: { reg: null, sub: null },
};

// ---------- Утилиты ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const linkify = (s) => esc(s).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
const fmtSize = (b) => b < 1024 ? b + ' Б' : b < 1048576 ? (b / 1024).toFixed(1) + ' КБ' : (b / 1048576).toFixed(1) + ' МБ';
const fmtTime = (t) => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const fmtDay = (t) => {
  const d = new Date(t), today = new Date(), y = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return 'Сегодня';
  if (d.toDateString() === y.toDateString()) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
};
const colors = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#6366f1'];
const hash = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };
const userColor = (id) => colors[hash(id) % colors.length];
const initials = (n) => String(n || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const avatar = (u, cls = '') => `<span class="avatar ${cls}" style="background:${userColor(u.id)}">${esc(initials(u.name))}</span>`;
const dmKey = (a, b) => (a < b ? `d:${a}:${b}` : `d:${b}:${a}`);
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const todayYmd = () => ymd(new Date());
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};
const userName = (id) => state.users.get(id)?.name || 'Сотрудник';
const activeUsers = () => [...state.users.values()].filter((u) => !u.disabled);

// Понятные сообщения вместо технических
function humanError(e) {
  const m = String(e?.message || e || 'Ошибка');
  if (/Invalid login credentials/i.test(m)) return 'Неверный логин или пароль';
  if (/banned/i.test(m)) return 'Доступ отключён администратором';
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Нет связи с сервером. Проверьте интернет.';
  if (/row-level security/i.test(m)) return 'Нет прав на это действие';
  if (/duplicate key.*sl_channels_name/i.test(m)) return 'Канал с таким названием уже есть';
  return m;
}
async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args || {});
  if (error) throw new Error(humanError(error));
  return data;
}
async function fn(name, body) {
  const { data: { session } } = await sb.auth.getSession();
  const res = await fetch(`${CFG.supabaseUrl}/functions/v1/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: CFG.supabaseKey, ...(session ? { Authorization: 'Bearer ' + session.access_token } : {}) },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Ошибка сервера');
  return data;
}
const check = ({ data, error }) => { if (error) throw new Error(humanError(error)); return data; };

function toast(text, onClick) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  el.onclick = () => { el.remove(); onClick && onClick(); };
  $('#toast').appendChild(el);
  while ($('#toast').children.length > 4) $('#toast').firstChild.remove();
  setTimeout(() => el.remove(), 8000);
  return el;
}

// ---------- Модальные окна ----------
function openModal(html, onMount, cls = '') {
  state.openTaskId = null;
  $('#modalCard').className = 'modal-card ' + cls;
  $('#modalCard').innerHTML = html;
  $('#modal').classList.remove('hidden');
  onMount && onMount($('#modalCard'));
  const first = $('#modalCard').querySelector('input:not([type=checkbox]), textarea');
  first && first.focus();
}
function closeModal() { state.openTaskId = null; $('#modal').classList.add('hidden'); $('#modalCard').innerHTML = ''; }
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeModal(); $('#lightbox').classList.add('hidden'); }
});

function peoplePicker(exclude = []) {
  const list = activeUsers().filter((u) => u.id !== state.me.id && !exclude.includes(u.id))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  if (!list.length) return '<div class="empty" style="margin:12px 0">Некого добавить</div>';
  return `<div class="people">${list.map((u) => `
    <label class="person"><input type="checkbox" value="${u.id}">${avatar(u, 'sm')}
    <span class="pname">${esc(u.name)}</span><span class="dot ${state.online.has(u.id) ? 'on' : ''}"></span></label>`).join('')}</div>`;
}
const pickedIds = (root) => [...root.querySelectorAll('.people input:checked')].map((i) => i.value);

// ---------- Вход и регистрация ----------
let authMode = 'login';
document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => {
  authMode = b.dataset.mode;
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  $('#nameField').classList.toggle('hidden', authMode !== 'register');
  $('#inviteField').classList.toggle('hidden', authMode !== 'register');
  $('#authSubmit').textContent = authMode === 'login' ? 'Войти' : 'Зарегистрироваться';
  // подсказка браузеру: при входе — подставить сохранённый пароль, при регистрации — предложить сохранить новый
  $('[name=password]').setAttribute('autocomplete', authMode === 'login' ? 'current-password' : 'new-password');
  $('#authError').textContent = '';
});
// запоминаем последний логин, чтобы не вводить его заново
try { const l = localStorage.getItem('lastLogin'); if (l) $('[name=login]').value = l; } catch {}
$('#authForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const login = String(f.login || '').trim().toLowerCase();
  $('#authSubmit').disabled = true;
  $('#authError').textContent = '';
  try {
    if (authMode === 'register') await fn('sl-register', { login, name: f.name, password: f.password, invite: f.invite });
    check(await sb.auth.signInWithPassword({ email: login + EMAIL_DOMAIN, password: f.password }));
    try { localStorage.setItem('lastLogin', login); } catch {}
    await start();
  } catch (err) {
    $('#authError').textContent = humanError(err);
  } finally { $('#authSubmit').disabled = false; }
};
async function logout() {
  try { await leaveCall(); } catch {}
  await sb.auth.signOut().catch(() => {});
  localStorage.removeItem('lastChat');
  location.reload();
}
$('#logoutBtn').onclick = logout;

// ---------- Старт ----------
async function start() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;
  const me = check(await sb.from('sl_profiles').select('*').eq('id', user.id).maybeSingle());
  if (!me || me.disabled) {
    await sb.auth.signOut();
    $('#authError').textContent = me ? 'Доступ отключён администратором' : 'Этот аккаунт не зарегистрирован в Shtark Link';
    return;
  }
  state.me = profileFromRow(me);
  const [users, channels, groups, members] = await Promise.all([
    sb.from('sl_profiles').select('id, login, name, is_admin, disabled'),
    sb.from('sl_channels').select('id, name').order('id'),
    sb.from('sl_groups').select('id, name, created_by'),
    sb.from('sl_group_members').select('group_id, user_id'),
  ]);
  check(users).forEach((u) => state.users.set(u.id, profileFromRow(u)));
  state.channels = check(channels);
  const mem = check(members);
  check(groups).forEach((g) => state.groups.set(g.id, {
    id: g.id, name: g.name, createdBy: g.created_by, members: mem.filter((m) => m.group_id === g.id).map((m) => m.user_id),
  }));

  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#meName').textContent = state.me.name;
  $('#navAdmin').classList.toggle('hidden', !state.me.isAdmin);

  const { data: { session } } = await sb.auth.getSession();
  sb.realtime.setAuth(session.access_token);
  connectRealtime();
  initPush();
  heartbeat();
  setInterval(heartbeat, 20000);

  const now = new Date();
  state.calMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  state.selectedDate = todayYmd();
  loadEventsForMonth(state.calMonth).then(() => { renderSidebar(); checkReminders(); }).catch(() => {});
  state.tasksLoaded = loadTasks().then(() => {
    const overdue = [...state.tasks.values()].filter((t) => t.assigneeId === state.me.id && isOverdue(t)).length;
    if (overdue) toast(`⚠ У вас ${overdue} ${plural(overdue, 'просроченная задача', 'просроченные задачи', 'просроченных задач')}`, () => { setTaskFilter('mine'); openTasks(); });
  }).catch(() => {});
  renderSidebar();
  const last = localStorage.getItem('lastChat');
  if (openDeepLink(location.hash)) history.replaceState(null, '', location.pathname);
  else if (last === 'calendar') openCalendar();
  else if (last === 'tasks') openTasks();
  else openChat(last || `c:${state.channels[0]?.id}`);
  setInterval(checkReminders, 30000);
}

function profileFromRow(u) {
  return { id: u.id, login: u.login, name: u.name, isAdmin: !!u.is_admin, disabled: !!u.disabled };
}

// «Я в приложении» + проверка, что доступ не отключили
let kicked = false;
function heartbeat() {
  if (!state.me || document.hidden || kicked) return;
  rpc('sl_heartbeat').then((active) => {
    if (active === false && !kicked) {
      kicked = true;
      toast('Доступ к Shtark Link отключён администратором');
      setTimeout(logout, 2000);
    }
  }).catch(() => {});
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { heartbeat(); updateTitle(); } });

sb.auth.onAuthStateChange((event, session) => {
  if (event === 'TOKEN_REFRESHED' && session) sb.realtime.setAuth(session.access_token);
  if (event === 'SIGNED_OUT' && state.me) location.reload();
});

// ---------- Realtime ----------
function connectRealtime() {
  let firstDb = true;
  state.db = sb.channel('sl-db')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sl_messages' }, (p) => onMessage(msgFromRow(p.new)))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sl_profiles' }, onProfileChange)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sl_channels' }, (p) => {
      if (!state.channels.some((c) => c.id === p.new.id)) state.channels.push({ id: p.new.id, name: p.new.name });
      renderSidebar();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sl_groups' }, onGroupChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sl_group_members' }, onGroupMemberChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sl_events' }, onEventChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sl_tasks' }, onTaskChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sl_task_comments' }, onCommentChange)
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        if (!firstDb) resync(); // после обрыва связи догружаем пропущенное
        firstDb = false;
      }
    });

  state.rt = sb.channel('sl:main', { config: { private: true, presence: { key: state.me.id }, broadcast: { self: false } } })
    .on('presence', { event: 'sync' }, onPresence)
    .on('broadcast', { event: 'typing' }, ({ payload }) => {
      if (state.view === 'chat' && payload.chat === state.current && payload.userId !== state.me.id) showTyping(payload.userId);
    })
    .on('broadcast', { event: 'call' }, ({ payload }) => onCallSignal(payload))
    .subscribe((status) => {
      if (status !== 'SUBSCRIBED') return;
      state.rt.track({ at: Date.now() }).catch(() => {});
      // спросить, где сейчас идут звонки
      state.rt.send({ type: 'broadcast', event: 'call', payload: { type: 'hello', from: state.me.id } });
      announceCall();
    });
}

// Состояние звонков: каждый участник объявляет «я в звонке X» при входе, выходе и раз в 15 с
const callStates = new Map(); // userId -> { chat, until }
function announceCall() {
  if (!state.rt || !state.me) return;
  state.rt.send({ type: 'broadcast', event: 'call', payload: { type: 'state', chat: call.chat || null, from: state.me.id } });
  rebuildInCall();
}
function rebuildInCall() {
  const now = Date.now();
  state.inCall = new Map();
  for (const [uid, st] of callStates) {
    if (st.until < now || !state.online.has(uid)) callStates.delete(uid);
    else if (st.chat) state.inCall.set(uid, st.chat);
  }
  if (call.chat && state.me) state.inCall.set(state.me.id, call.chat);
}
setInterval(() => {
  if (call.chat) announceCall();
  const before = JSON.stringify([...state.inCall]);
  rebuildInCall();
  if (JSON.stringify([...state.inCall]) !== before) { renderSidebar(); if (state.view === 'chat') renderChatHeader(); }
}, 15000);

function onPresence() {
  const ps = state.rt.presenceState();
  state.online = new Set(Object.keys(ps));
  rebuildInCall();
  renderSidebar();
  if (state.view === 'chat' && state.current) renderChatHeader();
}

async function resync() {
  try {
    if (state.view === 'chat' && state.current) await reloadCurrent();
    state.loadedRanges.clear();
    if (state.calMonth) await loadEventsForMonth(state.calMonth);
    await loadTasks();
    rerenderCalendar();
  } catch {}
}

function onProfileChange(p) {
  if (p.eventType === 'DELETE') return;
  const u = profileFromRow(p.new);
  state.users.set(u.id, u);
  if (u.id === state.me.id) {
    if (u.disabled) { toast('Доступ отключён администратором'); setTimeout(logout, 1500); return; }
    state.me = u;
    $('#navAdmin').classList.toggle('hidden', !u.isAdmin);
  }
  renderSidebar();
  if (state.view === 'admin') renderAdmin();
}

async function onGroupChange(p) {
  if (p.eventType === 'UPDATE') {
    const g = state.groups.get(p.new.id);
    if (g) { g.name = p.new.name; renderSidebar(); if (state.current === `g:${g.id}`) renderChatHeader(); }
  }
}

async function onGroupMemberChange(p) {
  if (p.eventType === 'INSERT') {
    const { group_id: gid, user_id: uid } = p.new;
    const g = state.groups.get(gid);
    if (g) { if (!g.members.includes(uid)) g.members.push(uid); }
    else if (uid === state.me.id) {
      // меня добавили в новый чат
      const grp = check(await sb.from('sl_groups').select('id, name, created_by').eq('id', gid).maybeSingle());
      const mem = check(await sb.from('sl_group_members').select('user_id').eq('group_id', gid));
      if (grp) state.groups.set(gid, { id: gid, name: grp.name, createdBy: grp.created_by, members: mem.map((m) => m.user_id) });
    }
  } else if (p.eventType === 'DELETE') {
    const { group_id: gid, user_id: uid } = p.old;
    const g = state.groups.get(gid);
    if (!g) return;
    if (uid === state.me.id) {
      const chat = `g:${gid}`;
      state.groups.delete(gid); state.messages.delete(chat); state.unread.delete(chat);
      if (state.view === 'chat' && state.current === chat) openChat(`c:${state.channels[0].id}`);
    } else g.members = g.members.filter((m) => m !== uid);
  }
  renderSidebar();
  if (state.view === 'chat' && state.current?.startsWith('g:')) renderChatHeader();
}

function notify(m) {
  updateTitle();
  if (!document.hidden) return;
  const where = m.chat.startsWith('d:') ? '' : ' · ' + chatTitle(m.chat);
  localNotify(userName(m.userId) + where, m.text || (m.file ? '📎 ' + m.file.name : ''), m.chat, `#chat=${m.chat}`, () => openChat(m.chat));
}
function updateTitle() {
  const total = [...state.unread.values()].reduce((a, b) => a + b, 0);
  document.title = total ? `(${total}) Shtark Link` : 'Shtark Link';
}

// ---------- Боковая панель ----------
function chatTitle(chat) {
  if (!chat) return '';
  if (chat.startsWith('c:')) {
    const c = state.channels.find((c) => `c:${c.id}` === chat);
    return c ? '# ' + c.name : '';
  }
  if (chat.startsWith('g:')) return state.groups.get(Number(chat.slice(2)))?.name || '';
  const [, a, b] = chat.split(':');
  const other = state.users.get(a === state.me.id ? b : a);
  return other ? other.name : '';
}
function chatMembers(chat) {
  if (chat.startsWith('c:')) return activeUsers().map((u) => u.id);
  if (chat.startsWith('g:')) return state.groups.get(Number(chat.slice(2)))?.members || [];
  return chat.split(':').slice(1);
}
const callCount = (chat) => [...state.inCall.values()].filter((c) => c === chat).length;

function renderSidebar() {
  if (!state.me) return;
  const item = (chat, label, prefix) => {
    const n = state.unread.get(chat) || 0;
    const active = state.view === 'chat' && chat === state.current;
    const live = callCount(chat) ? '<span class="call-ind" title="Идёт звонок">📞</span>' : '';
    return `<div class="chat-item ${active ? 'active' : ''} ${n ? 'unread' : ''}" data-chat="${chat}">
      ${prefix}<span class="label">${esc(label)}</span>${live}${n ? `<span class="badge">${n}</span>` : ''}</div>`;
  };
  $('#channelList').innerHTML = state.channels.map((c) => item(`c:${c.id}`, c.name, '<span class="ico">#</span>')).join('');
  const groups = [...state.groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  $('#groupList').innerHTML = groups.length
    ? groups.map((g) => item(`g:${g.id}`, g.name, '<span class="ico">👥</span>')).join('')
    : '<div class="side-hint">Нажмите +, чтобы создать</div>';
  const users = activeUsers().sort((a, b) => (state.online.has(b.id) - state.online.has(a.id)) || a.name.localeCompare(b.name, 'ru'));
  $('#userList').innerHTML = users.map((u) =>
    item(dmKey(state.me.id, u.id), u.id === state.me.id ? u.name + ' (вы)' : u.name, `<span class="dot ${state.online.has(u.id) ? 'on' : ''}"></span>`)
  ).join('');
  document.querySelectorAll('.chat-item[data-chat]').forEach((el) => el.onclick = () => openChat(el.dataset.chat));
  $('#navCalendar').classList.toggle('active', state.view === 'calendar');
  $('#navTasks').classList.toggle('active', state.view === 'tasks');
  $('#navAdmin').classList.toggle('active', state.view === 'admin');
  const todayLeft = [...state.events.values()].filter((e) => e.date === todayYmd() && !e.done).length;
  $('#todayBadge').innerHTML = todayLeft ? `<span class="badge soft" title="Невыполненных дел на сегодня">${todayLeft}</span>` : '';
  const myOpen = [...state.tasks.values()].filter((t) => t.assigneeId === state.me.id && t.status !== 'done');
  const myOverdue = myOpen.filter(isOverdue).length;
  $('#tasksBadge').innerHTML = myOpen.length
    ? `<span class="badge ${myOverdue ? '' : 'soft'}" title="${myOverdue ? 'Есть просроченные задачи' : 'Ваши открытые задачи'}">${myOpen.length}</span>` : '';
  updateTitle();
}

document.querySelectorAll('.menuBtn').forEach((b) => b.onclick = () => $('#sidebar').classList.toggle('open'));
$('#navCalendar').onclick = () => openCalendar();
$('#navTasks').onclick = () => openTasks();
$('#navAdmin').onclick = () => openAdmin();

$('#newChannelBtn').onclick = () => openModal(`
  <h3>Новый канал</h3>
  <div class="modal-body">
    <p style="margin:0 0 12px;color:var(--muted);font-size:14px">Канал виден всем сотрудникам.</p>
    <label class="field"><span>Название</span><input id="mName" maxlength="40" placeholder="например, продажи"></label>
    <div class="modal-err" id="mErr"></div>
  </div>
  <div class="modal-foot"><button class="secondary" data-close>Отмена</button><button class="primary" id="mOk">Создать</button></div>`,
  (root) => {
    root.querySelector('[data-close]').onclick = closeModal;
    const ok = async () => {
      const name = root.querySelector('#mName').value.trim().toLowerCase().replace(/\s+/g, '-');
      if (!name) return;
      try {
        const c = check(await sb.from('sl_channels').insert({ name, created_by: state.me.id }).select('id, name').single());
        if (!state.channels.some((x) => x.id === c.id)) state.channels.push(c);
        closeModal(); openChat(`c:${c.id}`);
      } catch (e) { root.querySelector('#mErr').textContent = humanError(e); }
    };
    root.querySelector('#mOk').onclick = ok;
    root.querySelector('#mName').onkeydown = (e) => e.key === 'Enter' && ok();
  });

// ---------- Групповые чаты ----------
$('#newGroupBtn').onclick = () => openModal(`
  <h3>Новый чат</h3>
  <div class="modal-body">
    <label class="field"><span>Название чата</span><input id="mName" maxlength="60" placeholder="например, Проект «Альфа»"></label>
    <div class="field"><span>Участники</span>${peoplePicker()}</div>
    <div class="modal-err" id="mErr"></div>
  </div>
  <div class="modal-foot"><button class="secondary" data-close>Отмена</button><button class="primary" id="mOk">Создать чат</button></div>`,
  (root) => {
    root.querySelector('[data-close]').onclick = closeModal;
    root.querySelector('#mOk').onclick = async () => {
      try {
        const members = pickedIds(root);
        const gid = await rpc('sl_create_group', { p_name: root.querySelector('#mName').value, p_members: members });
        state.groups.set(gid, { id: gid, name: root.querySelector('#mName').value.trim(), createdBy: state.me.id, members: [state.me.id, ...members] });
        closeModal(); openChat(`g:${gid}`);
      } catch (e) { root.querySelector('#mErr').textContent = humanError(e); }
    };
  });

function openGroupSettings(groupId) {
  const g = state.groups.get(groupId);
  if (!g) return;
  const members = g.members.map((id) => state.users.get(id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  openModal(`
    <h3>Настройки чата</h3>
    <div class="modal-body">
      <label class="field"><span>Название</span>
        <div class="row" style="gap:8px"><input id="mName" maxlength="60" value="${esc(g.name)}"><button class="secondary" id="mRename">Сохранить</button></div></label>
      <div class="field"><span>Участники (${members.length})</span>
        <div class="people">${members.map((u) => `<div class="person" style="cursor:default">${avatar(u, 'sm')}
          <span class="pname">${esc(u.name)}${u.id === state.me.id ? ' (вы)' : ''}${u.id === g.createdBy ? ' <span class="tag shared">создатель</span>' : ''}</span>
          <span class="dot ${state.online.has(u.id) ? 'on' : ''}"></span></div>`).join('')}</div></div>
      <div class="field"><span>Добавить участников</span>${peoplePicker(g.members)}</div>
      <div class="modal-err" id="mErr"></div>
    </div>
    <div class="modal-foot"><button class="danger" id="mLeave">Покинуть чат</button><span class="spacer"></span>
      <button class="secondary" data-close>Закрыть</button><button class="primary" id="mAdd">Добавить</button></div>`,
    (root) => {
      const err = (e) => root.querySelector('#mErr').textContent = humanError(e);
      root.querySelector('[data-close]').onclick = closeModal;
      root.querySelector('#mRename').onclick = async () => {
        try { await rpc('sl_rename_group', { p_group: g.id, p_name: root.querySelector('#mName').value }); g.name = root.querySelector('#mName').value.trim(); closeModal(); renderChatHeader(); renderSidebar(); }
        catch (e) { err(e); }
      };
      root.querySelector('#mAdd').onclick = async () => {
        const ids = pickedIds(root);
        if (!ids.length) return err('Отметьте, кого добавить');
        try { await rpc('sl_add_group_members', { p_group: g.id, p_members: ids }); ids.forEach((id) => g.members.includes(id) || g.members.push(id)); closeModal(); renderChatHeader(); }
        catch (e) { err(e); }
      };
      root.querySelector('#mLeave').onclick = async () => {
        if (!confirm(`Покинуть чат «${g.name}»? Историю переписки вы больше не увидите.`)) return;
        try {
          await rpc('sl_leave_group', { p_group: g.id });
          closeModal();
          state.groups.delete(g.id);
          openChat(`c:${state.channels[0].id}`);
        } catch (e) { err(e); }
      };
    });
}

// ---------- Переписка ----------
function showView(view) {
  state.view = view;
  $('#chatView').classList.toggle('hidden', view !== 'chat');
  $('#calView').classList.toggle('hidden', view !== 'calendar');
  $('#taskView').classList.toggle('hidden', view !== 'tasks');
  $('#adminView').classList.toggle('hidden', view !== 'admin');
  $('#sidebar').classList.remove('open');
}

function renderChatHeader() {
  const chat = state.current;
  if (!chat) return;
  $('#chatTitle').innerHTML = esc(chatTitle(chat));
  let actions = '';
  const n = callCount(chat);
  const callBtn = call.chat === chat ? ''
    : n ? `<button class="hbtn" id="callBtn" style="border-color:#22c55e;color:#16a34a">📞 Присоединиться (${n})</button>`
    : `<button class="hbtn" id="callBtn" title="Голосовой звонок">📞 ${chat.startsWith('d:') ? 'Позвонить' : 'Созвон'}</button>`;
  if (chat.startsWith('g:')) {
    const g = state.groups.get(Number(chat.slice(2)));
    if (g) actions = `<button class="hbtn" id="groupBtn">👥 ${g.members.length} ${plural(g.members.length, 'участник', 'участника', 'участников')}</button>`;
  } else if (chat.startsWith('d:')) {
    const [, a, b] = chat.split(':');
    const other = state.users.get(a === state.me.id ? b : a);
    if (other && other.id !== state.me.id) {
      $('#chatTitle').innerHTML += `<span class="sub">${state.online.has(other.id) ? 'в сети' : 'не в сети'}</span>`;
      actions = `<button class="hbtn" id="assignBtn" data-uid="${other.id}">📋 Поручить задачу</button>`;
    }
  }
  const self = chat.startsWith('d:') && chat.split(':')[1] === chat.split(':')[2];
  $('#chatActions').innerHTML = (self ? '' : callBtn) + ' ' + actions;
  $('#chatActions').style.display = 'flex';
  $('#chatActions').style.gap = '8px';
  const gb = $('#groupBtn');
  if (gb) gb.onclick = () => openGroupSettings(Number(chat.slice(2)));
  const ab = $('#assignBtn');
  if (ab) ab.onclick = () => openTaskForm({ assigneeId: ab.dataset.uid });
  const cb = $('#callBtn');
  if (cb) cb.onclick = () => joinCall(chat);
}

function msgFromRow(r) {
  return { id: r.id, chat: r.chat, userId: r.user_id, text: r.text, file: r.file, system: r.system, createdAt: Date.parse(r.created_at) };
}
async function fetchMessages(chat, beforeId) {
  let q = sb.from('sl_messages').select('*').eq('chat', chat).order('id', { ascending: false }).limit(50);
  if (beforeId) q = q.lt('id', beforeId);
  return check(await q).reverse().map(msgFromRow);
}

function onMessage(m) {
  const list = state.messages.get(m.chat);
  if (list && !list.some((x) => x.id === m.id)) list.push(m);
  const visible = state.view === 'chat' && m.chat === state.current;
  if (visible) { appendMessage(m); clearTyping(m.userId); }
  if (m.userId !== state.me.id && !m.system && (!visible || document.hidden)) {
    if (!visible) state.unread.set(m.chat, (state.unread.get(m.chat) || 0) + 1);
    notify(m);
    renderSidebar();
  }
}

async function openChat(chat) {
  if (!chat || !chatTitle(chat)) chat = `c:${state.channels[0]?.id}`;
  showView('chat');
  state.current = chat;
  localStorage.setItem('lastChat', chat);
  state.unread.delete(chat);
  renderChatHeader();
  $('#typing').textContent = '';
  renderSidebar();
  if (!state.messages.has(chat)) {
    $('#messages').innerHTML = '';
    try {
      const msgs = await fetchMessages(chat);
      state.messages.set(chat, msgs);
      state.hasMore.set(chat, msgs.length === 50);
    } catch (e) { toast(humanError(e)); return; }
  }
  if (state.current !== chat || state.view !== 'chat') return;
  renderMessages(true);
  $('#input').focus();
}

async function reloadCurrent() {
  const chat = state.current;
  const msgs = await fetchMessages(chat);
  state.messages.set(chat, msgs);
  if (state.current === chat && state.view === 'chat') renderMessages(true);
}

function isImage(f) { return /^image\/(png|jpe?g|gif|webp|bmp)$/.test(f?.mime || ''); }

function messageHtml(m, prev) {
  const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
  const dayHtml = newDay ? `<div class="day">${fmtDay(m.createdAt)}</div>` : '';
  if (m.system) return dayHtml + `<div class="sys" data-id="${m.id}">${esc(m.text)} · ${fmtTime(m.createdAt)}</div>`;
  const u = state.users.get(m.userId) || { name: 'Сотрудник', id: m.userId };
  const cont = !newDay && prev && !prev.system && prev.userId === m.userId && m.createdAt - prev.createdAt < 5 * 60e3;
  let file = '';
  if (m.file) {
    const f = m.file;
    if (isImage(f)) {
      file = `<img class="img-preview" data-path="${esc(f.path)}" alt="${esc(f.name)}">
        <a class="file-card" href="#" data-path="${esc(f.path)}" data-name="${esc(f.name)}" style="padding:4px 10px"><span class="fsize">⬇ ${esc(f.name)} · ${fmtSize(f.size)}</span></a>`;
    } else {
      const ext = (f.name.includes('.') ? f.name.split('.').pop() : '').slice(0, 4).toUpperCase();
      file = `<a class="file-card" href="#" data-path="${esc(f.path)}" data-name="${esc(f.name)}"><span class="file-icon">${esc(ext || 'FILE')}</span>
        <span style="min-width:0"><div class="fname">${esc(f.name)}</div><div class="fsize">${fmtSize(f.size)} · скачать</div></span></a>`;
    }
  }
  return dayHtml +
    `<div class="msg ${cont ? 'cont' : ''}" data-id="${m.id}">
      ${avatar(u)}
      <div class="body">
        <div class="meta"><b>${esc(u.name)}${u.disabled ? ' <span class="muted">(отключён)</span>' : ''}</b><span>${fmtTime(m.createdAt)}</span></div>
        ${m.text ? `<div class="text">${linkify(m.text)}</div>` : ''}
        ${file}
      </div></div>`;
}

// Временные ссылки на файлы (хранилище закрытое)
async function signedUrls(paths) {
  const now = Date.now(), need = [...new Set(paths)].filter((p) => !(state.signed.get(p)?.exp > now + 60e3));
  if (need.length) {
    const { data } = await sb.storage.from('sl-files').createSignedUrls(need, 3600);
    (data || []).forEach((d) => d.signedUrl && state.signed.set(d.path, { url: d.signedUrl, exp: now + 3600e3 }));
  }
  return paths.map((p) => state.signed.get(p)?.url);
}
async function hydrateImages(root) {
  const imgs = [...root.querySelectorAll('img.img-preview[data-path]:not([src])')];
  if (!imgs.length) return;
  const urls = await signedUrls(imgs.map((i) => i.dataset.path)).catch(() => []);
  const box = $('#messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 150;
  imgs.forEach((img, i) => {
    if (!urls[i]) return;
    img.onload = () => { if (atBottom) box.scrollTop = box.scrollHeight; };
    img.src = urls[i];
  });
}

function renderMessages(scrollBottom) {
  const list = state.messages.get(state.current) || [];
  const box = $('#messages');
  box.innerHTML = list.length
    ? list.map((m, i) => messageHtml(m, list[i - 1])).join('')
    : '<div class="empty">Сообщений пока нет. Напишите первым!</div>';
  if (scrollBottom) box.scrollTop = box.scrollHeight;
  hydrateImages(box);
}

function appendMessage(m) {
  const list = state.messages.get(state.current) || [];
  const box = $('#messages');
  if (box.querySelector(`[data-id="${m.id}"]`)) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 150 || m.userId === state.me.id;
  if (box.querySelector('.empty')) box.innerHTML = '';
  const idx = list.findIndex((x) => x.id === m.id);
  box.insertAdjacentHTML('beforeend', messageHtml(m, list[idx - 1]));
  if (nearBottom) box.scrollTop = box.scrollHeight;
  hydrateImages(box);
}

$('#messages').addEventListener('scroll', async (e) => {
  const box = e.target, chat = state.current;
  if (box.scrollTop > 50 || !state.hasMore.get(chat) || box.dataset.loading) return;
  const list = state.messages.get(chat);
  if (!list || !list.length) return;
  box.dataset.loading = '1';
  try {
    const older = await fetchMessages(chat, list[0].id);
    state.hasMore.set(chat, older.length === 50);
    if (older.length && state.current === chat) {
      state.messages.set(chat, older.concat(list));
      const h = box.scrollHeight;
      renderMessages(false);
      box.scrollTop = box.scrollHeight - h;
    }
  } catch {} finally { delete box.dataset.loading; }
});

$('#messages').addEventListener('click', async (e) => {
  const img = e.target.closest('.img-preview');
  if (img && img.src) {
    $('#lightbox img').src = img.src;
    $('#lightbox').classList.remove('hidden');
    return;
  }
  const card = e.target.closest('.file-card[data-path]');
  if (card) {
    e.preventDefault();
    if (card.dataset.busy) return;
    card.dataset.busy = '1';
    const label = card.querySelector('.fsize');
    const old = label?.textContent;
    if (label) label.textContent = 'скачивание…';
    try {
      // Скачиваем в память и сохраняем под исходным именем (кириллица сохраняется)
      const { data, error } = await sb.storage.from('sl-files').download(card.dataset.path);
      if (error) throw error;
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url; a.download = card.dataset.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (err) { toast('Не удалось скачать файл: ' + humanError(err)); }
    finally { delete card.dataset.busy; if (label) label.textContent = old; }
  }
});
$('#lightbox').onclick = () => $('#lightbox').classList.add('hidden');

async function send() {
  const text = $('#input').value.trim();
  if (!text) return;
  const chat = state.current;
  $('#input').value = '';
  autosize();
  try {
    const row = check(await sb.from('sl_messages').insert({ chat, user_id: state.me.id, text }).select().single());
    onMessage(msgFromRow(row));
  } catch (e) {
    $('#input').value = text; autosize();
    toast('Сообщение не отправлено: ' + humanError(e));
  }
}
$('#sendBtn').onclick = send;
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
$('#input').addEventListener('input', () => {
  autosize();
  if (Date.now() - state.lastTypingSent > 2500 && state.rt) {
    state.lastTypingSent = Date.now();
    state.rt.send({ type: 'broadcast', event: 'typing', payload: { chat: state.current, userId: state.me.id } });
  }
});
function autosize() { const t = $('#input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 160) + 'px'; }

function showTyping(userId) {
  clearTimeout(state.typingTimers.get(userId));
  state.typingTimers.set(userId, setTimeout(() => clearTyping(userId), 3500));
  renderTyping();
}
function clearTyping(userId) { clearTimeout(state.typingTimers.get(userId)); state.typingTimers.delete(userId); renderTyping(); }
function renderTyping() {
  const names = [...state.typingTimers.keys()].map((id) => state.users.get(id)?.name).filter(Boolean);
  $('#typing').textContent = names.length ? names.join(', ') + (names.length > 1 ? ' печатают…' : ' печатает…') : '';
}

// ---------- Файлы ----------
async function uploadFile(file) {
  const chat = state.current;
  const row = document.createElement('div');
  row.className = 'upload-row';
  row.innerHTML = `📎 ${esc(file.name)} (${fmtSize(file.size)})<progress max="100" value="0"></progress>`;
  $('#uploads').appendChild(row);
  const fail = (msg) => { row.innerHTML = `⚠ ${esc(file.name)}: ${esc(msg)}`; setTimeout(() => row.remove(), 6000); };
  if (file.size > MAX_FILE) return fail('файл больше 50 МБ');
  const ext = (file.name.match(/\.([a-z0-9]{1,8})$/i)?.[1] || 'bin').toLowerCase();
  const path = `${chat.replace(/:/g, '_')}/${crypto.randomUUID()}.${ext}`;
  const { data: { session } } = await sb.auth.getSession();
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `${CFG.supabaseUrl}/storage/v1/object/sl-files/${path}`);
  xhr.setRequestHeader('Authorization', 'Bearer ' + session.access_token);
  xhr.setRequestHeader('apikey', CFG.supabaseKey);
  xhr.setRequestHeader('x-upsert', 'false');
  xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) row.querySelector('progress').value = e.loaded / e.total * 100; };
  xhr.onerror = () => fail('нет связи');
  xhr.onload = async () => {
    if (xhr.status !== 200) {
      let msg = 'ошибка загрузки';
      try { const j = JSON.parse(xhr.responseText); msg = /exceeded|too large/i.test(j.message || j.error) ? 'файл слишком большой' : (j.message || j.error || msg); } catch {}
      return fail(msg);
    }
    try {
      const r = check(await sb.from('sl_messages').insert({
        chat, user_id: state.me.id, text: '',
        file: { path, name: file.name, mime: file.type || 'application/octet-stream', size: file.size },
      }).select().single());
      row.remove();
      onMessage(msgFromRow(r));
    } catch (e) { fail(humanError(e)); }
  };
  xhr.send(file);
}
$('#attachBtn').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = (e) => { [...e.target.files].forEach(uploadFile); e.target.value = ''; };

let dragDepth = 0;
const chatView = $('#chatView');
chatView.addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { dragDepth++; $('#drop').classList.remove('hidden'); } });
chatView.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').classList.add('hidden'); } });
chatView.addEventListener('dragover', (e) => e.preventDefault());
chatView.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('#drop').classList.add('hidden');
  [...e.dataTransfer.files].forEach(uploadFile);
});
$('#input').addEventListener('paste', (e) => {
  const files = [...e.clipboardData.files];
  if (files.length) { e.preventDefault(); files.forEach(uploadFile); }
});

// ---------- Календарь ----------
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const eventFromRow = (e) => ({ id: e.id, userId: e.user_id, title: e.title, note: e.note, date: e.date, time: e.time, shared: e.shared, done: e.done });

function gridRange(month) {
  const start = new Date(month);
  start.setDate(1 - ((start.getDay() + 6) % 7));
  const end = new Date(start);
  end.setDate(start.getDate() + 41);
  return [start, end];
}
async function loadEventsForMonth(month) {
  const [from, to] = gridRange(month).map(ymd);
  const key = from + '_' + to;
  if (state.loadedRanges.has(key)) return;
  const list = check(await sb.from('sl_events').select('*').gte('date', from).lte('date', to));
  for (const [id, e] of state.events) if (e.date >= from && e.date <= to) state.events.delete(id);
  list.forEach((e) => state.events.set(e.id, eventFromRow(e)));
  state.loadedRanges.add(key);
}
function onEventChange(p) {
  if (p.eventType === 'DELETE') { state.events.delete(p.old.id); rerenderCalendar(); return; }
  const e = eventFromRow(p.new);
  const isNew = !state.events.has(e.id);
  state.events.set(e.id, e);
  if (isNew && p.eventType === 'INSERT' && e.shared && e.userId !== state.me.id) {
    toast(`📅 ${userName(e.userId)} добавил(а) общее дело на ${parseYmd(e.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}: «${e.title}»`,
      () => { state.selectedDate = e.date; state.calMonth = parseYmd(e.date); state.calMonth.setDate(1); openCalendar(); });
  }
  rerenderCalendar();
}
function visibleEvents() {
  return [...state.events.values()].filter((e) =>
    state.calFilter === 'all' || (state.calFilter === 'mine' ? e.userId === state.me.id : e.shared));
}
const sortEvents = (a, b) => (a.done - b.done) || ((a.time || '') < (b.time || '') ? -1 : (a.time || '') > (b.time || '') ? 1 : a.id - b.id);

async function openCalendar() {
  showView('calendar');
  localStorage.setItem('lastChat', 'calendar');
  renderSidebar();
  renderCalendar();
  await loadEventsForMonth(state.calMonth).catch(() => {});
  renderCalendar();
}
function rerenderCalendar() {
  renderSidebar();
  if (state.view === 'calendar') renderCalendar();
}
function renderCalendar() {
  const month = state.calMonth;
  $('#calMonth').textContent = `${MONTHS[month.getMonth()]} ${month.getFullYear()}`;
  const [start] = gridRange(month);
  const byDate = new Map();
  visibleEvents().forEach((e) => { if (!byDate.has(e.date)) byDate.set(e.date, []); byDate.get(e.date).push(e); });
  const tasksByDate = new Map();
  calendarTasks().forEach((t) => { if (!tasksByDate.has(t.dueDate)) tasksByDate.set(t.dueDate, []); tasksByDate.get(t.dueDate).push(t); });
  const today = todayYmd();
  let html = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const key = ymd(d);
    const evs = (byDate.get(key) || []).sort(sortEvents);
    const tks = tasksByDate.get(key) || [];
    const chips = [
      ...tks.map((t) => `<div class="chip tk ${t.status === 'done' ? 'done' : ''} ${isOverdue(t) ? 'overdue' : ''}" title="Задача: ${esc(t.title)}">📋 ${esc(t.title)}</div>`),
      ...evs.map((e) => `<div class="chip ${e.shared ? 'shared' : ''} ${e.done ? 'done' : ''}" title="${esc(e.title)}">${e.time ? e.time + ' ' : ''}${esc(e.title)}</div>`),
    ];
    const dots = [...tks.map(() => 'tk'), ...evs.map((e) => e.shared ? 'shared' : '')];
    const cls = ['cell'];
    if (d.getMonth() !== month.getMonth()) cls.push('other');
    if (key === today) cls.push('today');
    if (key === state.selectedDate) cls.push('selected');
    if (d.getDay() === 0 || d.getDay() === 6) cls.push('weekend');
    html += `<div class="${cls.join(' ')}" data-date="${key}">
      <span class="num">${d.getDate()}</span>
      ${chips.slice(0, 3).join('')}
      ${chips.length > 3 ? `<div class="more">ещё ${chips.length - 3}</div>` : ''}
      ${dots.length ? `<div class="dots">${dots.slice(0, 4).map((c) => `<i class="${c}"></i>`).join('')}</div>` : ''}
    </div>`;
  }
  $('#calGrid').innerHTML = html;
  $('#calGrid').querySelectorAll('.cell').forEach((c) => {
    c.onclick = () => { state.selectedDate = c.dataset.date; renderCalendar(); };
    c.ondblclick = () => openEventForm({ date: c.dataset.date });
  });
  renderDayPanel();
}
function renderDayPanel() {
  const date = state.selectedDate;
  const d = parseYmd(date);
  const title = d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  $('#dayTitle').textContent = (date === todayYmd() ? 'Сегодня, ' : '') + title;
  const evs = visibleEvents().filter((e) => e.date === date).sort(sortEvents);
  const left = evs.filter((e) => !e.done).length;
  const tks = calendarTasks().filter((t) => t.dueDate === date);
  $('#dayCount').textContent = (evs.length
    ? `${evs.length} ${plural(evs.length, 'дело', 'дела', 'дел')}, ${left ? 'осталось ' + left : 'всё выполнено ✓'}`
    : 'Дел нет') + (tks.length ? ` · ${tks.length} ${plural(tks.length, 'задача', 'задачи', 'задач')} со сроком` : '');
  $('#dayList').innerHTML = evs.map((e) => {
    const mine = e.userId === state.me.id;
    return `<div class="ev ${e.shared ? 'shared' : ''} ${e.done ? 'done' : ''}" data-id="${e.id}">
      <input type="checkbox" ${e.done ? 'checked' : ''} title="Выполнено">
      <div class="ev-body">
        <div class="ev-title">${esc(e.title)}</div>
        ${e.note ? `<div class="ev-note">${linkify(e.note)}</div>` : ''}
        <div class="ev-meta">
          <span class="ev-time">${e.time || 'Весь день'}</span>
          <span class="tag ${e.shared ? 'shared' : ''}">${e.shared ? 'Общее' : 'Личное'}</span>
          ${!mine ? `<span>от ${esc(userName(e.userId))}</span>` : ''}
        </div>
      </div>
      ${mine ? `<div class="ev-actions"><button data-edit title="Изменить">✏️</button><button data-del title="Удалить">🗑</button></div>` : ''}
    </div>`;
  }).join('') + (tks.length ? `<div class="panel-sub">Задачи со сроком</div>` + tks.map((t) => `
    <div class="ev tk ${t.status === 'done' ? 'done' : ''}" data-task="${t.id}">
      <span>📋</span>
      <div class="ev-body">
        <div class="ev-title">${t.priority ? '<span class="prio">!</span> ' : ''}${esc(t.title)}</div>
        <div class="ev-meta"><span class="ev-time">${t.dueTime ? 'до ' + t.dueTime : 'до конца дня'}</span>
          <span class="st ${t.status}">${STATUS_LABEL[t.status]}</span>
          <span>${t.assigneeId === state.me.id ? 'исполняете вы' : 'исполнитель: ' + esc(userName(t.assigneeId))}</span></div>
      </div></div>`).join('') : '');
  $('#dayList').querySelectorAll('[data-task]').forEach((el) => el.onclick = () => openTaskView(Number(el.dataset.task)));
  $('#dayList').querySelectorAll('.ev:not(.tk)').forEach((el) => {
    const id = Number(el.dataset.id);
    el.querySelector('input').onchange = (ev) => setEventDone(id, ev.target.checked);
    const edit = el.querySelector('[data-edit]');
    if (edit) edit.onclick = () => openEventForm(state.events.get(id));
    const del = el.querySelector('[data-del]');
    if (del) del.onclick = () => deleteEvent(id);
  });
}
async function setEventDone(id, done) {
  try { await rpc('sl_set_event_done', { p_id: id, p_done: done }); const e = state.events.get(id); if (e) e.done = done; }
  catch (err) { toast(humanError(err)); }
  rerenderCalendar();
}
async function deleteEvent(id) {
  const e = state.events.get(id);
  if (!e || !confirm(`Удалить «${e.title}»?`)) return;
  try { check(await sb.from('sl_events').delete().eq('id', id)); state.events.delete(id); }
  catch (err) { toast(humanError(err)); }
  rerenderCalendar();
}
function openEventForm(ev = {}) {
  const isNew = !ev.id;
  openModal(`
    <h3>${isNew ? 'Новое дело' : 'Изменить дело'}</h3>
    <div class="modal-body">
      <label class="field"><span>Что сделать</span><input id="eTitle" maxlength="200" value="${esc(ev.title || '')}" placeholder="например, Созвон с поставщиком"></label>
      <div class="row">
        <label class="field"><span>Дата</span><input id="eDate" type="date" value="${ev.date || state.selectedDate || todayYmd()}"></label>
        <label class="field"><span>Время (необязательно)</span><input id="eTime" type="time" value="${ev.time || ''}"></label>
      </div>
      <label class="field"><span>Заметка</span><textarea id="eNote" maxlength="4000" placeholder="Подробности, ссылки…">${esc(ev.note || '')}</textarea></label>
      <label class="check"><input type="checkbox" id="eShared" ${ev.shared ? 'checked' : ''}> Видно всей команде (общее дело)</label>
      <div class="modal-err" id="mErr"></div>
    </div>
    <div class="modal-foot">
      ${isNew ? '' : '<button class="danger" id="eDel">Удалить</button>'}<span class="spacer"></span>
      <button class="secondary" data-close>Отмена</button><button class="primary" id="eSave">${isNew ? 'Добавить' : 'Сохранить'}</button>
    </div>`,
    (root) => {
      root.querySelector('[data-close]').onclick = closeModal;
      const save = async () => {
        const body = {
          title: root.querySelector('#eTitle').value.trim(),
          date: root.querySelector('#eDate').value,
          time: root.querySelector('#eTime').value || null,
          note: root.querySelector('#eNote').value,
          shared: root.querySelector('#eShared').checked,
        };
        if (!body.title) return root.querySelector('#mErr').textContent = 'Укажите название';
        if (!body.date) return root.querySelector('#mErr').textContent = 'Укажите дату';
        try {
          const row = isNew
            ? check(await sb.from('sl_events').insert({ ...body, user_id: state.me.id }).select().single())
            : check(await sb.from('sl_events').update(body).eq('id', ev.id).select().single());
          const e = eventFromRow(row);
          state.events.set(e.id, e);
          state.selectedDate = e.date;
          const m = parseYmd(e.date); m.setDate(1);
          if (m.getTime() !== state.calMonth.getTime()) { state.calMonth = m; await loadEventsForMonth(m); }
          closeModal();
          rerenderCalendar();
        } catch (err) { root.querySelector('#mErr').textContent = humanError(err); }
      };
      root.querySelector('#eSave').onclick = save;
      root.querySelector('#eTitle').onkeydown = (e) => e.key === 'Enter' && save();
      const del = root.querySelector('#eDel');
      if (del) del.onclick = () => { closeModal(); deleteEvent(ev.id); };
    });
}
async function shiftMonth(delta) {
  const m = new Date(state.calMonth);
  m.setMonth(m.getMonth() + delta);
  state.calMonth = m;
  renderCalendar();
  await loadEventsForMonth(m).catch(() => {});
  renderCalendar();
}
$('#calPrev').onclick = () => shiftMonth(-1);
$('#calNext').onclick = () => shiftMonth(1);
$('#calToday').onclick = async () => {
  const now = new Date();
  state.calMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  state.selectedDate = todayYmd();
  renderCalendar();
  await loadEventsForMonth(state.calMonth).catch(() => {});
  renderCalendar();
};
$('#calAdd').onclick = () => openEventForm({ date: state.selectedDate });
$('#dayAdd').onclick = () => openEventForm({ date: state.selectedDate });
$('#calFilter').querySelectorAll('button').forEach((b) => b.onclick = () => {
  state.calFilter = b.dataset.f;
  $('#calFilter').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
  renderCalendar();
});

// ---------- Задачи ----------
const STATUS_LABEL = { new: 'Новая', in_progress: 'В работе', done: 'Выполнена' };
const taskFromRow = (t, commentCount = 0) => ({
  id: t.id, title: t.title, description: t.description, createdBy: t.created_by, assigneeId: t.assignee_id,
  dueDate: t.due_date, dueTime: t.due_time, priority: t.priority, status: t.status,
  createdAt: Date.parse(t.created_at), updatedAt: Date.parse(t.updated_at), completedAt: t.completed_at ? Date.parse(t.completed_at) : null,
  commentCount: t.comment_count ?? commentCount,
});
async function loadTasks() {
  const list = check(await sb.from('sl_tasks_v').select('*').order('due_date'));
  state.tasks = new Map(list.map((t) => [t.id, taskFromRow(t)]));
  rerenderTasks();
}
const dueMoment = (t) => { const d = parseYmd(t.dueDate); if (t.dueTime) { const [h, m] = t.dueTime.split(':'); d.setHours(+h, +m); } else d.setHours(23, 59, 59); return d; };
const isOverdue = (t) => t.status !== 'done' && dueMoment(t) < new Date();
const daysUntil = (t) => Math.round((parseYmd(t.dueDate) - parseYmd(todayYmd())) / 864e5);
const canEditTask = (t) => t.createdBy === state.me.id;
const canChangeStatus = (t) => t.createdBy === state.me.id || t.assigneeId === state.me.id;
// Свои правки: пока запрос в пути — id в pending; после — запоминаем версию (updated_at) записи
const pendingTaskEdits = new Set();
const markMyEdit = (row) => state.myTaskEdits.set(row.id, row.updated_at);
const isMyEdit = (row) => pendingTaskEdits.has(row.id) || state.myTaskEdits.get(row.id) === row.updated_at;
async function myTaskEdit(id, fnc) {
  pendingTaskEdits.add(id);
  try { const row = await fnc(); if (row?.updated_at) markMyEdit(row); return row; }
  finally { setTimeout(() => pendingTaskEdits.delete(id), 300); }
}

function dueLabel(t) {
  const n = daysUntil(t);
  const time = t.dueTime ? ', ' + t.dueTime : '';
  const date = parseYmd(t.dueDate).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  if (t.status === 'done') return { text: `срок ${date}${time}`, cls: '' };
  if (isOverdue(t)) {
    const late = -n;
    return { text: late > 0 ? `просрочено на ${late} ${plural(late, 'день', 'дня', 'дней')} (${date})` : `просрочено (сегодня${time})`, cls: 'overdue' };
  }
  if (n === 0) return { text: `сегодня${time}`, cls: 'soon' };
  if (n === 1) return { text: `завтра${time}`, cls: 'soon' };
  return { text: `до ${date}${time}`, cls: '' };
}
function calendarTasks() {
  if (state.calFilter === 'shared') return [];
  return [...state.tasks.values()].filter((t) => t.assigneeId === state.me.id || t.createdBy === state.me.id);
}

// Изменение задачи пришло из базы
function onTaskChange(p) {
  if (p.eventType === 'DELETE') {
    const old = state.tasks.get(p.old.id);
    state.tasks.delete(p.old.id);
    if (state.openTaskId === p.old.id) closeModal();
    if (old && old.assigneeId === state.me.id && old.createdBy !== state.me.id && !pendingTaskEdits.has(old.id)) {
      toast(`📋 ${userName(old.createdBy)} отменил(а) задачу «${old.title}»`);
    }
    rerenderTasks();
    return;
  }
  const prev = state.tasks.get(p.new.id);
  const t = taskFromRow(p.new, prev?.commentCount || 0);
  state.tasks.set(t.id, t);
  const mine = isMyEdit(p.new) || (!prev && t.createdBy === state.me.id);
  // кто изменил: для чужих правок — «другая сторона» задачи
  const actorId = mine ? state.me.id : !prev ? t.createdBy : (t.createdBy === state.me.id ? t.assigneeId : t.createdBy);
  const change = !prev ? 'created' : prev.assigneeId !== t.assigneeId ? 'reassigned' : prev.status !== t.status ? 'status' : 'updated';
  onTaskUpserted({ task: t, actorId, change, prevAssigneeId: prev?.assigneeId });
}

function onTaskUpserted(ev) {
  const t = ev.task;
  if (state.openTaskId === t.id && ev.actorId !== state.me.id) openTaskView(t.id);
  const actorName = userName(ev.actorId);
  const fromOther = ev.actorId !== state.me.id;
  const open = () => openTaskView(t.id);
  let msg = null;
  if (fromOther && t.assigneeId === state.me.id && (ev.change === 'created' || ev.change === 'reassigned')) {
    msg = `📋 ${actorName} поручил(а) вам задачу «${t.title}» — ${dueLabel(t).text}`;
  } else if (fromOther && ev.change === 'reassigned' && ev.prevAssigneeId === state.me.id) {
    msg = `📋 Задача «${t.title}» передана другому исполнителю`;
  } else if (fromOther && ev.change === 'status' && t.createdBy === state.me.id) {
    msg = t.status === 'done' ? `✅ ${actorName} выполнил(а) задачу «${t.title}»`
      : t.status === 'in_progress' ? `▶ ${actorName} взял(а) в работу «${t.title}»` : `↩ Задача «${t.title}» снова открыта`;
  } else if (fromOther && ev.change === 'status' && t.assigneeId === state.me.id && t.status !== 'done') {
    msg = `↩ ${actorName} вернул(а) вам задачу «${t.title}»`;
  } else if (fromOther && ev.change === 'updated' && t.assigneeId === state.me.id) {
    msg = `✏️ ${actorName} изменил(а) задачу «${t.title}» — ${dueLabel(t).text}`;
  }
  if (msg) {
    toast(msg, open);
    localNotify('Задачи', msg, 'task' + t.id, `#task=${t.id}`, open);
  }
  rerenderTasks();
}
function rerenderTasks() {
  renderSidebar();
  if (state.view === 'tasks') renderTasks();
  if (state.view === 'calendar') renderCalendar();
}
function openTasks() {
  showView('tasks');
  localStorage.setItem('lastChat', 'tasks');
  renderSidebar();
  renderTasks();
}
function setTaskFilter(f) {
  state.taskFilter = f;
  $('#taskFilter').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x.dataset.f === f));
}
function renderTasks() {
  const f = state.taskFilter;
  $('#assigneeFilterWrap').classList.toggle('hidden', f !== 'all');
  if (f === 'all') {
    $('#assigneeFilter').innerHTML = `<option value="">Все сотрудники</option>` +
      activeUsers().sort((a, b) => a.name.localeCompare(b.name, 'ru'))
        .map((u) => `<option value="${u.id}" ${u.id === state.assigneeFilter ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
  }
  const list = [...state.tasks.values()].filter((t) =>
    f === 'mine' ? t.assigneeId === state.me.id :
    f === 'byme' ? t.createdBy === state.me.id :
    !state.assigneeFilter || t.assigneeId === state.assigneeFilter);
  const open = list.filter((t) => t.status !== 'done').sort((a, b) => dueMoment(a) - dueMoment(b) || b.priority - a.priority);
  const done = list.filter((t) => t.status === 'done').sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
  const groups = [
    ['Просрочено', open.filter(isOverdue), 'overdue'],
    ['Сегодня', open.filter((t) => !isOverdue(t) && daysUntil(t) === 0)],
    ['Завтра', open.filter((t) => !isOverdue(t) && daysUntil(t) === 1)],
    ['Ближайшие 7 дней', open.filter((t) => !isOverdue(t) && daysUntil(t) > 1 && daysUntil(t) <= 7)],
    ['Позже', open.filter((t) => !isOverdue(t) && daysUntil(t) > 7)],
  ];
  if (state.showDone) groups.push(['Выполнено', done]);
  let html = groups.filter(([, items]) => items.length).map(([title, items, cls]) =>
    `<div class="task-group ${cls || ''}">${title} <span class="n">${items.length}</span></div>` + items.map(taskRow).join('')).join('');
  if (!html) {
    const empty = { mine: 'Открытых задач у вас нет 🎉', byme: 'Вы пока никому не поручали задач', all: 'Задач пока нет' }[f];
    html = `<div class="empty">${empty}${!state.showDone && done.length ? `<br><small>Выполненных: ${done.length}</small>` : ''}</div>`;
  }
  $('#taskList').innerHTML = html;
  $('#taskList').querySelectorAll('.task').forEach((el) => {
    const id = Number(el.dataset.id);
    el.onclick = () => openTaskView(id);
    el.querySelector('.t-check').onclick = (e) => {
      e.stopPropagation();
      const t = state.tasks.get(id);
      if (t && canChangeStatus(t)) setTaskStatus(id, t.status === 'done' ? 'in_progress' : 'done');
    };
  });
}
function taskRow(t) {
  const who = state.users.get(t.assigneeId) || { id: t.assigneeId, name: '—' };
  const author = state.users.get(t.createdBy) || { id: t.createdBy, name: '—' };
  const due = dueLabel(t);
  const can = canChangeStatus(t);
  return `<div class="task ${t.status === 'done' ? 'done' : ''} ${isOverdue(t) ? 'overdue' : ''}" data-id="${t.id}">
    <button class="t-check ${t.status}" ${can ? '' : 'disabled'} title="${can ? (t.status === 'done' ? 'Вернуть в работу' : 'Отметить выполненной') : STATUS_LABEL[t.status]}">${t.status === 'done' ? '✓' : ''}</button>
    <div class="t-body">
      <div class="t-title">${t.priority ? '<span class="prio" title="Высокий приоритет">!</span> ' : ''}${esc(t.title)}</div>
      ${t.description ? `<div class="t-desc">${esc(t.description.split('\n')[0])}</div>` : ''}
      <div class="t-meta">
        <span class="due ${due.cls}">⏱ ${due.text}</span>
        <span class="t-person" title="Исполнитель">${avatar(who, 'xs')}${esc(who.name)}${who.id === state.me.id ? ' (вы)' : ''}</span>
        ${t.createdBy !== t.assigneeId ? `<span title="Поручил">от ${esc(author.id === state.me.id ? 'вас' : author.name)}</span>` : ''}
        ${t.status !== 'new' ? `<span class="st ${t.status}">${STATUS_LABEL[t.status]}</span>` : ''}
        ${t.commentCount ? `<span class="t-comments" title="Комментарии">💬 ${t.commentCount}</span>` : ''}
      </div>
    </div>
  </div>`;
}
async function setTaskStatus(id, status) {
  try {
    const row = await myTaskEdit(id, () => rpc('sl_update_task', { p_id: id, p: { status } }));
    const prev = state.tasks.get(id); state.tasks.set(id, taskFromRow(row, prev?.commentCount));
  }
  catch (e) { toast(humanError(e)); }
  rerenderTasks();
}

function openTaskView(id) {
  const t = state.tasks.get(id);
  if (!t) return;
  const draft = state.openTaskId === id ? ($('#tcInput')?.value || '') : '';
  const who = state.users.get(t.assigneeId) || { id: t.assigneeId, name: '—' };
  const author = state.users.get(t.createdBy) || { id: t.createdBy, name: '—' };
  const due = dueLabel(t);
  const fmt = (ms) => new Date(ms).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  openModal(`
    <h3>${t.priority ? '<span class="prio">!</span> ' : ''}${esc(t.title)}</h3>
    <div class="modal-body">
      <div class="td-row"><span>Исполнитель</span><span class="t-person">${avatar(who, 'xs')}${esc(who.name)}</span></div>
      <div class="td-row"><span>Поручил(а)</span><span class="t-person">${avatar(author, 'xs')}${esc(author.name)}</span></div>
      <div class="td-row"><span>Срок</span><span class="due ${due.cls}">${due.text}</span></div>
      <div class="td-row"><span>Приоритет</span><span>${t.priority ? '<span class="prio">Высокий</span>' : 'Обычный'}</span></div>
      <div class="td-row"><span>Создана</span><span>${fmt(t.createdAt)}</span></div>
      ${t.completedAt ? `<div class="td-row"><span>Выполнена</span><span>${fmt(t.completedAt)}</span></div>` : ''}
      ${t.description ? `<div class="td-desc">${linkify(t.description)}</div>` : ''}
      ${canChangeStatus(t) ? `<div class="status-btns">${['new', 'in_progress', 'done'].map((s) =>
        `<button data-status="${s}" class="${t.status === s ? 'active' : ''}">${{ new: '○ Новая', in_progress: '▶ В работе', done: '✓ Выполнена' }[s]}</button>`).join('')}</div>`
        : `<div class="td-row"><span>Статус</span><span class="st ${t.status}">${STATUS_LABEL[t.status]}</span></div>`}
      <div class="disc-title">Обсуждение</div>
      <div id="tcList"><div class="cm-empty">Загрузка…</div></div>
      <div class="cm-input">
        <textarea id="tcInput" rows="1" placeholder="Написать комментарий…" title="Enter — отправить, Shift+Enter — новая строка"></textarea>
        <button class="send-btn" id="tcSend">Отправить</button>
      </div>
      <div class="modal-err" id="mErr"></div>
    </div>
    <div class="modal-foot">
      ${who.id !== state.me.id ? `<button class="secondary" id="tChat">💬 Написать исполнителю</button>` : ''}
      ${author.id !== state.me.id && who.id === state.me.id ? `<button class="secondary" id="tChat">💬 Написать автору</button>` : ''}
      <span class="spacer"></span>
      ${canEditTask(t) ? '<button class="secondary" id="tEdit">Изменить</button>' : ''}
      <button class="primary" data-close>Закрыть</button>
    </div>`,
    (root) => {
      root.querySelector('[data-close]').onclick = closeModal;
      const input = root.querySelector('#tcInput');
      input.value = draft;
      const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; };
      input.oninput = grow;
      const sendComment = async () => {
        const text = input.value.trim();
        if (!text) return;
        input.disabled = true;
        try {
          const row = check(await sb.from('sl_task_comments').insert({ task_id: t.id, user_id: state.me.id, text }).select().single());
          onCommentChange({ eventType: 'INSERT', new: row });
          input.value = ''; grow();
        } catch (e) { root.querySelector('#mErr').textContent = humanError(e); }
        input.disabled = false; input.focus();
      };
      root.querySelector('#tcSend').onclick = sendComment;
      input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendComment(); } };
      root.querySelectorAll('[data-status]').forEach((b) => b.onclick = async () => {
        await setTaskStatus(t.id, b.dataset.status);
        openTaskView(t.id);
        refreshComments(t.id);
      });
      const edit = root.querySelector('#tEdit');
      if (edit) edit.onclick = () => openTaskForm(state.tasks.get(t.id));
      const chat = root.querySelector('#tChat');
      if (chat) chat.onclick = () => {
        const other = who.id !== state.me.id ? who.id : author.id;
        closeModal();
        openChat(dmKey(state.me.id, other)).then(() => {
          $('#input').value = `По задаче «${t.title}»: `;
          $('#input').focus();
        });
      };
    }, 'wide');
  state.openTaskId = id;
  if (state.comments.has(id)) renderTaskComments(id);
  else refreshComments(id, true);
}

async function refreshComments(id, scrollDown) {
  try {
    const list = check(await sb.from('sl_task_comments').select('*').eq('task_id', id).order('id'));
    state.comments.set(id, list.map(commentFromRow));
    if (state.openTaskId === id) renderTaskComments(id, scrollDown);
  } catch {}
}
const commentFromRow = (c) => ({ id: c.id, taskId: c.task_id, userId: c.user_id, text: c.text, system: c.system, createdAt: Date.parse(c.created_at) });

function onCommentChange(p) {
  if (p.eventType === 'DELETE') {
    const id = p.old.id;
    for (const [taskId, list] of state.comments) {
      const c = list.find((x) => x.id === id);
      if (c) {
        state.comments.set(taskId, list.filter((x) => x.id !== id));
        const t = state.tasks.get(taskId);
        if (t && !c.system) t.commentCount = Math.max(0, t.commentCount - 1);
        if (state.openTaskId === taskId) renderTaskComments(taskId);
      }
    }
    document.querySelectorAll(`.toast[data-cid="${id}"]`).forEach((el) => el.remove());
    rerenderTasks();
    return;
  }
  if (p.eventType !== 'INSERT') return;
  const c = commentFromRow(p.new);
  const t = state.tasks.get(c.taskId);
  const list = state.comments.get(c.taskId);
  if (list?.some((x) => x.id === c.id)) return; // уже показан
  if (list) list.push(c);
  if (t && !c.system) t.commentCount = (t.commentCount || 0) + 1;
  const viewing = state.openTaskId === c.taskId && !document.hidden;
  if (t && !c.system && c.userId !== state.me.id && (t.assigneeId === state.me.id || t.createdBy === state.me.id) && !viewing) {
    const msg = `💬 ${userName(c.userId)} — «${t.title}»: ${c.text.length > 120 ? c.text.slice(0, 120) + '…' : c.text}`;
    toast(msg, () => openTaskView(t.id)).dataset.cid = c.id;
    localNotify('Комментарий к задаче', msg, 'tc' + t.id, `#task=${t.id}`, () => openTaskView(t.id));
  }
  if (state.openTaskId === c.taskId) renderTaskComments(c.taskId, c.userId === state.me.id);
  rerenderTasks();
}

function renderTaskComments(taskId, scrollDown = false) {
  const box = $('#tcList');
  if (!box) return;
  const list = state.comments.get(taskId) || [];
  const fmt = (ms) => new Date(ms).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  box.innerHTML = (list.some((c) => !c.system) ? '' : '<div class="cm-empty">Комментариев пока нет — задайте вопрос или опишите ход работы.</div>') +
    list.map((c) => {
      if (c.system) return `<div class="cm-sys">• ${esc(c.text)} · ${fmt(c.createdAt)}</div>`;
      const u = state.users.get(c.userId) || { id: c.userId, name: 'Сотрудник' };
      return `<div class="cm" data-cid="${c.id}">${avatar(u, 'sm')}
        <div class="cm-body"><div class="cm-meta"><b>${esc(u.name)}</b><span>${fmt(c.createdAt)}</span></div>
        <div class="cm-text">${linkify(c.text)}</div></div>
        ${c.userId === state.me.id ? '<button class="cm-del" title="Удалить комментарий">🗑</button>' : ''}</div>`;
    }).join('');
  box.querySelectorAll('.cm-del').forEach((b) => b.onclick = async () => {
    const cid = Number(b.closest('.cm').dataset.cid);
    if (!confirm('Удалить комментарий?')) return;
    try { check(await sb.from('sl_task_comments').delete().eq('id', cid)); onCommentChange({ eventType: 'DELETE', old: { id: cid } }); }
    catch (e) { toast(humanError(e)); }
  });
  if (scrollDown) { const body = box.closest('.modal-body'); if (body) body.scrollTop = body.scrollHeight; }
}

function openTaskForm(t = {}) {
  const isNew = !t.id;
  const users = activeUsers().sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  openModal(`
    <h3>${isNew ? 'Новая задача' : 'Изменить задачу'}</h3>
    <div class="modal-body">
      <label class="field"><span>Что нужно сделать</span><input id="tTitle" maxlength="200" value="${esc(t.title || '')}" placeholder="например, Подготовить коммерческое предложение"></label>
      <label class="field"><span>Исполнитель</span><select id="tAssignee">
        <option value="">— выберите сотрудника —</option>
        ${users.map((u) => `<option value="${u.id}" ${u.id === t.assigneeId ? 'selected' : ''}>${esc(u.name)}${u.id === state.me.id ? ' (я)' : ''}</option>`).join('')}
      </select></label>
      <div class="row">
        <label class="field"><span>Срок</span><input id="tDate" type="date" value="${t.dueDate || ymd(tomorrow)}"></label>
        <label class="field"><span>Время (необязательно)</span><input id="tTime" type="time" value="${t.dueTime || ''}"></label>
      </div>
      <label class="field"><span>Описание</span><textarea id="tDesc" maxlength="8000" placeholder="Детали, ссылки, ожидаемый результат…">${esc(t.description || '')}</textarea></label>
      <label class="check"><input type="checkbox" id="tPrio" ${t.priority ? 'checked' : ''}> Высокий приоритет</label>
      <div class="modal-err" id="mErr"></div>
    </div>
    <div class="modal-foot">
      ${isNew ? '' : '<button class="danger" id="tDel">Удалить</button>'}<span class="spacer"></span>
      <button class="secondary" data-close>Отмена</button><button class="primary" id="tSave">${isNew ? 'Поручить' : 'Сохранить'}</button>
    </div>`,
    (root) => {
      const err = (m) => root.querySelector('#mErr').textContent = m;
      root.querySelector('[data-close]').onclick = closeModal;
      root.querySelector('#tSave').onclick = async () => {
        const title = root.querySelector('#tTitle').value.trim();
        const assigneeId = root.querySelector('#tAssignee').value;
        const dueDate = root.querySelector('#tDate').value;
        const dueTime = root.querySelector('#tTime').value || null;
        const description = root.querySelector('#tDesc').value;
        const priority = root.querySelector('#tPrio').checked;
        if (!title) return err('Укажите, что нужно сделать');
        if (!assigneeId) return err('Выберите исполнителя');
        if (!dueDate) return err('Укажите срок');
        try {
          let saved;
          if (isNew) {
            const row = check(await sb.from('sl_tasks').insert({
              title, description, assignee_id: assigneeId, due_date: dueDate, due_time: dueTime,
              priority: priority ? 1 : 0, created_by: state.me.id,
            }).select().single());
            markMyEdit(row);
            saved = taskFromRow(row);
          } else {
            saved = taskFromRow(await myTaskEdit(t.id, () => rpc('sl_update_task', { p_id: t.id, p: { title, description, assigneeId, dueDate, dueTime, priority } })), t.commentCount);
          }
          state.tasks.set(saved.id, saved);
          closeModal();
          if (isNew) toast(`📋 Задача поручена: ${userName(saved.assigneeId)} — ${dueLabel(saved).text}`, () => openTaskView(saved.id));
          rerenderTasks();
        } catch (e) { err(humanError(e)); }
      };
      const del = root.querySelector('#tDel');
      if (del) del.onclick = async () => {
        if (!confirm(`Удалить задачу «${t.title}»?`)) return;
        try { await myTaskEdit(t.id, async () => check(await sb.from('sl_tasks').delete().eq('id', t.id))); state.tasks.delete(t.id); closeModal(); rerenderTasks(); }
        catch (e) { err(humanError(e)); }
      };
    });
}
$('#taskAdd').onclick = () => openTaskForm({});
$('#taskFilter').querySelectorAll('button').forEach((b) => b.onclick = () => { setTaskFilter(b.dataset.f); renderTasks(); });
$('#showDone').onchange = (e) => { state.showDone = e.target.checked; renderTasks(); };
$('#assigneeFilter').onchange = (e) => { state.assigneeFilter = e.target.value; renderTasks(); };
setInterval(() => { if (state.me) rerenderTasks(); }, 60000);

// ---------- Кабинет администратора ----------
async function openAdmin() {
  if (!state.me.isAdmin) return;
  showView('admin');
  localStorage.setItem('lastChat', 'admin');
  renderSidebar();
  renderAdmin();
}
let adminUsers = [];
async function renderAdmin() {
  try {
    const [info, list] = await Promise.all([rpc('sl_admin_info'), fn('sl-admin', { action: 'list' })]);
    adminUsers = list.users;
    renderInvite(info);
  } catch (e) { $('#adminUsers').innerHTML = `<div class="modal-err">${esc(humanError(e))}</div>`; return; }
  const active = adminUsers.filter((u) => !u.disabled).length;
  $('#adminCount').textContent = `${active} активн. из ${adminUsers.length}`;
  const seen = (u) => state.online.has(u.id) ? '<span class="call-live">в сети</span>'
    : u.last_active ? 'был(а) ' + new Date(u.last_active).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'ещё не заходил(а)';
  $('#adminUsers').innerHTML = adminUsers.map((u) => `
    <div class="u-row ${u.disabled ? 'off' : ''}" data-id="${u.id}">
      ${avatar({ id: u.id, name: u.name }, 'sm')}
      <div class="u-main">
        <div class="u-name">${esc(u.name)}${u.id === state.me.id ? ' (вы)' : ''}
          ${u.is_admin ? '<span class="tag shared">администратор</span>' : ''}
          ${u.disabled ? '<span class="tag" style="background:#fee2e2;color:#b91c1c">отключён</span>' : ''}</div>
        <div class="u-meta">логин: <b>${esc(u.login)}</b> · ${u.disabled ? 'доступ закрыт' : seen(u)}</div>
      </div>
      <div class="u-actions">
        ${u.disabled
          ? '<button data-act="enable">Вернуть доступ</button>'
          : `<button data-act="password">Новый пароль</button>
             ${u.id !== state.me.id ? `<button data-act="admin">${u.is_admin ? 'Снять админа' : 'Сделать админом'}</button>
             <button data-act="disable" class="warn">Отключить</button>` : ''}`}
      </div>
    </div>`).join('');
  $('#adminUsers').querySelectorAll('[data-act]').forEach((b) => b.onclick = () => adminAction(b.closest('.u-row').dataset.id, b.dataset.act));
}
function renderInvite(info) {
  $('#inviteCard').innerHTML = `
    <div class="admin-card-title">Самостоятельная регистрация</div>
    <label class="check"><input type="checkbox" id="invEnabled" ${info.inviteEnabled ? 'checked' : ''}> Разрешить сотрудникам регистрироваться по коду приглашения</label>
    ${info.inviteEnabled ? `
      <div class="invite-row"><span class="invite-code" id="invCode">${esc(info.invite)}</span>
        <button class="secondary" id="invCopy">Скопировать</button><button class="secondary" id="invNew">Сменить код</button></div>
      <div class="muted">Сообщите код новым сотрудникам: они введут его на вкладке «Регистрация». Смените код, если он попал к посторонним.</div>`
    : '<div class="muted">Регистрация закрыта: новых сотрудников добавляете только вы кнопкой «+ Добавить сотрудника».</div>'}`;
  $('#invEnabled').onchange = async (e) => {
    try { await rpc('sl_set_invite_enabled', { p_enabled: e.target.checked }); renderAdmin(); } catch (er) { toast(humanError(er)); }
  };
  const copy = $('#invCopy');
  if (copy) copy.onclick = () => navigator.clipboard.writeText(info.invite).then(() => toast('Код скопирован'));
  const nw = $('#invNew');
  if (nw) nw.onclick = async () => {
    if (!confirm('Сменить код приглашения? Старый код перестанет работать.')) return;
    try { await rpc('sl_new_invite'); renderAdmin(); } catch (e) { toast(humanError(e)); }
  };
}
const genPassword = () => {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(10)), (x) => a[x % a.length]).join('');
};
function showCredentials(title, login, password) {
  const text = `Shtark Link\nАдрес: ${location.origin + location.pathname}\nЛогин: ${login}\nПароль: ${password}`;
  openModal(`<h3>${esc(title)}</h3>
    <div class="modal-body">
      <p style="margin:0 0 10px;font-size:14px">Передайте сотруднику данные для входа. Пароль больше нигде не показывается — сохраните или отправьте его сейчас.</p>
      <div class="cred">${esc(text)}</div>
    </div>
    <div class="modal-foot"><span class="spacer"></span><button class="secondary" id="cCopy">Скопировать</button><button class="primary" data-close>Готово</button></div>`,
    (root) => {
      root.querySelector('[data-close]').onclick = closeModal;
      root.querySelector('#cCopy').onclick = () => navigator.clipboard.writeText(text).then(() => toast('Скопировано'));
    });
}
$('#adminAdd').onclick = () => openModal(`
  <h3>Новый сотрудник</h3>
  <div class="modal-body">
    <label class="field"><span>Имя и фамилия</span><input id="aName" maxlength="64" placeholder="Анна Петрова"></label>
    <label class="field"><span>Логин для входа (латиница)</span><input id="aLogin" maxlength="32" placeholder="petrova"></label>
    <label class="field"><span>Пароль</span><input id="aPass" value="${genPassword()}"></label>
    <label class="check"><input type="checkbox" id="aAdmin"> Администратор</label>
    <div class="modal-err" id="mErr"></div>
  </div>
  <div class="modal-foot"><span class="spacer"></span><button class="secondary" data-close>Отмена</button><button class="primary" id="aOk">Добавить</button></div>`,
  (root) => {
    root.querySelector('[data-close]').onclick = closeModal;
    const tr = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ы: 'y', э: 'e', ю: 'yu', я: 'ya' };
    let loginTouched = false;
    root.querySelector('#aLogin').oninput = () => { loginTouched = true; };
    root.querySelector('#aName').oninput = (e) => {
      if (loginTouched) return;
      const parts = e.target.value.trim().toLowerCase().split(/\s+/);
      const base = parts.length > 1 ? parts[parts.length - 1] : parts[0];
      root.querySelector('#aLogin').value = [...(base || '')].map((c) => tr[c] ?? c).join('').replace(/[^a-z0-9._-]/g, '').slice(0, 32);
    };
    root.querySelector('#aOk').onclick = async () => {
      const login = root.querySelector('#aLogin').value.trim().toLowerCase(), password = root.querySelector('#aPass').value;
      try {
        await fn('sl-admin', { action: 'create', login, name: root.querySelector('#aName').value, password, isAdmin: root.querySelector('#aAdmin').checked });
        renderAdmin();
        showCredentials('Сотрудник добавлен', login, password);
      } catch (e) { root.querySelector('#mErr').textContent = humanError(e); }
    };
  });
async function adminAction(id, act) {
  const u = adminUsers.find((x) => x.id === id);
  if (!u) return;
  try {
    if (act === 'disable') {
      if (!confirm(`Отключить «${u.name}»?\n\nСотрудник сразу потеряет доступ к Shtark Link. Его сообщения и задачи сохранятся. Доступ можно вернуть в любой момент.`)) return;
      await fn('sl-admin', { action: 'disable', id });
      toast(`${u.name}: доступ отключён`);
    } else if (act === 'enable') {
      await fn('sl-admin', { action: 'enable', id });
      toast(`${u.name}: доступ возвращён. Сотрудника нужно заново добавить в групповые чаты.`);
    } else if (act === 'admin') {
      await fn('sl-admin', { action: 'admin', id, isAdmin: !u.is_admin });
    } else if (act === 'password') {
      const password = genPassword();
      if (!confirm(`Задать «${u.name}» новый пароль? Старый перестанет работать.`)) return;
      await fn('sl-admin', { action: 'password', id, password });
      showCredentials('Новый пароль', u.login, password);
    }
    renderAdmin();
  } catch (e) { toast(humanError(e)); }
}

// ---------- Звонки (LiveKit) ----------
const call = { chat: null, room: null, joining: false, started: 0, timer: null, ringTimeout: null, mic: true, cam: false, screen: false };
let lkLoading = null;
function loadLiveKit() {
  if (window.LivekitClient) return Promise.resolve();
  if (!lkLoading) lkLoading = new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = 'vendor/livekit-client.umd.js?v=' + APP_VERSION;
    s.onload = ok; s.onerror = () => fail(new Error('Не удалось загрузить модуль звонков'));
    document.head.appendChild(s);
  });
  return lkLoading;
}

// ---------- Доступ к микрофону и камере ----------
function mediaErrorText(e, what = 'микрофон') {
  const n = e?.name || '';
  const What = what[0].toUpperCase() + what.slice(1);
  if (!navigator.mediaDevices?.getUserMedia || n === 'Unsupported' || n === 'NotSupportedError') {
    return `Этот браузер не даёт сайтам доступ к устройствам. Если вы открыли ссылку из Telegram, WhatsApp или другого мессенджера — откройте её в ${isIOS ? 'Safari' : 'Chrome'}.`;
  }
  if (n === 'NotAllowedError' || n === 'SecurityError') {
    return isIOS
      ? `Доступ к устройству «${what}» запрещён для этого сайта.\n\n1. Нажмите «аА» слева от адреса → «Настройки веб-сайта» → ${What} → «Разрешить».\n2. Проверьте: Настройки iPhone → Safari → ${What} → «Разрешить».\n3. Обновите страницу и позвоните снова.`
      : `Доступ к устройству «${what}» запрещён для этого сайта.\n\nНажмите значок 🔒 слева от адреса → ${What} → «Разрешить», затем обновите страницу.`;
  }
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return `${What} не найден. Проверьте, что он подключён и включён.`;
  if (n === 'NotReadableError' || n === 'AbortError') return `${What} занят другим приложением (например, идёт обычный звонок или запись). Закройте его и попробуйте снова.`;
  return `Не удалось включить ${what}: ${e?.message || n}`;
}
function showMediaError(e, what = 'микрофон') {
  console.warn('media error', e);
  openModal(`<h3>${what === 'камера' ? '📷' : '🎤'} Нет доступа: ${esc(what)}</h3>
    <div class="modal-body"><p style="white-space:pre-line;font-size:14px;margin:0 0 8px">${esc(mediaErrorText(e, what))}</p>
    <p class="muted">Код ошибки: ${esc(e?.name || 'неизвестно')}</p></div>
    <div class="modal-foot"><span class="spacer"></span><button class="primary" data-close>Понятно</button></div>`,
    (root) => { root.querySelector('[data-close]').onclick = closeModal; });
}
function requestMic() {
  if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(Object.assign(new Error('mediaDevices недоступны'), { name: 'Unsupported' }));
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
}
async function publishMic(room, stream) {
  const LK = window.LivekitClient;
  await room.localParticipant.publishTrack(stream.getAudioTracks()[0], { source: LK.Track.Source.Microphone });
}

// ---------- Диагностика звонка (технические показатели, без звука) ----------
const deviceId = (() => { try { let d = localStorage.getItem('sl-device'); if (!d) { d = Math.random().toString(36).slice(2, 10); localStorage.setItem('sl-device', d); } return d; } catch { return 'nodev'; } })();
async function statsOf(track) {
  try { return await track?.getRTCStatsReport?.(); } catch { return null; }
}
function pairInfo(report) {
  if (!report) return null;
  let pair = null;
  report.forEach((s) => { if (s.type === 'candidate-pair' && (s.selected || s.nominated) && s.state === 'succeeded') pair = s; });
  if (!pair) report.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = report.get(s.selectedCandidatePairId); });
  if (!pair) return null;
  const lc = report.get(pair.localCandidateId), rc = report.get(pair.remoteCandidateId);
  return { local: lc?.candidateType, proto: lc?.protocol, relay: lc?.relayProtocol, remote: rc?.candidateType, rtt: pair.currentRoundTripTime };
}
async function collectCallDiag() {
  const room = call.room, chat = call.chat;
  if (!room) return;
  const LK = window.LivekitClient, lp = room.localParticipant;
  const micPub = lp.getTrackPublication(LK.Track.Source.Microphone);
  const micStats = await statsOf(micPub?.track);
  let bytesSent = 0;
  micStats?.forEach((s) => { if (s.type === 'outbound-rtp') bytesSent += s.bytesSent || 0; });
  const remotes = [];
  for (const p of room.remoteParticipants.values()) {
    const pub = p.getTrackPublication(LK.Track.Source.Microphone);
    const st = await statsOf(pub?.track);
    let bytesRecv = 0, packetsLost = 0;
    st?.forEach((s) => { if (s.type === 'inbound-rtp') { bytesRecv += s.bytesReceived || 0; packetsLost += s.packetsLost || 0; } });
    remotes.push({ who: userName(p.identity), audioPub: !!pub, subscribed: !!pub?.isSubscribed, muted: !!pub?.isMuted,
      level: Math.round((p.audioLevel || 0) * 100) / 100, bytesRecv, packetsLost, pair: pairInfo(st) });
  }
  const audioEls = [...document.querySelectorAll('#callAudio audio')].map((a) => ({ paused: a.paused, muted: a.muted, vol: a.volume }));
  const data = {
    ua: navigator.userAgent.slice(0, 160), standalone: isStandalone, state: room.state, canPlayAudio: room.canPlaybackAudio,
    mic: { want: call.mic, published: !!micPub, muted: !!micPub?.isMuted, level: Math.round((lp.audioLevel || 0) * 100) / 100,
      bytesSent, error: call.micError || null, pair: pairInfo(micStats) },
    remotes, audioEls, secs: Math.round((Date.now() - call.started) / 1000),
  };
  sb.from('sl_call_diag').upsert({ user_id: state.me.id, device: deviceId, chat, data, updated_at: new Date().toISOString() }).then(() => {}, () => {});
}

function unlockAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    const ctx = new AC();
    // короткая тишина — «пинок», после которого iOS считает звук разрешённым
    const buf = ctx.createBuffer(1, 1, 22050), src = ctx.createBufferSource();
    src.buffer = buf; src.connect(ctx.destination); src.start(0);
    ctx.resume?.();
    return ctx;
  } catch { return null; }
}

async function joinCall(chat) {
  if (call.chat === chat || call.joining) return; // защита от двойного входа
  // Микрофон запрашиваем сразу, в момент нажатия: iPhone не разрешает запрос «потом»
  const micPromise = requestMic();
  micPromise.catch(() => {});
  // iPhone разрешает звук, только если его «включили» прямо в момент нажатия — делаем это сразу
  const audioCtx = unlockAudio();
  if (call.chat) {
    if (!confirm('Вы уже в звонке. Завершить его и перейти в новый?')) {
      micPromise.then((s) => s.getTracks().forEach((t) => t.stop()), () => {});
      return;
    }
    await leaveCall();
  }
  hideIncoming();
  call.joining = true;
  try {
    const [tok] = await Promise.all([fn('sl-call-token', { chat }), loadLiveKit()]);
    const LK = window.LivekitClient;
    const room = new LK.Room({
      adaptiveStream: true, dynacast: true,
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true },
      webAudioMix: audioCtx ? { audioContext: audioCtx } : false, // звук собеседников идёт через уже разблокированный AudioContext
    });
    call.chat = chat; call.room = room; call.started = Date.now(); call.mic = true; call.micError = null; call.cam = false; call.screen = false;
    room
      .on(LK.RoomEvent.TrackSubscribed, (track) => { if (track.kind === 'audio') $('#callAudio').appendChild(track.attach()); renderCall(); })
      .on(LK.RoomEvent.TrackUnsubscribed, (track) => { track.detach().forEach((el) => el.remove()); renderCall(); })
      .on(LK.RoomEvent.ParticipantConnected, () => { clearTimeout(call.ringTimeout); renderCall(); })
      .on(LK.RoomEvent.ParticipantDisconnected, () => {
        renderCall();
        if (chat.startsWith('d:') && room.remoteParticipants.size === 0) { toast('Собеседник завершил звонок'); leaveCall(); }
      })
      .on(LK.RoomEvent.ActiveSpeakersChanged, renderSpeaking)
      .on(LK.RoomEvent.TrackMuted, renderCall).on(LK.RoomEvent.TrackUnmuted, renderCall)
      .on(LK.RoomEvent.LocalTrackPublished, renderCall).on(LK.RoomEvent.LocalTrackUnpublished, renderCall)
      .on(LK.RoomEvent.Disconnected, () => { if (call.room === room) cleanupCall(); })
      .on(LK.RoomEvent.AudioPlaybackStatusChanged, () => $('#callSound').classList.toggle('hidden', room.canPlaybackAudio));
    await room.connect(tok.url, tok.token);
    $('#callTitle').textContent = chatTitle(chat);
    $('#callPanel').classList.remove('hidden');
    room.startAudio().catch(() => {});
    $('#callSound').classList.toggle('hidden', room.canPlaybackAudio);
    micPromise.then(async (stream) => {
      if (call.room !== room) { stream.getTracks().forEach((t) => t.stop()); return; }
      try { await publishMic(room, stream); call.mic = true; }
      catch (e) {
        console.warn('publish mic', e);
        call.mic = false; call.micError = 'publish: ' + (e?.message || e);
        toast('Не удалось передать звук на сервер звонков. Проверьте интернет и нажмите 🎤 ещё раз.');
      }
      renderCall();
    }, (e) => { call.mic = false; call.micError = (e?.name || '') + ': ' + (e?.message || ''); renderCall(); showMediaError(e, 'микрофон'); });
    call.diagTimer = setInterval(collectCallDiag, 4000);
    call.timer = setInterval(() => {
      const s = Math.floor((Date.now() - call.started) / 1000);
      $('#callTimer').textContent = `${pad(Math.floor(s / 60))}:${pad(s % 60)}` + (room.remoteParticipants.size ? '' : ' · ожидание…');
    }, 1000);
    renderCall();
    announceCall();
    renderChatHeader();
    // Звоним, только если в комнате ещё никого нет (иначе мы просто присоединились к идущему звонку)
    if (room.remoteParticipants.size === 0) {
      state.rt.send({ type: 'broadcast', event: 'call', payload: { type: 'ring', chat, from: state.me.id } });
      if (!chat.startsWith('c:')) fn('sl-push', { action: 'ring', chat }).catch(() => {});
      if (chat.startsWith('d:')) {
        call.ringTimeout = setTimeout(() => {
          if (call.chat === chat && room.remoteParticipants.size === 0) { toast('Абонент не отвечает'); leaveCall(); }
        }, 45000);
      }
    }
  } catch (e) {
    cleanupCall();
    toast('Звонок не удался: ' + humanError(e));
    sb.from('sl_call_diag').upsert({ user_id: state.me.id, device: deviceId, chat, updated_at: new Date().toISOString(),
      data: { ua: navigator.userAgent.slice(0, 160), standalone: isStandalone, stage: 'join-failed', error: String(e?.message || e) } }).then(() => {}, () => {});
  } finally { call.joining = false; }
}

async function leaveCall() {
  if (!call.room) return;
  const room = call.room, chat = call.chat;
  if (chat?.startsWith('d:') && room.remoteParticipants.size === 0) {
    state.rt?.send({ type: 'broadcast', event: 'call', payload: { type: 'cancel', chat, from: state.me.id } });
  }
  cleanupCall();
  await room.disconnect().catch(() => {});
}
function cleanupCall() {
  clearInterval(call.timer); clearInterval(call.diagTimer); clearTimeout(call.ringTimeout);
  if (call.room) collectCallDiag();
  call.chat = null; call.room = null;
  $('#callPanel').classList.add('hidden');
  $('#callPanel').classList.remove('big');
  $('#callGrid').innerHTML = '';
  $('#callAudio').innerHTML = '';
  announceCall();
  if (state.view === 'chat') renderChatHeader();
}

function renderCall() {
  const room = call.room;
  if (!room) return;
  const LK = window.LivekitClient;
  const parts = [room.localParticipant, ...room.remoteParticipants.values()];
  $('#callGrid').innerHTML = parts.map((p) => {
    const u = state.users.get(p.identity) || { id: p.identity, name: p.name || 'Сотрудник' };
    // себя показываем по кнопке (пока микрофон подключается, публикации ещё нет)
    const muted = p === room.localParticipant ? !call.mic : !p.isMicrophoneEnabled;
    return `<div class="tile ${p.isSpeaking ? 'speaking' : ''}" data-pid="${esc(p.identity)}">
      ${avatar(u)}<span class="t-name">${esc(p === room.localParticipant ? 'Вы' : u.name)}</span>
      ${muted ? '<span class="t-mute">🔇</span>' : ''}</div>`;
  }).join('');
  // видео (камера или экран)
  parts.forEach((p) => {
    const pub = p.getTrackPublication(LK.Track.Source.ScreenShare) || p.getTrackPublication(LK.Track.Source.Camera);
    const track = pub?.track;
    if (track && !pub.isMuted) {
      const tile = $('#callGrid').querySelector(`[data-pid="${CSS.escape(p.identity)}"]`);
      const v = track.attach();
      v.muted = true; v.playsInline = true;
      tile?.prepend(v);
    }
  });
  $('#callMic').classList.toggle('off', !call.mic);
  $('#callMic').textContent = call.mic ? '🎤' : '🔇';
  $('#callCam').classList.toggle('off', call.cam);
  $('#callScreen').classList.toggle('off', call.screen);
}
function renderSpeaking() {
  const room = call.room;
  if (!room) return;
  $('#callGrid').querySelectorAll('.tile').forEach((t) => {
    const p = t.dataset.pid === room.localParticipant.identity ? room.localParticipant : room.remoteParticipants.get(t.dataset.pid);
    t.classList.toggle('speaking', !!p?.isSpeaking);
  });
}
$('#callMic').onclick = async () => {
  if (!call.room) return;
  const room = call.room, LK = window.LivekitClient;
  if (!room.localParticipant.getTrackPublication(LK.Track.Source.Microphone)) {
    // микрофон ещё не подключён (не разрешили или сбой) — пробуем снова, прямо по нажатию
    try { await publishMic(room, await requestMic()); call.mic = true; }
    catch (e) { call.mic = false; if (e?.name) showMediaError(e, 'микрофон'); else toast('Не удалось передать звук. Проверьте интернет.'); }
    return renderCall();
  }
  try { call.mic = !call.mic; await room.localParticipant.setMicrophoneEnabled(call.mic); }
  catch (e) { call.mic = false; showMediaError(e, 'микрофон'); }
  renderCall();
};
$('#callCam').onclick = async () => {
  if (!call.room) return;
  try { call.cam = !call.cam; await call.room.localParticipant.setCameraEnabled(call.cam); }
  catch (e) { call.cam = false; showMediaError(e, 'камера'); }
  renderCall();
};
$('#callSound').onclick = () => { call.room?.startAudio().then(() => $('#callSound').classList.add('hidden')).catch(() => {}); };
// на iPhone любое касание окна звонка «размораживает» звук, если браузер его придержал
$('#callPanel').addEventListener('pointerdown', () => {
  const r = call.room;
  if (!r) return;
  r.startAudio?.().catch(() => {});
  document.querySelectorAll('#callAudio audio').forEach((a) => a.paused && a.play().catch(() => {}));
});
$('#callScreen').onclick = async () => {
  if (!call.room) return;
  try { call.screen = !call.screen; await call.room.localParticipant.setScreenShareEnabled(call.screen); }
  catch { call.screen = false; toast('Показ экрана недоступен на этом устройстве'); }
  renderCall();
};
$('#callLeave').onclick = () => leaveCall();
$('#callExpand').onclick = () => $('#callPanel').classList.toggle('big');
window.addEventListener('beforeunload', () => { call.room?.disconnect(); });

// Входящий звонок
let ringAudio = null, incomingChat = null, incomingTimeout = null;
function onCallSignal(p) {
  if (!p || p.from === state.me.id) return;
  if (p.type === 'hello') { if (call.chat) announceCall(); return; }
  if (p.type === 'state') {
    callStates.set(p.from, { chat: p.chat, until: Date.now() + 40000 });
    rebuildInCall();
    renderSidebar();
    if (state.view === 'chat') renderChatHeader();
    return;
  }
  if (p.type === 'ring') {
    callStates.set(p.from, { chat: p.chat, until: Date.now() + 40000 });
    rebuildInCall();
    if (call.chat === p.chat || !chatMembers(p.chat).includes(state.me.id)) return;
    if (p.chat.startsWith('c:')) return; // в каналах не звоним всем — только значок «идёт созвон»
    showIncoming(p.chat, p.from);
  } else if (p.type === 'cancel' && incomingChat === p.chat) {
    hideIncoming();
    toast(`Пропущенный звонок от ${userName(p.from)}`, () => openChat(p.chat));
  } else if (p.type === 'decline' && call.chat === p.chat && p.chat.startsWith('d:')) {
    toast(`${userName(p.from)} отклонил(а) звонок`);
    leaveCall();
  }
}
function showIncoming(chat, from) {
  incomingChat = chat;
  const u = state.users.get(from) || { id: from, name: 'Сотрудник' };
  $('#incomingAva').innerHTML = avatar(u);
  $('#incomingName').textContent = u.name;
  $('#incomingSub').textContent = chat.startsWith('d:') ? 'Входящий звонок' : `Звонок в «${chatTitle(chat)}»`;
  $('#incoming').classList.remove('hidden');
  startRingtone();
  localNotify('📞 Входящий звонок', `${u.name}${chat.startsWith('d:') ? ' звонит вам' : ' — ' + chatTitle(chat)}`, 'call-' + chat, `#chat=${chat}`, () => openChat(chat));
  clearTimeout(incomingTimeout);
  incomingTimeout = setTimeout(() => {
    if (incomingChat === chat) { hideIncoming(); toast(`Пропущенный звонок от ${u.name}`, () => openChat(chat)); }
  }, 45000);
}
function hideIncoming() {
  incomingChat = null;
  clearTimeout(incomingTimeout);
  $('#incoming').classList.add('hidden');
  stopRingtone();
}
$('#incomingAccept').onclick = () => { const c = incomingChat; hideIncoming(); openChat(c); joinCall(c); };
$('#incomingDecline').onclick = () => {
  const c = incomingChat;
  hideIncoming();
  state.rt.send({ type: 'broadcast', event: 'call', payload: { type: 'decline', chat: c, from: state.me.id } });
};
function startRingtone() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const beep = () => {
      [0, 0.35].forEach((t) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = 520; g.gain.value = 0.08;
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.25);
      });
    };
    beep();
    ringAudio = { ctx, timer: setInterval(beep, 2000) };
  } catch {}
}
function stopRingtone() {
  if (!ringAudio) return;
  clearInterval(ringAudio.timer);
  ringAudio.ctx.close().catch(() => {});
  ringAudio = null;
}

// ---------- Уведомления ----------
function localNotify(title, body, tag, url, onClick) {
  if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  if (state.push.reg) {
    state.push.reg.showNotification(title, { body, tag, icon: 'icon-192.png', badge: 'icon-192.png', data: { url: new URL(url, location.href).href } }).catch(() => {});
    return;
  }
  try {
    const n = new Notification(title, { body, tag, icon: 'icon-192.png' });
    n.onclick = () => { window.focus(); onClick && onClick(); n.close(); };
  } catch {}
}

// Ссылки из уведомлений: #chat=c:1, #task=5, #tasks, #calendar
function openDeepLink(hash) {
  const h = String(hash || '').replace(/^.*#/, '');
  if (!h) return false;
  const [key, value] = h.split('=');
  if (key === 'chat' && value) { openChat(decodeURIComponent(value)); return true; }
  if (key === 'task' && value) {
    openTasks();
    (state.tasksLoaded || Promise.resolve()).then(() => openTaskView(Number(value)));
    return true;
  }
  if (key === 'tasks') { openTasks(); return true; }
  if (key === 'calendar') { openCalendar(); return true; }
  return false;
}
window.addEventListener('hashchange', () => {
  if (state.me && openDeepLink(location.hash)) history.replaceState(null, '', location.pathname);
});

// ---------- Push-уведомления ----------
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = () => window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function initPush() {
  if ('serviceWorker' in navigator && window.isSecureContext) {
    try {
      state.push.reg = await navigator.serviceWorker.register('sw.js');
      state.push.sub = await state.push.reg.pushManager?.getSubscription();
      if (state.push.sub && Notification.permission === 'granted') fn('sl-push', { action: 'subscribe', sub: state.push.sub }).catch(() => {});
    } catch (e) { console.warn('SW', e); }
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'open') openDeepLink(new URL(e.data.url).hash);
    });
  }
  renderPushState();
}
function pushEnabled() { return !!state.push.sub && 'Notification' in window && Notification.permission === 'granted'; }
function renderPushState() {
  const on = pushEnabled();
  $('#bellBtn').classList.toggle('off', !on);
  $('#bellBtn').title = on ? 'Уведомления включены' : 'Уведомления выключены';
  const dismissed = localStorage.getItem('pushPromptDismissed') === '1';
  const canAsk = (pushSupported() && Notification.permission !== 'denied') || (isIOS && !isStandalone);
  $('#pushPrompt').classList.toggle('hidden', on || dismissed || !canAsk);
}
async function enablePush() {
  if (!pushSupported()) throw new Error('Этот браузер или адрес не поддерживает push-уведомления');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Вы не разрешили уведомления. Разрешение можно включить в настройках сайта в браузере.');
  if (!state.push.reg) state.push.reg = await navigator.serviceWorker.register('sw.js');
  await navigator.serviceWorker.ready;
  const { publicKey } = await fn('sl-push', { action: 'vapid' });
  const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - publicKey.length % 4) % 4)), (c) => c.charCodeAt(0));
  try {
    state.push.sub = await state.push.reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  } catch (e) {
    console.warn('push subscribe', e);
    throw new Error('Не удалось подключиться к службе уведомлений браузера. Проверьте интернет и попробуйте ещё раз.');
  }
  await fn('sl-push', { action: 'subscribe', sub: state.push.sub });
  renderPushState();
}
async function disablePush() {
  const sub = state.push.sub;
  if (sub) {
    await fn('sl-push', { action: 'unsubscribe', endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
  state.push.sub = null;
  renderPushState();
}
function openPushSettings() {
  let status, body = '', actions = '';
  if (isIOS && !isStandalone) {
    status = `<div class="push-status warn">На iPhone и iPad уведомления работают, только если Shtark Link добавлен на экран «Домой».</div>`;
    body = `<ol class="howto">
      <li>Откройте Shtark Link в <b>Safari</b>.</li>
      <li>Нажмите кнопку <b>«Поделиться»</b> (квадрат со стрелкой вверх).</li>
      <li>Выберите <b>«На экран „Домой“»</b> и нажмите «Добавить».</li>
      <li>Откройте Shtark Link с появившейся иконки и снова нажмите 🔔.</li></ol>
      <p style="font-size:13px;color:var(--muted)">Нужна iOS 16.4 или новее.</p>`;
  } else if (!window.isSecureContext) {
    status = `<div class="push-status warn">Push-уведомления работают только по защищённому адресу (https://…).</div>`;
  } else if (!pushSupported()) {
    status = `<div class="push-status warn">Этот браузер не поддерживает push-уведомления. Попробуйте Chrome, Edge, Firefox или Safari.</div>`;
  } else if (Notification.permission === 'denied') {
    status = `<div class="push-status warn">Уведомления запрещены в настройках браузера для этого сайта. Нажмите на значок замка 🔒 слева от адреса → «Уведомления» → «Разрешить», затем обновите страницу.</div>`;
  } else if (pushEnabled()) {
    status = `<div class="push-status ok">✓ Уведомления включены на этом устройстве.</div>`;
    body = `<p style="font-size:14px;margin:0 0 8px">Вы будете получать уведомления о новых сообщениях, задачах, комментариях и звонках, когда Shtark Link закрыт.</p>`;
    actions = `<button class="danger" id="pOff">Выключить</button><span class="spacer"></span><button class="secondary" id="pTest">Проверить</button>`;
  } else {
    status = `<div class="push-status">Уведомления на этом устройстве выключены.</div>`;
    body = `<p style="font-size:14px;margin:0 0 8px">Включите, чтобы получать сообщения, задачи и звонки, даже когда Shtark Link закрыт. Включать нужно на каждом устройстве отдельно — на телефоне и компьютере.</p>`;
    actions = `<span class="spacer"></span><button class="primary" id="pOn">Включить уведомления</button>`;
  }
  openModal(`<h3>🔔 Уведомления</h3>
    <div class="modal-body">${status}${body}<div class="modal-err" id="mErr"></div></div>
    <div class="modal-foot">${actions || '<span class="spacer"></span>'}<button class="secondary" data-close>Закрыть</button></div>`,
    (root) => {
      const err = (e) => root.querySelector('#mErr').textContent = humanError(e);
      root.querySelector('[data-close]').onclick = closeModal;
      const on = root.querySelector('#pOn');
      if (on) on.onclick = async () => { on.disabled = true; try { await enablePush(); openPushSettings(); toast('🔔 Уведомления включены'); } catch (e) { err(e); on.disabled = false; } };
      const off = root.querySelector('#pOff');
      if (off) off.onclick = async () => { await disablePush(); openPushSettings(); };
      const test = root.querySelector('#pTest');
      if (test) test.onclick = async () => {
        try { const r = await fn('sl-push', { action: 'test' }); toast(r.sent ? 'Тестовое уведомление отправлено — оно появится через пару секунд' : 'Не удалось отправить: подписка не найдена, включите заново'); }
        catch (e) { err(e); }
      };
    });
}
$('#bellBtn').onclick = openPushSettings;
$('#pushPrompt').onclick = openPushSettings;

// Напоминания о делах календаря
function checkReminders() {
  if (!state.me) return;
  const now = new Date();
  const today = ymd(now), hm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  for (const e of state.events.values()) {
    if (e.date !== today || !e.time || e.done || state.reminded.has(e.id)) continue;
    if (e.time <= hm) {
      state.reminded.add(e.id);
      const [h, m] = e.time.split(':').map(Number);
      if (now.getHours() * 60 + now.getMinutes() - (h * 60 + m) > 10) continue;
      const go = () => { state.selectedDate = e.date; openCalendar(); };
      toast(`⏰ ${e.time} — ${e.title}`, go);
      localNotify('⏰ ' + e.title, `Сегодня в ${e.time}`, 'ev' + e.id, '#calendar', go);
    }
  }
}

// ---------- Автообновление: если на сайте новая версия — перезагрузиться (не во время звонка) ----------
const APP_VERSION = (document.querySelector('script[src^="app.js"]')?.getAttribute('src').split('v=')[1]) || '';
async function checkUpdate() {
  if (!APP_VERSION || call.room || call.joining) return;
  try {
    const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    const { v } = await r.json();
    if (v && v !== APP_VERSION && !call.room) location.reload();
  } catch {}
}
setInterval(checkUpdate, 5 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkUpdate(); });

// ---------- Запуск ----------
sb.auth.getSession().then(({ data }) => { if (data.session) start().catch((e) => { $('#authError').textContent = humanError(e); }); });
