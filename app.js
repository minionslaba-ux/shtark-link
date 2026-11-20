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
  reactions: new Map(), // id сообщения -> Map(эмодзи -> Set(id сотрудника))
  reads: new Map(),     // чат -> Map(id сотрудника -> последний прочитанный id)
  quoted: new Map(),    // id -> сообщение (для цитат, если его нет в загруженном списке)
  pins: new Map(),      // чат -> закреплённые сообщения
  replyTo: null, editing: null,
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
const avatar = (u, cls = '') => {
  const url = u.avatar || (typeof state !== 'undefined' && state.users.get(u.id)?.avatar);
  return url
    ? `<span class="avatar ${cls}"><img src="${esc(url)}" alt="" loading="lazy"></span>`
    : `<span class="avatar ${cls}" style="background:${userColor(u.id)}">${esc(initials(u.name))}</span>`;
};
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
    <span class="pname">${esc(u.name)}${u.position ? `<small class="pos">${esc(u.position)}</small>` : ''}</span><span class="dot ${state.online.has(u.id) ? 'on' : ''}"></span></label>`).join('')}</div>`;
}
const pickedIds = (root) => [...root.querySelectorAll('.people input:checked')].map((i) => i.value);

// ---------- Вход и регистрация ----------
let authMode = 'login';
document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => {
  authMode = b.dataset.mode;
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  $('#nameField').classList.toggle('hidden', authMode !== 'register');
  $('#inviteField').classList.toggle('hidden', authMode !== 'register');
  $('#positionField').classList.toggle('hidden', authMode !== 'register');
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
    if (authMode === 'register') await fn('sl-register', { login, name: f.name, position: f.position, password: f.password, invite: f.invite });
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

// ---------- Мой профиль и аватарки ----------
function avatarEditorHtml(u) {
  return `<div class="ava-edit">${avatar(u, 'xl')}
    <div><button class="secondary" type="button" id="avaPick">📷 Загрузить фото</button>
    ${u.avatar ? '<button class="danger" type="button" id="avaDel">Убрать</button>' : ''}
    <input type="file" id="avaFile" accept="image/*" hidden><div class="muted" id="avaMsg" style="font-size:13px;margin-top:4px"></div></div></div>`;
}
function mountAvatarEditor(root, uid) {
  const pick = root.querySelector('#avaPick'), file = root.querySelector('#avaFile'), msg = root.querySelector('#avaMsg');
  const refresh = (url) => {
    const u = state.users.get(uid);
    if (u) u.avatar = url;
    if (uid === state.me.id) state.me.avatar = url;
    root.querySelector('.ava-edit .avatar').outerHTML = avatar({ ...(u || { id: uid, name: '?' }), avatar: url }, 'xl');
    renderSidebar(); if (state.view === 'chat') renderMessages(false);
  };
  pick.onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files[0];
    if (!f) return;
    msg.textContent = 'Загрузка…';
    try {
      const blob = await squareJpeg(f, 256);
      const path = `${uid}/${crypto.randomUUID()}.jpg`;
      const up = await sb.storage.from('sl-avatars').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
      if (up.error) throw up.error;
      const url = sb.storage.from('sl-avatars').getPublicUrl(path).data.publicUrl;
      check(await sb.rpc('sl_set_avatar', { p_user: uid, p_url: url }));
      msg.textContent = 'Фото сохранено';
      refresh(url);
    } catch (e) { msg.textContent = humanError(e); }
  };
  const del = root.querySelector('#avaDel');
  if (del) del.onclick = async () => {
    try { check(await sb.rpc('sl_set_avatar', { p_user: uid, p_url: '' })); refresh(''); del.remove(); msg.textContent = 'Фото убрано'; }
    catch (e) { msg.textContent = humanError(e); }
  };
}
// Обрезка по центру до квадрата и уменьшение — аватарка весит ~20 КБ
function squareJpeg(file, size) {
  return new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(img.naturalWidth, img.naturalHeight);
      const c = document.createElement('canvas'); c.width = c.height = size;
      c.getContext('2d').drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('Не удалось обработать фото'))), 'image/jpeg', 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Это не похоже на фото')); };
    img.src = url;
  });
}
const STATUS_PRESETS = [['📅', 'На встрече'], ['🏖', 'В отпуске'], ['🚗', 'В дороге'], ['🤒', 'Болею'], ['🏠', 'Работаю из дома'], ['🍽', 'Обед']];
function profileFieldsHtml(u, { admin = false } = {}) {
  return `<div class="row">
      <label class="field"><span>Телефон</span><input id="pfPhone" type="tel" maxlength="30" value="${esc(u.phone || '')}" placeholder="+7 900 000-00-00"></label>
      <label class="field"><span>День рождения</span><input id="pfBday" type="date" value="${esc(u.birthday || '')}"></label>
    </div>
    <label class="field"><span>Отдел</span><input id="pfDept" maxlength="60" value="${esc(u.department || '')}" placeholder="например, Бухгалтерия"></label>`;
}
const readProfileFields = (root) => ({ phone: root.querySelector('#pfPhone').value, birthday: root.querySelector('#pfBday').value, department: root.querySelector('#pfDept').value });
function openMyProfile() {
  const me = state.users.get(state.me.id) || state.me;
  const until = me.statusUntil && me.statusUntil > Date.now() ? ymd(new Date(me.statusUntil)) : '';
  openModal(`<h3>Мой профиль</h3>
    <div class="modal-body">
      ${avatarEditorHtml(me)}
      <div class="td-row"><span>Имя</span><span>${esc(me.name)}</span></div>
      ${me.position ? `<div class="td-row"><span>Должность</span><span>${esc(me.position)}</span></div>` : ''}
      <div class="td-row"><span>Логин</span><span>${esc(me.login || '')}</span></div>
      <div class="disc-title">Статус</div>
      <div class="presets">${STATUS_PRESETS.map(([e, t]) => `<button type="button" class="hbtn" data-e="${e}" data-t="${t}">${e} ${t}</button>`).join('')}</div>
      <div class="row">
        <label class="field" style="flex:0 0 70px"><span>Значок</span><input id="stEmoji" maxlength="8" value="${esc(me.statusEmoji)}"></label>
        <label class="field"><span>Текст</span><input id="stText" maxlength="80" value="${esc(me.statusText)}" placeholder="например, В отпуске"></label>
      </div>
      <div class="row">
        <label class="field"><span>До (включительно)</span><input id="stUntil" type="date" value="${until}"></label>
        <div class="field" style="align-self:flex-end"><button type="button" class="secondary" id="stClear">Очистить статус</button></div>
      </div>
      <div class="disc-title">Не беспокоить</div>
      <label class="check"><input type="checkbox" id="dnd" ${me.dnd ? 'checked' : ''}> Без уведомлений в тихие часы (звонки и объявления — всегда)</label>
      <div class="row">
        <label class="field"><span>С</span><input id="dndFrom" type="time" value="${esc(me.dndFrom)}"></label>
        <label class="field"><span>До</span><input id="dndTo" type="time" value="${esc(me.dndTo)}"></label>
      </div>
      <div class="disc-title">Контакты</div>
      ${profileFieldsHtml(me)}
      <div class="modal-err" id="mErr"></div>
    </div>
    <div class="modal-foot"><span class="spacer"></span><button class="secondary" data-close>Отмена</button><button class="primary" id="pfSave">Сохранить</button></div>`,
  (root) => {
    root.querySelector('[data-close]').onclick = closeModal;
    mountAvatarEditor(root, me.id);
    root.querySelectorAll('.presets [data-e]').forEach((b) => b.onclick = () => { root.querySelector('#stEmoji').value = b.dataset.e; root.querySelector('#stText').value = b.dataset.t; });
    root.querySelector('#stClear').onclick = () => { root.querySelector('#stEmoji').value = ''; root.querySelector('#stText').value = ''; root.querySelector('#stUntil').value = ''; };
    root.querySelector('#pfSave').onclick = async () => {
      const u = root.querySelector('#stUntil').value;
      try {
        const row = check(await sb.rpc('sl_set_profile', { p_user: me.id, p: {
          statusEmoji: root.querySelector('#stEmoji').value.trim(), statusText: root.querySelector('#stText').value,
          statusUntil: u ? new Date(u + 'T23:59:59').toISOString() : '',
          dnd: root.querySelector('#dnd').checked, dndFrom: root.querySelector('#dndFrom').value || '22:00', dndTo: root.querySelector('#dndTo').value || '08:00',
          ...readProfileFields(root) } }));
        onProfileChange({ eventType: 'UPDATE', new: row });
        closeModal(); toast('Профиль сохранён');
      } catch (e) { root.querySelector('#mErr').textContent = humanError(e); }
    };
  });
}
// Справочник сотрудников
function openDirectory() {
  const list = activeUsers().sort((a, b) => (a.department || 'я').localeCompare(b.department || 'я', 'ru') || a.name.localeCompare(b.name, 'ru'));
  const fmtB = (d) => d ? new Date(d + 'T12:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) : '';
  const row = (u) => `<div class="dir-row" data-name="${esc((u.name + ' ' + u.position + ' ' + u.department + ' ' + u.phone).toLowerCase())}">
      <span class="sava">${avatar(u)}<span class="dot ${state.online.has(u.id) ? 'on' : ''}"></span></span>
      <div class="u-main"><div class="u-name">${esc(u.name)}${u.id === state.me.id ? ' (вы)' : ''}</div>
        <div class="u-meta">${[u.position, u.department].filter(Boolean).map(esc).join(' · ') || '&nbsp;'}</div>
        ${statusOf(u) ? `<div class="u-meta">${esc(statusOf(u))}</div>` : ''}
        <div class="u-meta">${u.phone ? `📞 <a href="tel:${esc(u.phone.replace(/[^\d+]/g, ''))}">${esc(u.phone)}</a>` : ''}${u.birthday ? ` · 🎂 ${fmtB(u.birthday)}` : ''}</div></div>
      ${u.id !== state.me.id ? `<div class="u-actions"><button data-chat="${u.id}">💬</button><button data-call="${u.id}">📞</button></div>` : ''}</div>`;
  openModal(`<h3>👥 Сотрудники (${list.length})</h3><div class="modal-body">
    <label class="field"><input id="dirQ" placeholder="Поиск по имени, отделу, должности, телефону"></label>
    <div id="dirList">${list.map(row).join('')}</div></div>
    <div class="modal-foot"><span class="spacer"></span><button class="primary" data-close>Закрыть</button></div>`,
  (root) => {
    root.querySelector('[data-close]').onclick = closeModal;
    root.querySelector('#dirQ').oninput = (e) => { const q = e.target.value.toLowerCase().trim(); root.querySelectorAll('.dir-row').forEach((r) => r.classList.toggle('hidden', !!q && !r.dataset.name.includes(q))); };
    root.querySelectorAll('[data-chat]').forEach((b) => b.onclick = () => { closeModal(); openChat(dmKey(state.me.id, b.dataset.chat)); });
    root.querySelectorAll('[data-call]').forEach((b) => b.onclick = () => { closeModal(); const c = dmKey(state.me.id, b.dataset.call); openChat(c); joinCall(c); });
  }, 'wide');
}
// История звонков
async function openCallHistory() {
  openModal(`<h3>📞 Звонки</h3><div class="modal-body" id="chList"><p class="muted">Загрузка…</p></div>
    <div class="modal-foot"><span class="spacer"></span><button class="primary" data-close>Закрыть</button></div>`, (root) => root.querySelector('[data-close]').onclick = closeModal, 'wide');
  try {
    const rows = check(await sb.from('sl_calls').select('*').order('started_at', { ascending: false }).limit(60));
    const box = $('#chList');
    if (!box) return;
    box.innerHTML = rows.filter((c) => chatTitle(c.chat)).map((c) => {
      const missed = c.ended_at && c.participants.length < 2 && c.started_by !== state.me.id;
      const out = c.started_by === state.me.id;
      const dur = c.ended_at && c.participants.length > 1 ? Math.max(1, Math.round((Date.parse(c.ended_at) - Date.parse(c.started_at)) / 60000)) + ' мин' : '';
      const who = c.participants.filter((id) => id !== state.me.id).map(userName).join(', ');
      const st = !c.ended_at ? '<span class="call-live">идёт сейчас</span>' : missed ? '<span class="bad">пропущенный</span>' : c.participants.length < 2 ? 'без ответа' : dur;
      return `<div class="person" data-chat="${esc(c.chat)}"><span>${missed ? '↙️' : out ? '↗️' : '↙️'}</span>
        <span style="flex:1;min-width:0"><b class="${missed ? 'bad' : ''}">${esc(chatTitle(c.chat))}</b>
        <div class="u-meta">${new Date(c.started_at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${st}${who && !c.chat.startsWith('d:') ? ' · ' + esc(who) : ''}</div></span>
        <button class="hbtn" data-cb="${esc(c.chat)}">📞</button></div>`;
    }).join('') || '<p class="muted">Звонков пока не было</p>';
    box.querySelectorAll('[data-cb]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); closeModal(); openChat(b.dataset.cb); joinCall(b.dataset.cb); });
    box.querySelectorAll('.person[data-chat]').forEach((el) => el.onclick = () => { closeModal(); openChat(el.dataset.chat); });
  } catch (e) { const b = $('#chList'); if (b) b.innerHTML = `<p class="modal-err">${esc(humanError(e))}</p>`; }
}
// Объявления с ознакомлением
state.anns = [];
async function loadAnnouncements() {
  try {
    const [a, k] = await Promise.all([
      sb.from('sl_announcements').select('*').eq('active', true).order('id', { ascending: false }).limit(20),
      sb.from('sl_acks').select('announcement_id, user_id, at'),
    ]);
    const acks = k.data || [];
    state.anns = (a.data || []).map((x) => ({ ...x, acks: acks.filter((r) => r.announcement_id === x.id) }));
  } catch {}
  renderAnnBar();
  if (state.view === 'admin') renderAnnAdmin();
}
function renderAnnBar() {
  const bar = $('#annBar');
  const pending = state.anns.filter((a) => !a.acks.some((r) => r.user_id === state.me.id) && a.created_by !== state.me.id);
  if (!pending.length) { bar.classList.add('hidden'); return; }
  const a = pending[pending.length - 1];
  bar.innerHTML = `<span class="ann-ico">📢</span><div class="ann-text"><b>Объявление · ${esc(userName(a.created_by))}, ${new Date(a.created_at).toLocaleDateString('ru-RU')}</b><div>${linkify(a.text)}</div></div>
    <button class="primary" id="annAck">Ознакомлен(а)${pending.length > 1 ? ` · ещё ${pending.length - 1}` : ''}</button>`;
  bar.classList.remove('hidden');
  $('#annAck').onclick = async () => {
    try { check(await sb.from('sl_acks').insert({ announcement_id: a.id, user_id: state.me.id })); a.acks.push({ user_id: state.me.id, at: new Date().toISOString() }); renderAnnBar(); }
    catch (e) { toast(humanError(e)); }
  };
}
function renderAnnAdmin() {
  const card = $('#annCard');
  if (!card) return;
  const total = activeUsers().length;
  card.innerHTML = `<div class="admin-card-title">📢 Объявления</div>
    <textarea id="annText" rows="3" maxlength="4000" placeholder="Текст объявления для всех сотрудников. Каждый увидит его сверху и нажмёт «Ознакомлен(а)»." style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px"></textarea>
    <div style="display:flex;justify-content:flex-end;margin:6px 0 12px"><button class="primary" id="annPost">Опубликовать</button></div>
    ${state.anns.map((a) => `<div class="u-row"><div class="u-main"><div class="u-name" style="white-space:pre-wrap">${esc(a.text.slice(0, 300))}</div>
      <div class="u-meta">${new Date(a.created_at).toLocaleString('ru-RU')} · <a href="#" data-acks="${a.id}">ознакомились ${a.acks.length} из ${Math.max(0, total - 1)}</a></div></div>
      <div class="u-actions"><button data-off="${a.id}">Снять</button></div></div>`).join('') || '<div class="muted">Активных объявлений нет</div>'}`;
  $('#annPost').onclick = async () => {
    const text = $('#annText').value.trim();
    if (!text) return;
    try { check(await sb.from('sl_announcements').insert({ text, created_by: state.me.id })); toast('📢 Объявление опубликовано'); loadAnnouncements(); }
    catch (e) { toast(humanError(e)); }
  };
  card.querySelectorAll('[data-off]').forEach((b) => b.onclick = async () => {
    if (!confirm('Снять объявление? Оно перестанет показываться сотрудникам.')) return;
    try { check(await sb.from('sl_announcements').update({ active: false }).eq('id', Number(b.dataset.off))); loadAnnouncements(); } catch (e) { toast(humanError(e)); }
  });
  card.querySelectorAll('[data-acks]').forEach((l) => l.onclick = (e) => {
    e.preventDefault();
    const a = state.anns.find((x) => x.id === Number(l.dataset.acks));
    const yes = a.acks.map((r) => `${esc(userName(r.user_id))} — ${new Date(r.at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`);
    const no = activeUsers().filter((u) => u.id !== a.created_by && !a.acks.some((r) => r.user_id === u.id)).map((u) => esc(u.name));
    openModal(`<h3>Ознакомление</h3><div class="modal-body"><p><b>Ознакомились:</b><br>${yes.join('<br>') || '—'}</p><p><b>Ещё нет:</b><br>${no.join('<br>') || '—'}</p></div>
      <div class="modal-foot"><span class="spacer"></span><button class="primary" data-close>Закрыть</button></div>`, (root) => root.querySelector('[data-close]').onclick = closeModal);
  });
}
// Каналы только для чтения (админ)
function renderChannelsAdmin() {
  const card = $('#chanCard');
  if (!card) return;
  card.innerHTML = `<div class="admin-card-title">Каналы</div>
    ${state.channels.map((c) => `<label class="check"><input type="checkbox" data-ro="${c.id}" ${c.readonly ? 'checked' : ''}> # ${esc(c.name)} — только чтение (пишут администраторы)</label>`).join('')}`;
  card.querySelectorAll('[data-ro]').forEach((cb) => cb.onchange = async () => {
    try { await rpc('sl_set_channel_readonly', { p_id: Number(cb.dataset.ro), p_ro: cb.checked }); const c = state.channels.find((x) => x.id === Number(cb.dataset.ro)); if (c) c.readonly = cb.checked; toast('Сохранено'); }
    catch (e) { toast(humanError(e)); cb.checked = !cb.checked; }
  });
}
// Выгрузка переписки в файл (HTML — открывается в любом браузере, можно распечатать или сохранить в PDF)
async function exportChat(chat) {
  toast('Готовлю выгрузку…');
  try {
    let all = [], before = null;
    for (let i = 0; i < 200; i++) {
      let q = sb.from('sl_messages').select('*').eq('chat', chat).order('id', { ascending: false }).limit(1000);
      if (before) q = q.lt('id', before);
      const rows = check(await q);
      all = all.concat(rows);
      if (rows.length < 1000) break;
      before = rows[rows.length - 1].id;
    }
    all.reverse();
    const title = chatTitle(chat);
    let day = '';
    const body = all.map((r) => {
      const m = msgFromRow(r), d = new Date(m.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
      const dh = d !== day ? `<h3>${d}</h3>` : ''; day = d;
      if (m.system) return dh + `<p class="sys">${esc(m.text)} · ${fmtTime(m.createdAt)}</p>`;
      const f = m.file ? `<div class="f">📎 ${esc(m.file.voice ? 'Голосовое сообщение ' + fmtDur(m.file.duration) : m.file.name)}${m.file.size ? ' (' + fmtSize(m.file.size) + ')' : ''}</div>` : '';
      const q = m.replyTo ? (() => { const x = all.find((y) => y.id === m.replyTo); return x ? `<div class="q">↩ ${esc(userName(x.user_id))}: ${esc((x.text || '').slice(0, 100))}</div>` : ''; })() : '';
      return dh + `<div class="m"><span class="t">${fmtTime(m.createdAt)}</span> <b>${esc(userName(m.userId))}</b>${m.editedAt ? ' <i>(изменено)</i>' : ''}${q}<div>${esc(m.text).replace(/\n/g, '<br>')}</div>${f}</div>`;
    }).join('\n');
    const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><title>${esc(title)} — Shtark Link</title>
<style>body{font:14px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:800px;margin:24px auto;padding:0 16px;color:#1d2129}h1{font-size:20px}h3{font-size:13px;color:#6b7280;border-bottom:1px solid #e5e7eb;padding-bottom:4px;margin-top:24px}.m{margin:8px 0}.t{color:#9ca3af;font-size:12px}.sys{color:#6b7280;font-size:13px;text-align:center}.q{border-left:3px solid #93c5fd;padding-left:8px;color:#6b7280;font-size:13px}.f{color:#2563eb;font-size:13px}</style>
<h1>${esc(title)}</h1><p style="color:#6b7280">Выгрузка из Shtark Link · ${new Date().toLocaleString('ru-RU')} · сообщений: ${all.length}. Файлы указаны названиями, сами файлы скачиваются в чате.</p>
${body}</html>`;
    saveFile(html, `${title.replace(/[\\/:*?"<>|#]/g, '').trim() || 'Чат'} ${ymd(new Date())}.html`, 'text/html');
  } catch (e) { toast('Не удалось выгрузить: ' + humanError(e)); }
}
$('#meName').onclick = openMyProfile;
$('#navPeople').onclick = () => { setSidebar(false); openDirectory(); };
$('#navCalls').onclick = () => { setSidebar(false); openCallHistory(); };

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
    sb.from('sl_profiles').select('id, login, name, position, avatar_url, is_admin, disabled, status_text, status_emoji, status_until, dnd, dnd_from, dnd_to, phone, department, birthday'),
    sb.from('sl_channels').select('id, name, readonly').order('id'),
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
  loadUnread();
  loadAnnouncements();
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

const posOf = (id) => state.users.get(id)?.position || '';
function profileFromRow(u) {
  return { id: u.id, login: u.login, name: u.name, position: u.position || '', avatar: u.avatar_url || '', isAdmin: !!u.is_admin, disabled: !!u.disabled,
    statusText: u.status_text || '', statusEmoji: u.status_emoji || '', statusUntil: u.status_until ? Date.parse(u.status_until) : null,
    dnd: !!u.dnd, dndFrom: u.dnd_from || '22:00', dndTo: u.dnd_to || '08:00', phone: u.phone || '', department: u.department || '', birthday: u.birthday || '' };
}
// статус («🏖 В отпуске до 25.11»), если не истёк
function statusOf(u) {
  if (!u || (!u.statusText && !u.statusEmoji) || (u.statusUntil && u.statusUntil < Date.now())) return '';
  const until = u.statusUntil ? ' до ' + new Date(u.statusUntil).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '';
  return `${u.statusEmoji ? u.statusEmoji + ' ' : ''}${u.statusText}${until}`.trim();
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
document.addEventListener('visibilitychange', () => { if (!document.hidden) { heartbeat(); updateTitle(); if (state.view === 'chat') markRead(); } });

sb.auth.onAuthStateChange((event, session) => {
  if (event === 'TOKEN_REFRESHED' && session) sb.realtime.setAuth(session.access_token);
  if (event === 'SIGNED_OUT' && state.me) location.reload();
});

// ---------- Realtime ----------
function connectRealtime() {
  let firstDb = true;
  state.db = sb.channel('sl-db')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sl_messages' }, (p) => onMessage(msgFromRow(p.new)))
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'sl_messages' }, (p) => p.old?.id && onMessageDeleted(p.old.id))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'sl_messages' }, (p) => onMessageUpdated(msgFromRow(p.new)))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sl_reactions' }, onReactionChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sl_reads' }, onReadChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sl_profiles' }, onProfileChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sl_channels' }, (p) => {
      if (!p.new?.id) return;
      const c = state.channels.find((c) => c.id === p.new.id);
      if (c) Object.assign(c, { name: p.new.name, readonly: !!p.new.readonly });
      else state.channels.push({ id: p.new.id, name: p.new.name, readonly: !!p.new.readonly });
      renderSidebar();
      if (state.view === 'chat' && state.current === 'c:' + p.new.id) renderChatHeader();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sl_announcements' }, () => loadAnnouncements())
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sl_acks' }, () => loadAnnouncements())
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
    await loadUnread();
    loadAnnouncements();
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

// Звук входящего сообщения (короткий «дзынь»). Браузер разрешает звук после первого касания/клика.
let pingCtx = null;
function soundOn() { try { return localStorage.getItem('sl-sound') !== '0'; } catch { return true; } }
function unlockPing() {
  try {
    if (!pingCtx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) pingCtx = new AC(); }
    pingCtx?.resume?.();
  } catch {}
}
['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, unlockPing, { passive: true }));
function playPing(soft = false) {
  if (!soundOn() || !pingCtx || call.room) return; // во время звонка не мешаем
  try {
    const t = pingCtx.currentTime + 0.02, vol = soft ? 0.05 : 0.14;
    [[880, 0], [1320, 0.11]].forEach(([f, d]) => {
      const o = pingCtx.createOscillator(), g = pingCtx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t + d); g.gain.linearRampToValueAtTime(vol, t + d + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.28);
      o.connect(g).connect(pingCtx.destination); o.start(t + d); o.stop(t + d + 0.3);
    });
  } catch {}
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
  const item = (chat, label, prefix, sub = '') => {
    const n = state.unread.get(chat) || 0;
    const active = state.view === 'chat' && chat === state.current;
    const live = callCount(chat) ? '<span class="call-ind" title="Идёт звонок">📞</span>' : '';
    return `<div class="chat-item ${active ? 'active' : ''} ${n ? 'unread' : ''}" data-chat="${chat}">
      ${prefix}<span class="label">${esc(label)}${sub ? `<small class="pos">${esc(sub)}</small>` : ''}</span>${live}${n ? `<span class="badge ${state.popChat === chat ? 'pop' : ''}">${n}</span>` : ''}</div>`;
  };
  $('#channelList').innerHTML = state.channels.map((c) => item(`c:${c.id}`, c.name, '<span class="ico">#</span>')).join('');
  const groups = [...state.groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  $('#groupList').innerHTML = groups.length
    ? groups.map((g) => item(`g:${g.id}`, g.name, '<span class="ico">👥</span>')).join('')
    : '<div class="side-hint">Нажмите +, чтобы создать</div>';
  const users = activeUsers().sort((a, b) => (state.online.has(b.id) - state.online.has(a.id)) || a.name.localeCompare(b.name, 'ru'));
  $('#userList').innerHTML = users.map((u) =>
    item(dmKey(state.me.id, u.id), (u.id === state.me.id ? u.name + ' (вы)' : u.name) + (statusOf(u) && u.statusEmoji ? ' ' + u.statusEmoji : ''), `<span class="sava">${avatar(u, 'sm')}<span class="dot ${state.online.has(u.id) ? 'on' : ''}"></span></span>`, statusOf(u) || u.position)
  ).join('');
  document.querySelectorAll('.chat-item[data-chat]').forEach((el) => el.onclick = () => openChat(el.dataset.chat));
  state.popChat = null;
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

// Меню на телефоне: открыть ☰; закрыть — ✕, нажатием на затемнение справа или смахиванием влево
function setSidebar(open) { $('#sidebar').classList.toggle('open', open); $('#sideShade').classList.toggle('hidden', !open); }
document.querySelectorAll('.menuBtn').forEach((b) => b.onclick = () => setSidebar(!$('#sidebar').classList.contains('open')));
$('#sideShade').onclick = () => setSidebar(false);
$('#sideClose').onclick = () => setSidebar(false);
{
  let x0 = null, y0 = 0;
  $('#sidebar').addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  $('#sidebar').addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = Math.abs(e.changedTouches[0].clientY - y0);
    if (dx < -60 && dy < 50) setSidebar(false);
    x0 = null;
  }, { passive: true });
}

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
  setSidebar(false);
}

function renderChatHeader() {
  const chat = state.current;
  if (!chat) return;
  $('#chatTitle').innerHTML = esc(chatTitle(chat));
  let actions = '';
  const n = callCount(chat);
  const callBtn = call.chat === chat ? ''
    : n ? `<button class="hbtn" id="callBtn" style="border-color:#22c55e;color:#16a34a">📞 <span class="lbl">Присоединиться</span> (${n})</button>`
    : `<button class="hbtn" id="callBtn" title="Голосовой звонок">📞 <span class="lbl">${chat.startsWith('d:') ? 'Позвонить' : 'Созвон'}</span></button>`;
  if (chat.startsWith('g:')) {
    const g = state.groups.get(Number(chat.slice(2)));
    if (g) actions = `<button class="hbtn" id="groupBtn">👥 ${g.members.length} ${plural(g.members.length, 'участник', 'участника', 'участников')}</button>`;
  } else if (chat.startsWith('d:')) {
    const [, a, b] = chat.split(':');
    const other = state.users.get(a === state.me.id ? b : a);
    if (other && other.id !== state.me.id) {
      $('#chatTitle').innerHTML += `<span class="sub">${statusOf(other) ? esc(statusOf(other)) + ' · ' : ''}${other.position ? esc(other.position) + ' · ' : ''}${state.online.has(other.id) ? 'в сети' : 'не в сети'}</span>`;
      actions = `<button class="hbtn" id="assignBtn" data-uid="${other.id}" title="Поручить задачу">📋 <span class="lbl">Поручить задачу</span></button>`;
    }
  }
  const self = chat.startsWith('d:') && chat.split(':')[1] === chat.split(':')[2];
  if (isReadonly(chat)) $('#chatTitle').innerHTML += '<span class="sub">🔒 только чтение</span>';
  const ro = isReadonly(chat) && !state.me.isAdmin;
  $('#readonlyNote').classList.toggle('hidden', !ro);
  document.querySelector('#chatView .input-row').classList.toggle('hidden', ro);
  actions += `<button class="hbtn" id="exportBtn" title="Выгрузить переписку в файл">⬇</button>`;
  $('#chatActions').innerHTML = (self ? '' : callBtn) + ' ' + actions;
  $('#chatActions').style.display = 'flex';
  $('#chatActions').style.gap = '8px';
  const gb = $('#groupBtn');
  if (gb) gb.onclick = () => openGroupSettings(Number(chat.slice(2)));
  const ab = $('#assignBtn');
  if (ab) ab.onclick = () => openTaskForm({ assigneeId: ab.dataset.uid });
  const cb = $('#callBtn');
  if (cb) cb.onclick = () => joinCall(chat);
  $('#exportBtn').onclick = () => exportChat(chat);
  renderPinBar();
}

function msgFromRow(r) {
  return { id: r.id, chat: r.chat, userId: r.user_id, text: r.text, file: r.file, system: r.system, createdAt: Date.parse(r.created_at),
    replyTo: r.reply_to || null, editedAt: r.edited_at ? Date.parse(r.edited_at) : null, pinnedAt: r.pinned_at ? Date.parse(r.pinned_at) : null,
    pinnedBy: r.pinned_by || null, mentions: r.mentions || [], sticker: r.sticker || null };
}
async function fetchMessages(chat, beforeId) {
  let q = sb.from('sl_messages').select('*').eq('chat', chat).order('id', { ascending: false }).limit(50);
  if (beforeId) q = q.lt('id', beforeId);
  const msgs = check(await q).reverse().map(msgFromRow);
  await loadExtras(msgs);
  return msgs;
}

function onMessage(m) {
  if (m.userId !== state.me.id) state.popChat = m.chat; // счётчик этого чата «подпрыгнет»
  const list = state.messages.get(m.chat);
  if (list && !list.some((x) => x.id === m.id)) list.push(m);
  const visible = state.view === 'chat' && m.chat === state.current;
  if (visible) { appendMessage(m); clearTyping(m.userId); if (!document.hidden) markRead(); }
  if (m.userId !== state.me.id && !m.system) playPing(visible && !document.hidden); // в открытом чате — тише
  if (m.userId !== state.me.id && !m.system && (!visible || document.hidden)) {
    if (!visible) state.unread.set(m.chat, (state.unread.get(m.chat) || 0) + 1);
    notify(m);
    renderSidebar();
  }
}

// Удаление сообщения: своё — автор, любое — администратор
async function deleteMessage(id) {
  const m = (state.messages.get(state.current) || []).find((x) => x.id === id);
  if (!m || !confirm('Удалить сообщение у всех?')) return;
  try {
    const { data, error } = await sb.from('sl_messages').delete().eq('id', id).select('id');
    if (error) throw error;
    if (!data?.length) return toast('Не удалось удалить сообщение');
    if (m.file?.path && m.userId === state.me.id) sb.storage.from('sl-files').remove([m.file.path]).catch(() => {});
    onMessageDeleted(id);
  } catch (e) { toast(humanError(e)); }
}
function onMessageDeleted(id) {
  for (const [chat, list] of state.messages) {
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) continue;
    list.splice(i, 1);
    if (state.view === 'chat' && state.current === chat) {
      const box = $('#messages'), top = box.scrollTop;
      renderMessages(false);
      box.scrollTop = top;
    }
  }
}

async function openChat(chat) {
  if (!chat || !chatTitle(chat)) chat = `c:${state.channels[0]?.id}`;
  if (chat !== state.current) { state.replyTo = null; state.editing = null; renderComposerBar(); }
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
  markRead();
  loadPins(chat);
  if (!matchMedia('(hover: none)').matches) $('#input').focus();
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
  const dayHtml = newDay ? `<div class="day"><span>${fmtDay(m.createdAt)}</span></div>` : '';
  if (m.system) return dayHtml + `<div class="sys" data-id="${m.id}">${esc(m.text)} · ${fmtTime(m.createdAt)}</div>`;
  const u = state.users.get(m.userId) || { name: 'Сотрудник', id: m.userId };
  const mine = m.userId === state.me.id;
  const cont = !newDay && prev && !prev.system && prev.userId === m.userId && m.createdAt - prev.createdAt < 5 * 60e3 && !m.replyTo;
  let file = '';
  if (m.file) {
    const f = m.file;
    if (f.voice) {
      file = `<div class="voice"><audio controls preload="none" data-path="${esc(f.path)}"></audio><span class="fsize">${fmtDur(f.duration)}</span></div>`;
    } else if (isImage(f)) {
      file = `<img class="img-preview" data-path="${esc(f.path)}" alt="${esc(f.name)}">
        <a class="file-card" href="#" data-path="${esc(f.path)}" data-name="${esc(f.name)}" style="padding:4px 10px"><span class="fsize">⬇ ${esc(f.name)} · ${fmtSize(f.size)}</span></a>`;
    } else {
      const ext = (f.name.includes('.') ? f.name.split('.').pop() : '').slice(0, 4).toUpperCase();
      file = `<a class="file-card" href="#" data-path="${esc(f.path)}" data-name="${esc(f.name)}"><span class="file-icon">${esc(ext || 'FILE')}</span>
        <span style="min-width:0"><div class="fname">${esc(f.name)}</div><div class="fsize">${fmtSize(f.size)} · скачать</div></span></a>`;
    }
  }
  const toMe = !mine && (m.mentions.includes(state.me.id) || (m.replyTo && findMsg(m.replyTo)?.userId === state.me.id));
  const canPin = !(isReadonly(m.chat) && !state.me.isAdmin);
  const acts = `<div class="msg-acts">
      <button data-act="react" title="Реакция">😊</button><button data-act="reply" title="Ответить">↩</button>
      ${mine && !m.file?.voice && !m.sticker ? '<button data-act="edit" title="Изменить">✏️</button>' : ''}
      ${canPin ? `<button data-act="pin" title="${m.pinnedAt ? 'Открепить' : 'Закрепить'}">📌</button>` : ''}
      <button data-act="task" title="Сделать задачу">📋</button>
      ${mine || state.me.isAdmin ? '<button data-act="del" title="Удалить">🗑</button>' : ''}
    </div>`;
  return dayHtml +
    `<div class="msg ${cont ? 'cont' : ''} ${mine ? 'mine' : ''} ${toMe ? 'tome' : ''} ${m.sticker ? 'has-sticker' : ''}" data-id="${m.id}">
      ${avatar(u)}
      <div class="body">
        <div class="meta"><b>${esc(u.name)}${u.statusEmoji && statusOf(u) ? ' ' + esc(u.statusEmoji) : ''}${u.disabled ? ' <span class="muted">(отключён)</span>' : ''}</b>${u.position ? `<span class="pos">${esc(u.position)}</span>` : ''}<span>${fmtTime(m.createdAt)}</span>${m.pinnedAt ? '<span title="Закреплено">📌</span>' : ''}</div>
        ${m.replyTo ? quoteHtml(m.replyTo) : ''}
        ${m.sticker ? `<img class="sticker" src="stickers/${esc(m.sticker)}.svg" alt="${esc(m.text)}" title="${esc(m.text)}">` : m.text ? `<div class="text">${richText(m)}</div>` : ''}
        ${file}
        <div class="msg-foot">${reactsHtml(m)}<span class="mt">${m.editedAt ? 'изменено · ' : ''}${cont || mine ? fmtTime(m.createdAt) : ''}${mine && m.pinnedAt ? ' 📌' : ''}${mine ? ticksHtml(m) : ''}</span></div>
        ${acts}
      </div></div>`;
}
const fmtDur = (s) => { s = Math.round(s || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
function findMsg(id) {
  for (const list of state.messages.values()) { const m = list.find((x) => x.id === id); if (m) return m; }
  return state.quoted.get(id) || null;
}
function isReadonly(chat) { return chat?.startsWith('c:') && !!state.channels.find((c) => `c:${c.id}` === chat)?.readonly; }
function richText(m) {
  let h = linkify(m.text);
  for (const id of m.mentions || []) {
    const u = state.users.get(id);
    if (u) h = h.split('@' + esc(u.name)).join(`<span class="mention ${id === state.me.id ? 'mention-me' : ''}">@${esc(u.name)}</span>`);
  }
  return h;
}
function quoteHtml(id) {
  const q = findMsg(id);
  if (!q) return `<div class="quote" data-jump="${id}"><i>Сообщение удалено</i></div>`;
  const snippet = q.text || (q.file ? (q.file.voice ? '🎤 Голосовое сообщение' : '📎 ' + q.file.name) : '');
  return `<div class="quote" data-jump="${id}"><b>${esc(userName(q.userId))}</b><span>${esc(snippet.slice(0, 120))}</span></div>`;
}
function reactsHtml(m) {
  const r = state.reactions.get(m.id);
  if (!r || !r.size) return '';
  return '<span class="reacts">' + [...r.entries()].filter(([, set]) => set.size).map(([e, set]) =>
    `<button class="react ${set.has(state.me.id) ? 'on' : ''}" data-emoji="${esc(e)}" title="${esc([...set].map(userName).join(', '))}">${esc(e)} ${set.size}</button>`).join('') + '</span>';
}
// ✓ — отправлено, ✓✓ — прочитано (в группах — сколько человек прочитали)
function ticksHtml(m) {
  const reads = state.reads.get(m.chat);
  const readers = reads ? [...reads.entries()].filter(([uid, last]) => uid !== state.me.id && last >= m.id).map(([uid]) => uid) : [];
  if (m.chat.startsWith('d:')) return readers.length ? ' <span class="tick read" title="Прочитано">✓✓</span>' : ' <span class="tick">✓</span>';
  return readers.length ? ` <span class="tick read" data-readers="${m.id}" title="Кто прочитал">✓✓ ${readers.length}</span>` : ' <span class="tick">✓</span>';
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
  const audios = [...root.querySelectorAll('audio[data-path]:not([src])')];
  if (audios.length) signedUrls(audios.map((a) => a.dataset.path)).then((u) => audios.forEach((a, i) => { if (u[i]) a.src = u[i]; })).catch(() => {});
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
  box.lastElementChild?.classList.add('anim'); // новое сообщение «влетает»
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
  const actBtn = e.target.closest('.msg-acts button');
  if (actBtn) return messageAction(actBtn.dataset.act, Number(actBtn.closest('.msg').dataset.id), actBtn);
  const reactBtn = e.target.closest('.react');
  if (reactBtn) return toggleReaction(Number(reactBtn.closest('.msg').dataset.id), reactBtn.dataset.emoji);
  const quote = e.target.closest('.quote[data-jump]');
  if (quote) return jumpTo(Number(quote.dataset.jump));
  const rd = e.target.closest('[data-readers]');
  if (rd) return showReaders(Number(rd.dataset.readers));
  // на телефоне (нет наведения) нажатие на своё сообщение показывает кнопку удаления
  const tapped = e.target.closest('.msg');
  if (tapped && !e.target.closest('a, img, audio, button')) {
    document.querySelectorAll('.msg.sel').forEach((x) => x !== tapped && x.classList.remove('sel'));
    tapped.classList.toggle('sel');
  }
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
async function downloadFile(path, name) {
  try {
    const { data, error } = await sb.storage.from('sl-files').download(path);
    if (error) throw error;
    const url = URL.createObjectURL(data);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (err) { toast('Не удалось скачать файл: ' + humanError(err)); }
}

async function send() {
  const text = $('#input').value.trim();
  const chat = state.current;
  if (state.editing) {
    const id = state.editing.id;
    try {
      const row = check(await sb.rpc('sl_edit_message', { p_id: id, p_text: text }));
      state.editing = null; renderComposerBar();
      $('#input').value = ''; autosize();
      onMessageUpdated(msgFromRow(row));
    } catch (e) { toast(humanError(e)); }
    return;
  }
  if (!text) return;
  const replyTo = state.replyTo?.id || null;
  // упоминания: @Имя Фамилия любого сотрудника чата
  const members = chatMembers(chat);
  const mentions = activeUsers().filter((u) => u.id !== state.me.id && members.includes(u.id) && text.includes('@' + u.name)).map((u) => u.id);
  $('#input').value = '';
  autosize();
  state.replyTo = null; renderComposerBar();
  try {
    const row = check(await sb.from('sl_messages').insert({ chat, user_id: state.me.id, text, reply_to: replyTo, mentions }).select().single());
    onMessage(msgFromRow(row));
  } catch (e) {
    $('#input').value = text; autosize();
    toast('Сообщение не отправлено: ' + humanError(e));
  }
}
$('#sendBtn').onclick = () => { const b = $('#sendBtn'); b.classList.remove('sent'); void b.offsetWidth; b.classList.add('sent'); send(); };
$('#input').addEventListener('keydown', (e) => {
  if (mentionKey(e)) return;
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  if (e.key === 'Escape' && (state.replyTo || state.editing)) { if (state.editing) $('#input').value = ''; state.replyTo = state.editing = null; renderComposerBar(); }
  if (e.key === 'ArrowUp' && !$('#input').value) { // ↑ в пустом поле — изменить своё последнее сообщение
    const last = [...(state.messages.get(state.current) || [])].reverse().find((m) => m.userId === state.me.id && !m.system && !m.file && !m.sticker);
    if (last) { e.preventDefault(); messageAction('edit', last.id); }
  }
});
$('#input').addEventListener('input', () => {
  autosize();
  updateMentionPopup();
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
  $('#typing').innerHTML = names.length ? `<span class="typing-dots"><i></i><i></i><i></i></span> ${esc(names.join(', '))} ${names.length > 1 ? 'печатают' : 'печатает'}` : '';
}

// ---------- Файлы ----------
async function uploadFile(file, extra = {}) {
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
        file: { path, name: file.name, mime: file.type || 'application/octet-stream', size: file.size, ...extra },
        reply_to: extra.voice ? (state.replyTo?.id || null) : null,
      }).select().single());
      if (extra.voice && state.replyTo) { state.replyTo = null; renderComposerBar(); }
      row.remove();
      onMessage(msgFromRow(r));
    } catch (e) { fail(humanError(e)); }
  };
  xhr.send(file);
}
$('#attachBtn').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = (e) => { [...e.target.files].forEach((f) => uploadFile(f)); e.target.value = ''; };

let dragDepth = 0;
const chatView = $('#chatView');
chatView.addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { dragDepth++; $('#drop').classList.remove('hidden'); } });
chatView.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').classList.add('hidden'); } });
chatView.addEventListener('dragover', (e) => e.preventDefault());
chatView.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('#drop').classList.add('hidden');
  [...e.dataTransfer.files].forEach((f) => uploadFile(f));
});
$('#input').addEventListener('paste', (e) => {
  const files = [...e.clipboardData.files].map((f) => /^image\.(png|jpe?g)$/i.test(f.name) || !f.name
    ? new File([f], `Скриншот ${new Date().toLocaleString('ru-RU').replace(/[/:]/g, '.').replace(',', '')}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type }) : f);
  if (files.length) { e.preventDefault(); files.forEach((f) => uploadFile(f)); }
});


// ---------- Ответы, правка, реакции, прочитано, закреп, поиск, упоминания, голосовые ----------
async function loadExtras(msgs) {
  if (!msgs.length) return;
  const ids = msgs.map((m) => m.id);
  const missing = [...new Set(msgs.map((m) => m.replyTo).filter((id) => id && !ids.includes(id) && !findMsg(id)))];
  const [re, qu] = await Promise.all([
    sb.from('sl_reactions').select('message_id, user_id, emoji').in('message_id', ids),
    missing.length ? sb.from('sl_messages').select('*').in('id', missing) : Promise.resolve({ data: [] }),
  ]);
  ids.forEach((id) => state.reactions.delete(id));
  (re.data || []).forEach((r) => addReaction(r.message_id, r.emoji, r.user_id));
  (qu.data || []).forEach((r) => state.quoted.set(r.id, msgFromRow(r)));
  const chat = msgs[0].chat;
  if (!state.reads.has(chat)) {
    const { data } = await sb.from('sl_reads').select('user_id, last_id').eq('chat', chat);
    state.reads.set(chat, new Map((data || []).map((r) => [r.user_id, r.last_id])));
  }
}
function addReaction(id, emoji, uid) {
  if (!state.reactions.has(id)) state.reactions.set(id, new Map());
  const r = state.reactions.get(id);
  if (!r.has(emoji)) r.set(emoji, new Set());
  r.get(emoji).add(uid);
}
function rerenderMessage(id) {
  const el = $('#messages').querySelector(`.msg[data-id="${id}"]`);
  if (!el) return;
  const list = state.messages.get(state.current) || [];
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = messageHtml(list[i], { ...list[i - 1] || {}, createdAt: list[i - 1]?.createdAt || list[i].createdAt, system: list[i - 1] ? list[i - 1].system : true });
  const fresh = tmp.querySelector('.msg');
  if (fresh) { if (el.classList.contains('sel')) fresh.classList.add('sel'); el.replaceWith(fresh); hydrateImages($('#messages')); }
}
function rerenderKeepScroll() {
  const box = $('#messages'), atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60, top = box.scrollTop;
  renderMessages(false);
  box.scrollTop = atBottom ? box.scrollHeight : top;
}
function onMessageUpdated(m) {
  let found = false;
  for (const list of state.messages.values()) {
    const i = list.findIndex((x) => x.id === m.id);
    if (i >= 0) { list[i] = m; found = true; }
  }
  if (state.quoted.has(m.id)) state.quoted.set(m.id, m);
  if (state.view === 'chat' && m.chat === state.current && found) rerenderKeepScroll();
  if (m.chat === state.current) loadPins(m.chat);
}
function onReactionChange(p) {
  const r = p.new && p.new.message_id ? p.new : p.old;
  if (!r?.message_id) return;
  if (p.eventType === 'DELETE') state.reactions.get(r.message_id)?.get(r.emoji)?.delete(r.user_id);
  else addReaction(r.message_id, r.emoji, r.user_id);
  if (state.view === 'chat' && r.chat === state.current) rerenderMessage(r.message_id);
}
function onReadChange(p) {
  const r = p.new;
  if (!r?.chat) return;
  if (!state.reads.has(r.chat)) state.reads.set(r.chat, new Map());
  state.reads.get(r.chat).set(r.user_id, r.last_id);
  if (r.user_id === state.me.id) { // прочитано на другом устройстве
    if (state.unread.has(r.chat)) { state.unread.delete(r.chat); renderSidebar(); updateTitle(); }
    return;
  }
  if (state.view === 'chat' && r.chat === state.current) {
    const list = state.messages.get(r.chat) || [];
    list.filter((m) => m.userId === state.me.id).slice(-30).forEach((m) => rerenderMessage(m.id));
  }
}
let readTimer = null;
function markRead() {
  clearTimeout(readTimer);
  readTimer = setTimeout(() => {
    const chat = state.current, list = state.messages.get(chat) || [];
    const last = list[list.length - 1];
    if (!last || document.hidden || state.view !== 'chat') return;
    const mine = state.reads.get(chat)?.get(state.me.id) || 0;
    if (last.id <= mine) return;
    if (!state.reads.has(chat)) state.reads.set(chat, new Map());
    state.reads.get(chat).set(state.me.id, last.id);
    sb.rpc('sl_mark_read', { p_chat: chat, p_id: last.id }).then(() => {}, () => {});
  }, 400);
}
async function loadUnread() {
  try {
    const rows = check(await sb.rpc('sl_unread'));
    state.unread = new Map(rows.filter((r) => !(state.view === 'chat' && r.chat === state.current && !document.hidden)).map((r) => [r.chat, Number(r.n)]));
    renderSidebar(); updateTitle();
  } catch {}
}

async function messageAction(act, id, btn) {
  const m = findMsg(id);
  if (!m) return;
  if (act === 'del') return deleteMessage(id);
  if (act === 'reply') { state.replyTo = m; state.editing = null; renderComposerBar(); $('#input').focus(); return; }
  if (act === 'edit') {
    state.editing = m; state.replyTo = null; renderComposerBar();
    $('#input').value = m.text; autosize(); $('#input').focus();
    return;
  }
  if (act === 'pin') {
    try { onMessageUpdated(msgFromRow(check(await sb.rpc('sl_pin_message', { p_id: id, p_pin: !m.pinnedAt })))); toast(m.pinnedAt ? 'Откреплено' : '📌 Закреплено'); }
    catch (e) { toast(humanError(e)); }
    return;
  }
  if (act === 'react') return openReactPicker(id, btn);
  if (act === 'task') return openTaskFromMessage(m);
}
const REACTIONS = ['👍', '✅', '👀', '❤️', '😂', '🔥', '👏', '🙏', '❓', '😢'];
function openReactPicker(id, btn) {
  document.querySelector('.react-pick')?.remove();
  const box = document.createElement('div');
  box.className = 'react-pick';
  box.innerHTML = REACTIONS.map((e) => `<button>${e}</button>`).join('');
  document.body.appendChild(box);
  const r = btn.getBoundingClientRect();
  box.style.top = Math.max(8, r.top - box.offsetHeight - 6) + 'px';
  box.style.left = Math.max(8, Math.min(innerWidth - box.offsetWidth - 8, r.left - box.offsetWidth / 2)) + 'px';
  box.onclick = (e) => { const b = e.target.closest('button'); if (b) { toggleReaction(id, b.textContent); box.remove(); } };
  setTimeout(() => document.addEventListener('pointerdown', function off(ev) { if (!box.contains(ev.target)) { box.remove(); document.removeEventListener('pointerdown', off); } }), 0);
}
async function toggleReaction(id, emoji) {
  const m = findMsg(id);
  if (!m) return;
  const on = state.reactions.get(id)?.get(emoji)?.has(state.me.id);
  if (on) state.reactions.get(id).get(emoji).delete(state.me.id); else addReaction(id, emoji, state.me.id);
  rerenderMessage(id);
  const res = on
    ? await sb.from('sl_reactions').delete().match({ message_id: id, user_id: state.me.id, emoji })
    : await sb.from('sl_reactions').insert({ message_id: id, chat: m.chat, user_id: state.me.id, emoji });
  if (res.error && !/duplicate/i.test(res.error.message)) toast(humanError(res.error));
}
function showReaders(id) {
  const m = findMsg(id);
  const reads = state.reads.get(m?.chat) || new Map();
  const who = [...reads.entries()].filter(([uid, last]) => uid !== state.me.id && last >= id).map(([uid]) => state.users.get(uid)).filter(Boolean);
  const notYet = chatMembers(m.chat).filter((uid) => uid !== state.me.id && !who.some((u) => u.id === uid)).map((uid) => state.users.get(uid)).filter((u) => u && !u.disabled);
  openModal(`<h3>Кто прочитал</h3><div class="modal-body">
    ${who.map((u) => `<div class="person" style="cursor:default">${avatar(u, 'sm')}<span>${esc(u.name)}</span><span class="muted" style="margin-left:auto">✓✓</span></div>`).join('') || '<p class="muted">Пока никто</p>'}
    ${notYet.length ? `<p class="muted" style="margin-top:12px">Ещё не прочитали: ${notYet.map((u) => esc(u.name)).join(', ')}</p>` : ''}
    </div><div class="modal-foot"><span class="spacer"></span><button class="primary" data-close>Закрыть</button></div>`,
  (root) => { root.querySelector('[data-close]').onclick = closeModal; });
}
function renderComposerBar() {
  const bar = $('#replyBar');
  if (!bar) return;
  const m = state.editing || state.replyTo;
  if (!m) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  const snippet = m.text || (m.file ? (m.file.voice ? '🎤 Голосовое сообщение' : '📎 ' + m.file.name) : '');
  bar.innerHTML = `<span class="rb-ico">${state.editing ? '✏️' : '↩'}</span><div class="rb-text"><b>${state.editing ? 'Редактирование' : 'Ответ: ' + esc(userName(m.userId))}</b><span>${esc(snippet.slice(0, 100))}</span></div><button title="Отмена">✕</button>`;
  bar.classList.remove('hidden');
  bar.querySelector('button').onclick = () => { if (state.editing) { $('#input').value = ''; autosize(); } state.replyTo = state.editing = null; renderComposerBar(); };
}
// Переход к сообщению (из цитаты, поиска, закрепа)
async function jumpTo(id, chat) {
  if (chat && chat !== state.current) await openChat(chat);
  chat = state.current;
  let list = state.messages.get(chat) || [];
  for (let i = 0; i < 20 && !list.some((m) => m.id === id) && state.hasMore.get(chat) !== false && list.length; i++) {
    const older = await fetchMessages(chat, list[0].id);
    state.hasMore.set(chat, older.length === 50);
    list = older.concat(list);
    state.messages.set(chat, list);
  }
  renderMessages(false);
  const el = $('#messages').querySelector(`[data-id="${id}"]`);
  if (!el) return toast('Сообщение не найдено — возможно, удалено');
  el.scrollIntoView({ block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1800);
}
// Закреплённые
async function loadPins(chat) {
  try {
    const { data } = await sb.from('sl_messages').select('*').eq('chat', chat).not('pinned_at', 'is', null).order('pinned_at', { ascending: false }).limit(20);
    state.pins.set(chat, (data || []).map(msgFromRow));
  } catch {}
  if (chat === state.current) renderPinBar();
}
function renderPinBar() {
  const bar = $('#pinBar'), pins = state.pins.get(state.current) || [];
  if (!pins.length || state.view !== 'chat') { bar.classList.add('hidden'); return; }
  const p = pins[0];
  bar.innerHTML = `<span>📌</span><div class="rb-text"><b>Закреплено${pins.length > 1 ? ` (${pins.length})` : ''}</b><span>${esc((p.text || (p.file ? '📎 ' + p.file.name : '')).slice(0, 120))}</span></div>`;
  bar.classList.remove('hidden');
  bar.onclick = () => pins.length === 1 ? jumpTo(p.id) : openModal(`<h3>📌 Закреплённые</h3><div class="modal-body">
    ${pins.map((x) => `<div class="person" data-jump="${x.id}">${avatar(state.users.get(x.userId) || { id: x.userId, name: '?' }, 'sm')}
      <span style="flex:1;min-width:0"><b>${esc(userName(x.userId))}</b> <span class="muted">${fmtDay(x.createdAt)}</span><div class="snip">${esc((x.text || (x.file ? '📎 ' + x.file.name : '')).slice(0, 160))}</div></span></div>`).join('')}
    </div><div class="modal-foot"><span class="spacer"></span><button class="primary" data-close>Закрыть</button></div>`,
  (root) => {
    root.querySelector('[data-close]').onclick = closeModal;
    root.querySelectorAll('[data-jump]').forEach((el) => el.onclick = () => { closeModal(); jumpTo(Number(el.dataset.jump)); });
  });
}
// Поиск по сообщениям и файлам
function openSearch() {
  openModal(`<h3>🔍 Поиск</h3><div class="modal-body">
    <label class="field"><input id="sQ" placeholder="Слово, сумма, название файла…" autocomplete="off"></label>
    <div id="sRes" class="search-res"><p class="muted">Ищем во всех чатах, где вы участвуете</p></div></div>
    <div class="modal-foot"><span class="spacer"></span><button class="secondary" data-close>Закрыть</button></div>`,
  (root) => {
    root.querySelector('[data-close]').onclick = closeModal;
    let t = null;
    const q = root.querySelector('#sQ');
    q.oninput = () => { clearTimeout(t); t = setTimeout(() => runSearch(q.value, root.querySelector('#sRes')), 300); };
  }, 'wide');
}
async function runSearch(raw, box) {
  const q = raw.trim().replace(/[,()*%\\]/g, ' ').trim();
  if (q.length < 2) { box.innerHTML = '<p class="muted">Введите хотя бы 2 символа</p>'; return; }
  box.innerHTML = '<p class="muted">Ищу…</p>';
  try {
    const rows = check(await sb.from('sl_messages').select('*').eq('system', false)
      .or(`text.ilike.*${q}*,file->>name.ilike.*${q}*`).order('id', { ascending: false }).limit(60));
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const hl = (s) => esc(s).replace(new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (x) => `<mark>${x}</mark>`);
    const items = rows.map(msgFromRow).filter((m) => chatTitle(m.chat));
    box.innerHTML = items.length ? items.map((m) => {
      let txt = m.text || (m.file ? '📎 ' + m.file.name : '');
      const i = txt.search(re);
      if (i > 60) txt = '…' + txt.slice(i - 40);
      return `<div class="person" data-id="${m.id}" data-chat="${esc(m.chat)}">${avatar(state.users.get(m.userId) || { id: m.userId, name: '?' }, 'sm')}
        <span style="flex:1;min-width:0"><b>${esc(userName(m.userId))}</b> <span class="muted">· ${esc(chatTitle(m.chat))} · ${fmtDay(m.createdAt)} ${fmtTime(m.createdAt)}</span>
        <div class="snip">${hl(txt.slice(0, 200))}</div></span></div>`;
    }).join('') : '<p class="muted">Ничего не найдено</p>';
    box.querySelectorAll('[data-id]').forEach((el) => el.onclick = () => { closeModal(); jumpTo(Number(el.dataset.id), el.dataset.chat); });
  } catch (e) { box.innerHTML = `<p class="modal-err">${esc(humanError(e))}</p>`; }
}
// Упоминания: подсказка при вводе @
let mentionSel = 0;
function mentionQuery() {
  const ta = $('#input'), pos = ta.selectionStart, before = ta.value.slice(0, pos);
  const m = before.match(/(?:^|\s)@([\p{L}\d._-]{0,30}(?: [\p{L}]{0,30})?)$/u);
  return m ? { q: m[1].toLowerCase(), start: pos - m[1].length - 1, end: pos } : null;
}
function mentionCandidates(q) {
  const members = chatMembers(state.current);
  return activeUsers().filter((u) => u.id !== state.me.id && members.includes(u.id) &&
    (u.name.toLowerCase().includes(q) || (u.login || '').includes(q))).slice(0, 6);
}
function updateMentionPopup() {
  const pop = $('#mentionPop'), mq = mentionQuery();
  const list = mq ? mentionCandidates(mq.q) : [];
  if (!list.length) { pop.classList.add('hidden'); return; }
  mentionSel = Math.min(mentionSel, list.length - 1);
  pop.innerHTML = list.map((u, i) => `<div class="person ${i === mentionSel ? 'sel' : ''}" data-uid="${u.id}">${avatar(u, 'xs')}<span>${esc(u.name)}</span><span class="muted">${esc(u.position || '')}</span></div>`).join('');
  pop.classList.remove('hidden');
  pop.querySelectorAll('[data-uid]').forEach((el) => el.onmousedown = (e) => { e.preventDefault(); insertMention(el.dataset.uid); });
}
function insertMention(uid) {
  const mq = mentionQuery(), u = state.users.get(uid), ta = $('#input');
  if (!mq || !u) return;
  ta.value = ta.value.slice(0, mq.start) + '@' + u.name + ' ' + ta.value.slice(mq.end);
  const p = mq.start + u.name.length + 2;
  ta.setSelectionRange(p, p); ta.focus();
  $('#mentionPop').classList.add('hidden'); mentionSel = 0;
}
function mentionKey(e) {
  const pop = $('#mentionPop');
  if (pop.classList.contains('hidden')) return false;
  const items = [...pop.querySelectorAll('[data-uid]')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); mentionSel = (mentionSel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; updateMentionPopup(); return true; }
  if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertMention(items[mentionSel]?.dataset.uid); return true; }
  if (e.key === 'Escape') { pop.classList.add('hidden'); return true; }
  return false;
}
// Голосовые сообщения
const rec = { mr: null, chunks: [], started: 0, timer: null, stream: null, cancel: false };
async function startVoice() {
  if (rec.mr) return;
  if (!window.MediaRecorder) return toast('Этот браузер не умеет записывать голос');
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (e) { return showMicHelp(e); }
  const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
  rec.mr = new MediaRecorder(rec.stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
  rec.chunks = []; rec.cancel = false; rec.started = Date.now();
  rec.mr.ondataavailable = (e) => e.data.size && rec.chunks.push(e.data);
  rec.mr.onstop = () => {
    rec.stream.getTracks().forEach((t) => t.stop());
    const dur = (Date.now() - rec.started) / 1000, type = rec.mr.mimeType || 'audio/webm';
    const chunks = rec.chunks; rec.mr = null; clearInterval(rec.timer);
    $('#voiceBar').classList.add('hidden'); $('.input-row').classList.remove('hidden');
    if (rec.cancel || dur < 0.7) return;
    const ext = /mp4/.test(type) ? 'm4a' : 'webm';
    const file = new File(chunks, `Голосовое ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}.${ext}`, { type: type.split(';')[0] });
    uploadFile(file, { voice: true, duration: Math.round(dur) });
  };
  rec.mr.start(1000);
  $('.input-row').classList.add('hidden'); $('#voiceBar').classList.remove('hidden');
  const tick = () => { $('#voiceTime').textContent = fmtDur((Date.now() - rec.started) / 1000); if (Date.now() - rec.started > 5 * 60e3) stopVoice(false); };
  tick(); rec.timer = setInterval(tick, 500);
}
function stopVoice(cancel) { if (!rec.mr) return; rec.cancel = cancel; rec.mr.stop(); }
$('#voiceBtn').onclick = startVoice;
// Фирменные стикеры Shtark
const STICKERS = [{"id": "ok", "title": "Принято"}, {"id": "done", "title": "Сделано!"}, {"id": "thanks", "title": "Спасибо!"}, {"id": "hi", "title": "Привет!"}, {"id": "morning", "title": "Доброе утро"}, {"id": "day", "title": "Хорошего дня"}, {"id": "call", "title": "Созвонимся?"}, {"id": "work", "title": "В работе"}, {"id": "urgent", "title": "Срочно!"}, {"id": "great", "title": "Отлично!"}, {"id": "lunch", "title": "На обеде"}, {"id": "coffee", "title": "Кофе?"}, {"id": "think", "title": "Подумаю"}, {"id": "wait", "title": "Минутку…"}, {"id": "agree", "title": "Договорились"}, {"id": "team", "title": "Команда Shtark"}];
const STICKERS_LIVE = [{"id": "a-wave", "title": "Привет!"}, {"id": "a-ok", "title": "Принято"}, {"id": "a-done", "title": "Готово!"}, {"id": "a-rocket", "title": "Погнали!"}, {"id": "a-fire", "title": "Горит!"}, {"id": "a-heart", "title": "Спасибо!"}, {"id": "a-coffee", "title": "Кофе-брейк"}, {"id": "a-call", "title": "Звоню!"}, {"id": "a-time", "title": "Минутку…"}, {"id": "a-party", "title": "Ура!"}, {"id": "a-think", "title": "Думаю…"}, {"id": "a-clap", "title": "Браво!"}, {"id": "a-lol", "title": "Ха-ха!"}, {"id": "a-strong", "title": "Справимся!"}, {"id": "a-sleep", "title": "До завтра"}, {"id": "a-team", "title": "Shtark Team"}, {"id": "a-money", "title": "Оплачено"}, {"id": "a-mail", "title": "Отправил"}, {"id": "a-meeting", "title": "На встрече"}, {"id": "a-idea", "title": "Есть идея!"}, {"id": "a-wow", "title": "Вау!"}, {"id": "a-okay", "title": "Окей"}, {"id": "a-notnow", "title": "Не сейчас"}, {"id": "a-deal", "title": "Сделка!"}, {"id": "a-chart", "title": "Растём!"}, {"id": "a-cool", "title": "Круто!"}, {"id": "a-love", "title": "Обожаю"}, {"id": "a-vacation", "title": "В отпуске"}, {"id": "a-sos", "title": "Помогите!"}, {"id": "a-sorry", "title": "Извини"}];
function toggleStickers() {
  const pop = $('#stickerPop');
  if (!pop.classList.contains('hidden')) return pop.classList.add('hidden');
  const grid = (list) => list.map((st) => `<button data-st="${st.id}" title="${esc(st.title)}"><img src="stickers/${st.id}.svg" alt="${esc(st.title)}" loading="lazy"></button>`).join('');
  let tab = 'live';
  try { tab = localStorage.getItem('sl-sticker-tab') || 'live'; } catch {}
  const draw = () => {
    pop.innerHTML = `<div class="sp-head"><div class="sp-tabs"><button data-tab="live" class="${tab === 'live' ? 'on' : ''}">✨ Анимированные</button><button data-tab="static" class="${tab === 'static' ? 'on' : ''}">Обычные</button></div><span>Стикеры <b>Shtark</b></span></div>
      <div class="sp-grid">${grid(tab === 'live' ? STICKERS_LIVE : STICKERS)}</div>`;
    pop.querySelectorAll('[data-tab]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); tab = b.dataset.tab; try { localStorage.setItem('sl-sticker-tab', tab); } catch {} draw(); });
    pop.querySelectorAll('[data-st]').forEach((b) => b.onclick = () => { pop.classList.add('hidden'); sendSticker(b.dataset.st); });
  };
  draw();
  pop.classList.remove('hidden');
  setTimeout(() => document.addEventListener('pointerdown', function off(e) {
    if (!pop.contains(e.target) && e.target.id !== 'stickerBtn') { pop.classList.add('hidden'); document.removeEventListener('pointerdown', off); }
  }), 0);
}
async function sendSticker(id) {
  const st = STICKERS.concat(STICKERS_LIVE).find((x) => x.id === id), chat = state.current;
  if (!st || !chat) return;
  const replyTo = state.replyTo?.id || null;
  state.replyTo = null; renderComposerBar();
  try {
    const row = check(await sb.from('sl_messages').insert({ chat, user_id: state.me.id, text: `Стикер «${st.title}»`, sticker: id, reply_to: replyTo }).select().single());
    onMessage(msgFromRow(row));
  } catch (e) { toast('Стикер не отправлен: ' + humanError(e)); }
}
$('#stickerBtn').onclick = toggleStickers;
$('#voiceSend').onclick = () => stopVoice(false);
$('#voiceCancel').onclick = () => stopVoice(true);
$('#searchBtn').onclick = openSearch;

// ---------- Календарь ----------
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const eventFromRow = (e) => ({ id: e.id, userId: e.user_id, title: e.title, note: e.note, date: e.date, time: e.time, shared: e.shared, done: e.done, callChat: e.call_chat || null });

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
          ${e.callChat && chatTitle(e.callChat) ? `<button class="hbtn" data-join="${esc(e.callChat)}">📞 Присоединиться</button>` : ''}
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
  $('#dayList').querySelectorAll('[data-join]').forEach((b) => b.onclick = () => { openChat(b.dataset.join); joinCall(b.dataset.join); });
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
      <label class="field"><span>📞 Созвон (участники получат напоминание за 5 минут)</span><select id="eCall"><option value="">— без созвона —</option>
        ${state.channels.map((c) => `<option value="c:${c.id}" ${ev.callChat === 'c:' + c.id ? 'selected' : ''}># ${esc(c.name)} (все)</option>`).join('')}
        ${[...state.groups.values()].map((g) => `<option value="g:${g.id}" ${ev.callChat === 'g:' + g.id ? 'selected' : ''}>👥 ${esc(g.name)}</option>`).join('')}
        ${activeUsers().filter((u) => u.id !== state.me.id).map((u) => `<option value="${dmKey(state.me.id, u.id)}" ${ev.callChat === dmKey(state.me.id, u.id) ? 'selected' : ''}>👤 ${esc(u.name)}</option>`).join('')}
      </select></label>
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
          call_chat: root.querySelector('#eCall').value || null,
          reminded: false,
        };
        if (body.call_chat && !body.time) return root.querySelector('#mErr').textContent = 'Для созвона укажите время';
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
  repeat: t.repeat || '', files: t.files || [], sourceChat: t.source_chat || null, sourceMsg: t.source_msg || null,
});
const REPEAT_LABEL = { '': 'Не повторять', daily: 'Каждый день', weekly: 'Каждую неделю', monthly: 'Каждый месяц' };
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
      ${t.repeat ? `<div class="td-row"><span>Повтор</span><span>🔁 ${REPEAT_LABEL[t.repeat]}</span></div>` : ''}
      ${t.sourceMsg ? `<div class="td-row"><span>Из чата</span><a href="#" id="tSrc">💬 ${esc(chatTitle(t.sourceChat) || 'сообщение')} →</a></div>` : ''}
      <div class="td-row"><span>Файлы</span><span class="t-files">${t.files.map((f, i) => `<a href="#" class="t-file" data-i="${i}">📎 ${esc(f.name)}</a>`).join('')}
        ${canChangeStatus(t) || canEditTask(t) ? '<button class="hbtn" id="tAddFile">+ Файл</button><input type="file" id="tFile" multiple hidden>' : (t.files.length ? '' : '—')}</span></div>
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
      const src = root.querySelector('#tSrc');
      if (src) src.onclick = (e) => { e.preventDefault(); closeModal(); jumpTo(t.sourceMsg, t.sourceChat); };
      root.querySelectorAll('.t-file').forEach((a) => a.onclick = (e) => { e.preventDefault(); const f = t.files[Number(a.dataset.i)]; downloadFile(f.path, f.name); });
      const addF = root.querySelector('#tAddFile');
      if (addF) {
        const inp = root.querySelector('#tFile');
        addF.onclick = () => inp.click();
        inp.onchange = async () => {
          const files = [...inp.files];
          addF.disabled = true; addF.textContent = 'Загрузка…';
          try {
            let list = [...(state.tasks.get(t.id)?.files || [])];
            for (const f of files) {
              if (f.size > MAX_FILE) { toast(`${f.name}: больше 50 МБ`); continue; }
              const ext = (f.name.match(/\.([a-z0-9]{1,8})$/i)?.[1] || 'bin').toLowerCase();
              const path = `task_${t.id}/${crypto.randomUUID()}.${ext}`;
              const up = await sb.storage.from('sl-files').upload(path, f, { contentType: f.type || 'application/octet-stream' });
              if (up.error) throw up.error;
              list = list.concat({ path, name: f.name, size: f.size, mime: f.type || '' });
              const row = await myTaskEdit(t.id, () => rpc('sl_update_task', { p_id: t.id, p: { files: list } }));
              state.tasks.set(t.id, taskFromRow(row, state.tasks.get(t.id)?.commentCount || 0));
            }
            openTaskView(t.id); refreshComments(t.id);
          } catch (e) { root.querySelector('#mErr').textContent = humanError(e); addF.disabled = false; addF.textContent = '+ Файл'; }
        };
      }
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
        ${users.map((u) => `<option value="${u.id}" ${u.id === t.assigneeId ? 'selected' : ''}>${esc(u.name)}${u.position ? ' — ' + esc(u.position) : ''}${u.id === state.me.id ? ' (я)' : ''}</option>`).join('')}
      </select></label>
      <div class="row">
        <label class="field"><span>Срок</span><input id="tDate" type="date" value="${t.dueDate || ymd(tomorrow)}"></label>
        <label class="field"><span>Время (необязательно)</span><input id="tTime" type="time" value="${t.dueTime || ''}"></label>
      </div>
      <label class="field"><span>Описание</span><textarea id="tDesc" maxlength="8000" placeholder="Детали, ссылки, ожидаемый результат…">${esc(t.description || '')}</textarea></label>
      <label class="field"><span>Повтор</span><select id="tRepeat">${Object.entries(REPEAT_LABEL).map(([k, v]) => `<option value="${k}" ${k === (t.repeat || '') ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" id="tPrio" ${t.priority ? 'checked' : ''}> Высокий приоритет</label>
      ${t.sourceMsg && isNew ? '<p class="muted">🔗 Задача будет связана с сообщением в чате</p>' : ''}
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
        const repeat = root.querySelector('#tRepeat').value;
        if (!title) return err('Укажите, что нужно сделать');
        if (!assigneeId) return err('Выберите исполнителя');
        if (!dueDate) return err('Укажите срок');
        try {
          let saved;
          if (isNew) {
            const row = check(await sb.from('sl_tasks').insert({
              title, description, assignee_id: assigneeId, due_date: dueDate, due_time: dueTime,
              priority: priority ? 1 : 0, created_by: state.me.id, repeat,
              source_chat: t.sourceChat || null, source_msg: t.sourceMsg || null,
            }).select().single());
            markMyEdit(row);
            saved = taskFromRow(row);
          } else {
            saved = taskFromRow(await myTaskEdit(t.id, () => rpc('sl_update_task', { p_id: t.id, p: { title, description, assigneeId, dueDate, dueTime, priority, repeat } })), t.commentCount);
          }
          state.tasks.set(saved.id, saved);
          closeModal();
          if (isNew) toast(`📋 Задача поручена: ${userName(saved.assigneeId)} — ${dueLabel(saved).text}`, () => openTaskView(saved.id));
          if (isNew && t.sourceMsg && t.sourceChat) sb.rpc('sl_task_source_note', { p_task: saved.id }).then(() => {}, () => {});
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
$('#taskReport').onclick = openTaskReport;
// Задача из сообщения: текст — в описание, ссылка на сообщение сохраняется
function openTaskFromMessage(m) {
  const text = m.text || (m.file ? '📎 ' + m.file.name : '');
  const firstLine = text.split('\n')[0].slice(0, 120);
  const other = m.chat.startsWith('d:') ? chatMembers(m.chat).find((id) => id !== state.me.id) : (m.userId !== state.me.id ? m.userId : '');
  openTaskForm({ title: firstLine, description: `${userName(m.userId)}, ${fmtDay(m.createdAt)} ${fmtTime(m.createdAt)}:\n${text}`,
    assigneeId: other || '', sourceChat: m.chat, sourceMsg: m.id });
}
// Отчёт по задачам (для руководителя)
function openTaskReport() {
  const all = [...state.tasks.values()];
  const now = new Date(), monthAgo = Date.now() - 30 * 864e5;
  const rows = activeUsers().map((u) => {
    const mine = all.filter((t) => t.assigneeId === u.id);
    return { u, open: mine.filter((t) => t.status !== 'done').length, overdue: mine.filter((t) => isOverdue(t)).length,
      done30: mine.filter((t) => t.status === 'done' && t.completedAt > monthAgo).length,
      late30: mine.filter((t) => t.status === 'done' && t.completedAt > monthAgo && t.completedAt > Date.parse(t.dueDate + 'T' + (t.dueTime || '23:59'))).length };
  }).filter((r) => r.open || r.done30).sort((a, b) => b.overdue - a.overdue || b.open - a.open);
  const overdue = all.filter((t) => isOverdue(t)).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  openModal(`<h3>📊 Отчёт по задачам</h3><div class="modal-body">
    <table class="rep"><thead><tr><th>Сотрудник</th><th title="В работе и новые">Открыто</th><th>Просрочено</th><th title="За 30 дней">Выполнено</th><th title="Выполнено позже срока, за 30 дней">С опозданием</th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td>${avatar(r.u, 'xs')} ${esc(r.u.name)}</td><td>${r.open}</td><td class="${r.overdue ? 'bad' : ''}">${r.overdue}</td><td>${r.done30}</td><td>${r.late30}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Задач пока нет</td></tr>'}</tbody></table>
    ${overdue.length ? `<div class="disc-title">Просроченные задачи</div>${overdue.map((t) => `<div class="person" data-tid="${t.id}"><span class="due overdue">${dueLabel(t).text}</span><span style="flex:1">${esc(t.title)}</span><span class="muted">${esc(userName(t.assigneeId))}</span></div>`).join('')}` : ''}
    <p class="muted">Данные на ${now.toLocaleString('ru-RU')}</p></div>
    <div class="modal-foot"><button class="secondary" id="repCsv">⬇ Скачать (Excel)</button><span class="spacer"></span><button class="primary" data-close>Закрыть</button></div>`,
  (root) => {
    root.querySelector('[data-close]').onclick = closeModal;
    root.querySelectorAll('[data-tid]').forEach((el) => el.onclick = () => openTaskView(Number(el.dataset.tid)));
    root.querySelector('#repCsv').onclick = () => {
      const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
      const lines = [['Задача', 'Исполнитель', 'Поручил', 'Срок', 'Статус', 'Выполнена', 'Просрочена'].map(q).join(';')]
        .concat(all.map((t) => [t.title, userName(t.assigneeId), userName(t.createdBy), t.dueDate + (t.dueTime ? ' ' + t.dueTime : ''),
          STATUS_LABEL[t.status], t.completedAt ? new Date(t.completedAt).toLocaleString('ru-RU') : '', isOverdue(t) ? 'да' : ''].map(q).join(';')));
      saveFile('﻿' + lines.join('\r\n'), `Задачи ${ymd(now)}.csv`, 'text/csv');
    };
  }, 'wide');
}
function saveFile(content, name, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
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
        <div class="u-meta">${u.position ? `<b>${esc(u.position)}</b> · ` : '<span style="color:#d97706">должность не указана</span> · '}логин: <b>${esc(u.login)}</b> · ${u.disabled ? 'доступ закрыт' : seen(u)}</div>
      </div>
      <div class="u-actions">
        ${u.disabled
          ? '<button data-act="enable">Вернуть доступ</button>'
          : `<button data-act="profile">Изменить</button>
             <button data-act="password">Новый пароль</button>
             ${u.id !== state.me.id ? `<button data-act="admin">${u.is_admin ? 'Снять админа' : 'Сделать админом'}</button>
             <button data-act="disable" class="warn">Отключить</button>` : ''}`}
      </div>
    </div>`).join('');
  $('#adminUsers').querySelectorAll('[data-act]').forEach((b) => b.onclick = () => adminAction(b.closest('.u-row').dataset.id, b.dataset.act));
  renderAnnAdmin();
  renderChannelsAdmin();
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
    <label class="field"><span>Должность</span><input id="aPos" maxlength="60" placeholder="например, Менеджер по продажам"></label>
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
        await fn('sl-admin', { action: 'create', login, name: root.querySelector('#aName').value, position: root.querySelector('#aPos').value, password, isAdmin: root.querySelector('#aAdmin').checked });
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
    } else if (act === 'profile') {
      return openModal(`<h3>Сотрудник</h3>
        <div class="modal-body">
          ${avatarEditorHtml(state.users.get(id) || { id, name: u.name })}
          <label class="field"><span>Имя и фамилия</span><input id="pName" maxlength="64" value="${esc(u.name)}"></label>
          <label class="field"><span>Должность</span><input id="pPos" maxlength="60" value="${esc(u.position || '')}" placeholder="например, Бухгалтер"></label>
          ${profileFieldsHtml(state.users.get(id) || {})}
          <div class="modal-err" id="mErr"></div>
        </div>
        <div class="modal-foot"><span class="spacer"></span><button class="secondary" data-close>Отмена</button><button class="primary" id="pOk">Сохранить</button></div>`,
        (root) => {
          root.querySelector('[data-close]').onclick = closeModal;
          mountAvatarEditor(root, id);
          root.querySelector('#pOk').onclick = async () => {
            try {
              await fn('sl-admin', { action: 'profile', id, name: root.querySelector('#pName').value, position: root.querySelector('#pPos').value });
              const row = check(await sb.rpc('sl_set_profile', { p_user: id, p: readProfileFields(root) }));
              onProfileChange({ eventType: 'UPDATE', new: row });
              closeModal(); renderAdmin(); toast('Сохранено');
            } catch (e) { root.querySelector('#mErr').textContent = humanError(e); }
          };
        });
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
  let saved = null; try { saved = localStorage.getItem('sl-mic'); } catch {}
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(saved ? { deviceId: { ideal: saved } } : {}) } });
}
async function publishMic(room, stream) {
  const LK = window.LivekitClient;
  await room.localParticipant.publishTrack(stream.getAudioTracks()[0], { source: LK.Track.Source.Microphone });
}

// Выбор микрофона (на компьютере их бывает несколько: встроенный, гарнитура, веб-камера)
async function openMicPicker() {
  const room = call.room;
  if (!room) return;
  const LK = window.LivekitClient;
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId);
  const cur = room.localParticipant.getTrackPublication(LK.Track.Source.Microphone)?.track?.mediaStreamTrack?.getSettings?.().deviceId;
  openModal(`<h3>Микрофон</h3>
    <div class="modal-body">
      <p class="muted">Говорите — у работающего микрофона полоска двигается.</p>
      ${devs.map((d, i) => `<label class="person"><input type="radio" name="mic" value="${esc(d.deviceId)}" ${d.deviceId === cur ? 'checked' : ''}>
        <span style="flex:1">${esc(d.label || 'Микрофон ' + (i + 1))}</span><meter min="0" max="1" value="0" data-dev="${esc(d.deviceId)}" style="width:70px"></meter></label>`).join('') || '<p>Микрофоны не найдены</p>'}
      <div class="modal-err" id="mErr"></div>
    </div>
    <div class="modal-foot"><span class="spacer"></span><button class="primary" data-close>Готово</button></div>`,
  (root) => {
    // индикатор громкости для каждого микрофона
    const streams = [];
    let raf = 0;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    devs.forEach(async (d) => {
      try {
        const st = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: d.deviceId } } });
        streams.push(st);
        const an = ctx.createAnalyser(); an.fftSize = 512;
        ctx.createMediaStreamSource(st).connect(an);
        const buf = new Uint8Array(an.fftSize), m = root.querySelector(`meter[data-dev="${CSS.escape(d.deviceId)}"]`);
        const tick = () => { an.getByteTimeDomainData(buf); let v = 0; for (const x of buf) v = Math.max(v, Math.abs(x - 128)); if (m) m.value = Math.min(1, v / 50); raf = requestAnimationFrame(tick); };
        tick();
      } catch {}
    });
    const stop = () => { cancelAnimationFrame(raf); streams.forEach((st) => st.getTracks().forEach((t) => t.stop())); ctx.close().catch(() => {}); };
    root.querySelector('[data-close]').onclick = () => { stop(); closeModal(); };
    root.querySelectorAll('input[name=mic]').forEach((r) => r.onchange = async () => {
      try {
        const st = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: r.value }, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        const pub = call.room?.localParticipant.getTrackPublication(LK.Track.Source.Microphone);
        if (pub?.track) await pub.track.replaceTrack(st.getAudioTracks()[0]);
        try { localStorage.setItem('sl-mic', r.value); } catch {}
        call.micSilentWarned = false; call.micSilent = 0;
        toast('Микрофон переключён');
      } catch (e) { root.querySelector('#mErr').textContent = humanError(e); }
    });
  });
}
$('#callMicPick').onclick = openMicPicker;

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
  // Микрофон есть, но система не даёт с него звук (отключён, не тот вход, занят другой программой)
  const mst = micPub?.track?.mediaStreamTrack;
  if (mst && call.mic && (mst.muted || mst.readyState === 'ended')) {
    call.micSilent = (call.micSilent || 0) + 1;
    if (call.micSilent === 2 && !call.micSilentWarned) {
      call.micSilentWarned = true;
      callLog('mic-silent', mst.label);
      toast(isIOS ? '⚠ Микрофон не передаёт звук. Закройте другие приложения, которые используют микрофон.'
        : `⚠ Микрофон «${mst.label || 'по умолчанию'}» не передаёт звук — вас не слышно. Нажмите, чтобы выбрать другой.`, isIOS ? null : openMicPicker);
    }
  } else call.micSilent = 0;
  let bytesSent = 0, srvLost = null, srvRtt = null;
  micStats?.forEach((s) => {
    if (s.type === 'outbound-rtp') bytesSent += s.bytesSent || 0;
    if (s.type === 'remote-inbound-rtp') { srvLost = s.fractionLost ?? null; srvRtt = s.roundTripTime ?? null; } // так сервер видит наш звук
  });
  const remotes = [];
  for (const p of room.remoteParticipants.values()) {
    const pub = p.getTrackPublication(LK.Track.Source.Microphone);
    const st = await statsOf(pub?.track);
    let bytesRecv = 0, packetsLost = 0;
    st?.forEach((s) => { if (s.type === 'inbound-rtp') { bytesRecv += s.bytesReceived || 0; packetsLost += s.packetsLost || 0; } });
    // собеседник «подключён», а его голос до нас не доходит
    if (pub?.isSubscribed && !pub.isMuted && bytesRecv === 0) {
      call.zero = call.zero || {};
      const z = (call.zero[p.identity] = (call.zero[p.identity] || 0) + 1);
      if (z === 3) { // ~12 с тишины по сети — просим его переподключиться через ретранслятор
        callLog('nohear-send', userName(p.identity));
        state.rt?.send({ type: 'broadcast', event: 'call', payload: { type: 'nohear', chat, to: p.identity, from: state.me.id } });
      }
      if (z === 7 && !call.relay) { callLog('nohear-self'); setTimeout(() => call.chat === chat && rejoinViaRelay(chat), 0); }
    } else if (call.zero) call.zero[p.identity] = 0;
    remotes.push({ who: userName(p.identity), audioPub: !!pub, subscribed: !!pub?.isSubscribed, muted: !!pub?.isMuted,
      level: Math.round((p.audioLevel || 0) * 100) / 100, bytesRecv, packetsLost, pair: pairInfo(st) });
  }
  const audioEls = [...document.querySelectorAll('#callAudio audio')].map((a) => ({ paused: a.paused, muted: a.muted, vol: a.volume }));
  const b = call.blessed;
  if (b && !b.closest('#callAudio')) audioEls.push({ blessed: true, paused: b.paused, muted: b.muted, vol: b.volume, src: !!b.srcObject });
  const data = {
    v: APP_VERSION, relay: !!call.relay, pc: pcStates(room), log: call.log || [],
    ua: navigator.userAgent.slice(0, 160), standalone: isStandalone, state: room.state, canPlayAudio: room.canPlaybackAudio,
    mic: { want: call.mic, published: !!micPub, muted: !!micPub?.isMuted, level: Math.round((lp.audioLevel || 0) * 100) / 100,
      bytesSent, srvLost, srvRtt, error: call.micError || null, pair: pairInfo(micStats),
      track: micPub?.track?.mediaStreamTrack ? { state: micPub.track.mediaStreamTrack.readyState, enabled: micPub.track.mediaStreamTrack.enabled, muted: micPub.track.mediaStreamTrack.muted, label: micPub.track.mediaStreamTrack.label.slice(0, 60) } : null },
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

// Состояние двух медиаканалов LiveKit (отправка и приём)
function pcStates(room) {
  const pm = room?.engine?.pcManager;
  const st = (t) => { try { return t?.getConnectionState?.() || t?.pc?.connectionState || null; } catch { return null; } };
  let pub = st(pm?.publisher), sub = st(pm?.subscriber);
  if (!pub && !sub && pm) { // режим одного соединения (livekit-client 2.2x): ищем его среди полей
    for (const k of Object.keys(pm)) {
      const v = pm[k];
      if (v && v.pc instanceof RTCPeerConnection) { pub = sub = v.pc.connectionState; break; }
    }
  }
  return { pub, sub };
}
function mediaConnected(room) {
  const { pub, sub } = pcStates(room);
  if (!pub && !sub) return true; // не можем определить — не мешаем
  return pub === 'connected' || sub === 'connected';
}
function callLog(e, d) {
  if (!call.log) call.log = [];
  call.log.push({ t: Math.round((Date.now() - (call.started || Date.now())) / 100) / 10, e, ...(d !== undefined ? { d: String(d).slice(0, 80) } : {}) });
  if (call.log.length > 25) call.log.shift();
}
const relayPreferred = () => { try { return localStorage.getItem('sl-relay') === '1'; } catch { return false; } };

// Голос не пошёл за 10 с — переподключаемся через ретранслятор LiveKit (TURN/TLS на 443: проходит там, где прямое соединение режут)
async function rejoinViaRelay(chat) {
  const room = call.room, ctx = call.audioCtx;
  callLog('relay-switch');
  try { localStorage.setItem('sl-relay', '1'); } catch {}
  toast('Слабое соединение — переключаюсь на защищённый канал…');
  call.room = null; // чтобы Disconnected не закрыл окно звонка
  await room.disconnect().catch(() => {});
  cleanupCall({ keepUi: true, keepCtx: true });
  await joinCall(chat, { relay: true, rejoin: true, audioCtx: ctx, blessed: blessAudioElement() });
}

// Safari (все браузеры iPhone) — звук собеседника через <audio>, а не через Web Audio
function webkitAudioPath() {
  try { if (localStorage.getItem('sl-audio-path') === 'element') return true; } catch {}
  return isIOS || /^((?!chrome|chromium|crios|android|edg|fxios).)*safari/i.test(navigator.userAgent);
}
// «Освящаем» аудиоэлемент тихим звуком в момент нажатия — потом iOS разрешит ему играть голос
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
function blessAudioElement() {
  const a = document.createElement('audio');
  a.autoplay = true; a.playsInline = true; a.setAttribute('playsinline', '');
  a.src = SILENT_WAV;
  $('#callAudio').appendChild(a);
  a.play?.().catch(() => {});
  return a;
}

async function joinCall(chat, opts = {}) {
  if (call.chat === chat || call.joining) return; // защита от двойного входа
  // Микрофон запрашиваем сразу, в момент нажатия: iPhone не разрешает запрос «потом»
  const micPromise = requestMic();
  micPromise.catch(() => {});
  // iPhone разрешает звук, только если его «включили» прямо в момент нажатия — делаем это сразу
  const audioCtx = opts.audioCtx || unlockAudio(); // для гудков и (не на iPhone) для звука собеседников
  // На iPhone/Safari звук собеседника играет обычный <audio>, «разрешённый» прямо в момент нажатия
  const blessed = webkitAudioPath() ? (opts.blessed || blessAudioElement()) : null;
  const relay = opts.relay || relayPreferred();
  if (call.chat) {
    if (!confirm('Вы уже в звонке. Завершить его и перейти в новый?')) {
      micPromise.then((s) => s.getTracks().forEach((t) => t.stop()), () => {});
      return;
    }
    await leaveCall();
  }
  hideIncoming();
  // убрать уведомление «звонит» с экрана блокировки
  state.push.reg?.getNotifications?.().then((ns) => ns.filter((n) => n.data?.group === 'call-' + chat).forEach((n) => n.close())).catch(() => {});
  call.joining = true;
  try {
    const [tok] = await Promise.all([fn('sl-call-token', { chat }), loadLiveKit()]);
    const LK = window.LivekitClient;
    const room = new LK.Room({
      adaptiveStream: true, dynacast: true,
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true },
      // Web Audio — только не в Safari: на iPhone звонок через него молчит
      webAudioMix: audioCtx && !blessed ? { audioContext: audioCtx } : false,
    });
    call.chat = chat; call.room = room; call.started = Date.now(); call.mic = true; call.micError = null; call.cam = false; call.screen = false;
    call.audioCtx = audioCtx; call.loud = false; call.relay = relay; call.blessed = blessed; call.blessedUsed = false;
    if (!opts.rejoin) call.log = [];
    callLog(relay ? 'join-relay' : 'join');
    room
      .on(LK.RoomEvent.ConnectionStateChanged, (st) => callLog('state', st))
      .on(LK.RoomEvent.SignalReconnecting, () => callLog('signal-reconnecting'))
      .on(LK.RoomEvent.Reconnecting, () => callLog('reconnecting'))
      .on(LK.RoomEvent.Reconnected, () => callLog('reconnected'))
      .on(LK.RoomEvent.MediaDevicesError, (e) => callLog('media-error', e?.name || e))
      .on(LK.RoomEvent.TrackSubscriptionFailed, (sid) => callLog('sub-failed', sid))
      .on(LK.RoomEvent.LocalTrackPublished, (pub) => callLog('published', pub?.source))
      .on(LK.RoomEvent.TrackSubscribed, (t) => callLog('subscribed', t?.source))
      .on(LK.RoomEvent.Disconnected, (r) => callLog('disconnected', r));
    room
      .on(LK.RoomEvent.TrackSubscribed, (track, pub, participant) => {
        if (track.kind === 'audio') {
          let el;
          if (call.blessed && !call.blessedUsed) { el = track.attach(call.blessed); call.blessedUsed = true; }
          else { el = track.attach(); el.setAttribute('playsinline', ''); $('#callAudio').appendChild(el); }
          el.muted = false;
          el.play?.().catch(() => $('#callSound').classList.remove('hidden')); // не дали играть — покажем кнопку
          applyVolume(participant);
        }
        renderCall();
      })
      .on(LK.RoomEvent.TrackUnsubscribed, (track) => { track.detach().forEach((el) => el.remove()); renderCall(); })
      .on(LK.RoomEvent.ParticipantConnected, () => { clearTimeout(call.ringTimeout); stopRingback(); renderCall(); })
      .on(LK.RoomEvent.ParticipantDisconnected, () => {
        renderCall();
        if (chat.startsWith('d:') && room.remoteParticipants.size === 0) { toast('Собеседник завершил звонок'); leaveCall(); }
      })
      .on(LK.RoomEvent.ActiveSpeakersChanged, renderSpeaking)
      .on(LK.RoomEvent.TrackMuted, renderCall).on(LK.RoomEvent.TrackUnmuted, renderCall)
      .on(LK.RoomEvent.LocalTrackPublished, renderCall).on(LK.RoomEvent.LocalTrackUnpublished, renderCall)
      .on(LK.RoomEvent.Disconnected, () => { if (call.room === room) cleanupCall(); })
      .on(LK.RoomEvent.AudioPlaybackStatusChanged, () => $('#callSound').classList.toggle('hidden', room.canPlaybackAudio));
    await room.connect(tok.url, tok.token, relay ? { rtcConfig: { iceTransportPolicy: 'relay' } } : {});
    callLog('connected');
    sb.rpc('sl_call_event', { p_chat: chat, p_action: 'join' }).then(() => {}, () => {});
    clearInterval(call.histTimer);
    call.histTimer = setInterval(() => call.chat && sb.rpc('sl_call_event', { p_chat: call.chat, p_action: 'ping' }).then(() => {}, () => {}), 60000);
    // сторожевой таймер: если голосовой канал не поднялся — пробуем ретранслятор, а если и он не помог — объясняем
    setTimeout(() => {
      if (call.room !== room || mediaConnected(room)) return;
      callLog('media-timeout', JSON.stringify(pcStates(room)));
      collectCallDiag();
      if (!relay) rejoinViaRelay(chat);
      else toast('Не удаётся установить голосовое соединение. Похоже, сеть блокирует звонки: попробуйте другую сеть (мобильный интернет или другой Wi‑Fi) или отключите/включите VPN.');
    }, 10000);
    $('#callTitle').textContent = callTitle(chat);
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
    if (room.remoteParticipants.size === 0 && !opts.rejoin) {
      state.rt.send({ type: 'broadcast', event: 'call', payload: { type: 'ring', chat, from: state.me.id } });
      if (!chat.startsWith('c:')) {
        fn('sl-push', { action: 'ring', chat }).catch(() => {});
        startRingback(); // гудки, пока не ответят
        // телефон собеседника «звонит»: повторяем уведомление каждые 2 с, пока не ответят (до 45 с)
        if (chat.startsWith('d:')) repeatPush(() => call.chat === chat && call.room === room && room.remoteParticipants.size === 0,
          (seq) => fn('sl-push', { action: 'ring', chat, seq }));
      }
      if (chat.startsWith('d:')) {
        call.ringTimeout = setTimeout(() => {
          if (call.chat === chat && room.remoteParticipants.size === 0) { toast('Абонент не отвечает'); playBusy(); leaveCall(); }
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

// Повтор push-уведомления о звонке каждые 2 с, пока условие верно (до ~45 с)
function repeatPush(alive, sendFn, every = 2000, max = 22) {
  let seq = 0;
  const t = setInterval(() => {
    if (!alive() || ++seq > max) return clearInterval(t);
    sendFn(seq).catch(() => {});
  }, every);
  (call.pushTimers = call.pushTimers || []).push(t);
}
async function leaveCall() {
  if (!call.room) return;
  const room = call.room, chat = call.chat;
  if (chat?.startsWith('d:') && room.remoteParticipants.size === 0) {
    state.rt?.send({ type: 'broadcast', event: 'call', payload: { type: 'cancel', chat, from: state.me.id } });
    fn('sl-push', { action: 'ring-cancel', chat }).catch(() => {}); // у собеседника вместо «звонит» — «пропущенный»
  }
  cleanupCall();
  await room.disconnect().catch(() => {});
}
function cleanupCall(o = {}) {
  call.zero = null;
  (call.pushTimers || []).forEach(clearInterval); call.pushTimers = [];
  clearInterval(call.timer); clearInterval(call.diagTimer); clearTimeout(call.ringTimeout);
  stopRingback();
  const ctx = call.audioCtx; call.audioCtx = null;
  if (ctx && !o.keepCtx) setTimeout(() => ctx.close?.().catch(() => {}), 2500); // даём доиграть сигналу «занято»
  if (call.room) collectCallDiag();
  if (call.chat && !o.keepUi) { clearInterval(call.histTimer); sb.rpc('sl_call_event', { p_chat: call.chat, p_action: 'leave' }).then(() => {}, () => {}); }
  call.chat = null; call.room = null;
  if (o.keepUi) { $('#callGrid').innerHTML = ''; $('#callAudio').innerHTML = ''; return; }
  $('#callPanel').classList.add('hidden');
  $('#callPanel').classList.remove('big', 'mini');
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
  $('#callSpeaker').classList.toggle('off', !!call.loud);
  $('#callSpeaker').textContent = call.loud ? '🔊' : '🔈';
  $('#callMic').textContent = call.mic ? '🎤' : '🔇';
  $('#callMicPick').classList.toggle('hidden', isIOS || !navigator.mediaDevices?.enumerateDevices);
  $('#callCam').classList.toggle('off', call.cam);
  $('#callScreen').classList.toggle('off', call.screen);
  $('#callScreen').classList.toggle('hidden', !navigator.mediaDevices?.getDisplayMedia || isPhoneLayout());
  // кто-то показывает экран — на компьютере разворачиваем окно звонка
  const sharing = parts.find((p) => p !== room.localParticipant && p.getTrackPublication(LK.Track.Source.ScreenShare)?.track);
  if (sharing && !isPhoneLayout() && !call.autoBig) { call.autoBig = true; $('#callPanel').classList.add('big'); }
  if (!sharing) call.autoBig = false;
  $('#callGrid').querySelectorAll('.tile').forEach((t) => {
    const p = parts.find((x) => x.identity === t.dataset.pid);
    t.classList.toggle('screen', !!p?.getTrackPublication(LK.Track.Source.ScreenShare)?.track);
  });
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
// Добавить собеседника в идущий звонок
const isMyChat = (chat) => chat.startsWith('c:') || (chat.startsWith('g:') && chatMembers(chat).includes(state.me.id)) || (chat.startsWith('d:') && chat.includes(state.me.id));
function callTitle(chat) {
  if (isMyChat(chat)) return chatTitle(chat);
  if (chat.startsWith('d:')) return chat.split(':').slice(1).map(userName).join(' и ');
  return 'групповой звонок';
}
function openCallInvite() {
  const room = call.room, chat = call.chat;
  if (!room) return;
  const inCall = new Set([room.localParticipant.identity, ...room.remoteParticipants.keys()]);
  const list = activeUsers().filter((u) => !inCall.has(u.id)).sort((a, b) => (state.online.has(b.id) - state.online.has(a.id)) || a.name.localeCompare(b.name, 'ru'));
  openModal(`<h3>➕ Добавить в разговор</h3><div class="modal-body">
    ${list.length ? `<label class="field"><input id="ciQ" placeholder="Поиск сотрудника"></label>` + list.map((u) => `<div class="person" data-uid="${u.id}" data-name="${esc(u.name.toLowerCase())}">
      <span class="sava">${avatar(u, 'sm')}<span class="dot ${state.online.has(u.id) ? 'on' : ''}"></span></span><span style="flex:1;min-width:0">${esc(u.name)}<div class="u-meta">${esc(statusOf(u) || u.position || '')}</div></span>
      <button class="hbtn primary-sm">Позвать</button></div>`).join('') : '<p class="muted">Все сотрудники уже в разговоре</p>'}
    </div><div class="modal-foot"><span class="spacer"></span><button class="primary" data-close>Готово</button></div>`,
  (root) => {
    root.querySelector('[data-close]').onclick = closeModal;
    const q = root.querySelector('#ciQ');
    if (q) q.oninput = () => root.querySelectorAll('.person').forEach((el) => el.classList.toggle('hidden', !el.dataset.name.includes(q.value.toLowerCase().trim())));
    root.querySelectorAll('.person[data-uid]').forEach((el) => el.querySelector('button').onclick = async (e) => {
      const b = e.target, uid = el.dataset.uid;
      b.disabled = true; b.textContent = 'Зовём…';
      try {
        await rpc('sl_call_invite', { p_chat: chat, p_user: uid });
        state.rt?.send({ type: 'broadcast', event: 'call', payload: { type: 'ring', chat, from: state.me.id, to: uid } });
        fn('sl-push', { action: 'invite', chat, user: uid }).catch(() => {});
        const room = call.room;
        repeatPush(() => call.room === room && !room.remoteParticipants.has(uid), (seq) => fn('sl-push', { action: 'invite', chat, user: uid, seq }));
        b.textContent = '✓ Позвали';
        toast(`📞 ${userName(uid)}: приглашение отправлено`);
      } catch (er) { b.disabled = false; b.textContent = 'Позвать'; toast(humanError(er)); }
    });
  });
}
$('#callAdd').onclick = openCallInvite;
$('#callScreen').onclick = async () => {
  if (!call.room) return;
  try { call.screen = !call.screen; await call.room.localParticipant.setScreenShareEnabled(call.screen); }
  catch { call.screen = false; toast('Показ экрана недоступен на этом устройстве'); }
  renderCall();
};
$('#callLeave').onclick = () => leaveCall();
// на телефоне звонок во весь экран (кнопка сворачивает), на компьютере — окошко (кнопка разворачивает)
const isPhoneLayout = () => window.matchMedia('(max-width: 720px)').matches;
$('#callExpand').onclick = () => $('#callPanel').classList.toggle(isPhoneLayout() ? 'mini' : 'big');

// ---------- Гудки и сигнал «занято» (425 Гц, как в телефонной сети) ----------
let ringback = null;
function tone(ctx, at, dur, freq = 425, vol = 0.12) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(vol, at + 0.02);
  g.gain.setValueAtTime(vol, at + dur - 0.03);
  g.gain.linearRampToValueAtTime(0, at + dur);
  o.connect(g).connect(ctx.destination);
  o.start(at); o.stop(at + dur + 0.05);
}
function startRingback() {
  const ctx = call.audioCtx;
  if (!ctx || ringback) return;
  const beep = () => tone(ctx, ctx.currentTime + 0.05, 1.0); // гудок 1 с, пауза 4 с
  beep();
  ringback = setInterval(beep, 5000);
}
function stopRingback() { clearInterval(ringback); ringback = null; }
function playBusy() {
  const ctx = call.audioCtx;
  stopRingback();
  if (!ctx) return;
  for (let i = 0; i < 4; i++) tone(ctx, ctx.currentTime + 0.05 + i * 0.7, 0.35);
}

// ---------- Громкая связь ----------
function applyVolume(p) {
  if (!p?.setVolume) return;
  // усиление выше 100% возможно только через Web Audio (на iPhone — именно так)
  const loud = call.loud ? (call.audioCtx ? 3 : 1) : 1;
  try { p.setVolume(loud); } catch {}
}
$('#callSpeaker').onclick = async () => {
  const room = call.room;
  if (!room) return;
  call.loud = !call.loud;
  // 1) если браузер умеет выбирать динамик — переключаем устройство вывода
  try {
    const outs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput' && d.label);
    if (outs.length > 1) {
      const speaker = outs.find((d) => /speaker|динамик|громк/i.test(d.label));
      const ear = outs.find((d) => /earpiece|receiver|трубк|телефон/i.test(d.label)) || outs.find((d) => d.deviceId === 'default');
      const target = call.loud ? speaker : ear;
      if (target) await room.switchActiveDevice('audiooutput', target.deviceId);
    }
  } catch {}
  // 2) громкость собеседников (усиление выше 100% — только через Web Audio, т.е. не в Safari)
  for (const p of room.remoteParticipants.values()) applyVolume(p);
  renderCall();
  if (call.blessed && isIOS) {
    toast(call.loud
      ? '🔊 На iPhone сайт не может сам переключить динамик. Если звук тихий — нажмите кнопки громкости или выберите «Динамик» в Пункте управления (значок AirPlay).'
      : 'Громкая связь выключена');
  } else toast(call.loud ? '🔊 Громкая связь включена' : 'Громкая связь выключена');
};
window.addEventListener('beforeunload', () => { call.room?.disconnect(); });

// Входящий звонок
let ringAudio = null, incomingChat = null, incomingTimeout = null;
function onCallSignal(p) {
  if (!p || p.from === state.me.id) return;
  if (p.type === 'hello') { if (call.chat) announceCall(); return; }
  if (p.type === 'nohear') { // нас не слышат — переподключаемся через защищённый ретранслятор
    if (p.to === state.me.id && call.chat === p.chat && call.room && !call.relay && !call.joining) {
      callLog('nohear-recv', userName(p.from));
      rejoinViaRelay(p.chat);
    }
    return;
  }
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
    if (p.to) { // приглашение в идущий звонок — только адресату
      if (p.to === state.me.id && call.chat !== p.chat) showIncoming(p.chat, p.from, true);
      return;
    }
    if (call.chat === p.chat || !chatMembers(p.chat).includes(state.me.id)) return;
    if (p.chat.startsWith('c:')) return; // в каналах не звоним всем — только значок «идёт созвон»
    showIncoming(p.chat, p.from);
  } else if (p.type === 'cancel' && incomingChat === p.chat) {
    hideIncoming();
    toast(`Пропущенный звонок от ${userName(p.from)}`, () => openChat(p.chat));
  } else if (p.type === 'decline' && call.chat === p.chat && (p.invite || p.chat.startsWith('d:'))) {
    if (p.invite || call.room?.remoteParticipants.size) { toast(`${userName(p.from)} не может присоединиться`); return; }
    toast(`${userName(p.from)} отклонил(а) звонок`);
    playBusy();
    leaveCall();
  }
}
let incomingInvite = false;
function showIncoming(chat, from, invite = false) {
  incomingChat = chat; incomingInvite = invite;
  const u = state.users.get(from) || { id: from, name: 'Сотрудник' };
  $('#incomingAva').innerHTML = avatar(u);
  $('#incomingName').textContent = u.name;
  $('#incomingSub').textContent = invite ? `Приглашает в разговор: ${callTitle(chat)}` : chat.startsWith('d:') ? 'Входящий звонок' : `Звонок в «${chatTitle(chat)}»`;
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
$('#incomingAccept').onclick = () => { const c = incomingChat; hideIncoming(); if (isMyChat(c)) openChat(c); joinCall(c); };
$('#incomingDecline').onclick = () => {
  const c = incomingChat;
  hideIncoming();
  state.rt.send({ type: 'broadcast', event: 'call', payload: { type: 'decline', chat: c, from: state.me.id, invite: incomingInvite } });
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
  const [key, value] = h.split('&')[0].split('=');
  if (key === 'chat' && value) { openChat(decodeURIComponent(value)); return true; }
  if (key === 'call' && value) { // приглашение в звонок: подтверждаем нажатием (без него телефон не даст микрофон)
    const from = new URLSearchParams(h.split('&').slice(1).join('&')).get('from');
    showIncoming(decodeURIComponent(value), from, true);
    return true;
  }
  if (key === 'task' && value) {
    openTasks();
    (state.tasksLoaded || Promise.resolve()).then(() => openTaskView(Number(value)));
    return true;
  }
  if (key === 'tasks') { openTasks(); return true; }
  if (key === 'ann') { openChat(state.current || `c:${state.channels[0]?.id}`); loadAnnouncements(); return true; }
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
    <div class="modal-body">${status}${body}
      <label class="check" style="margin-top:10px"><input type="checkbox" id="pSound" ${soundOn() ? 'checked' : ''}> Звук входящих сообщений, пока Shtark Link открыт</label>
      <div class="modal-err" id="mErr"></div></div>
    <div class="modal-foot">${actions || '<span class="spacer"></span>'}<button class="secondary" data-close>Закрыть</button></div>`,
    (root) => {
      const err = (e) => root.querySelector('#mErr').textContent = humanError(e);
      root.querySelector('[data-close]').onclick = closeModal;
      root.querySelector('#pSound').onchange = (e) => { try { localStorage.setItem('sl-sound', e.target.checked ? '1' : '0'); } catch {} if (e.target.checked) { unlockPing(); playPing(); } };
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
