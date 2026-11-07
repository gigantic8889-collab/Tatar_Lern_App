/* ============================================================
   app.js — «Мои подписки»: состояние, отрисовка, уведомления
   ============================================================ */
(function () {
'use strict';

const P = window.SubParser;
const LS_KEY = 'podpiski_state_v1';
const SERVER_FALLBACK = 'http://127.0.0.1:8787';
const serverUrl = (location.protocol === 'http:' || location.protocol === 'https:')
  ? location.origin
  : SERVER_FALLBACK;

const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');

const EMOJIS = ['🔔','🎬','📺','🎵','🎮','📚','🏋️','🎓','☁️','🛡️','📦','📱','🤖','💳','✈️','🍔','🛒','🏠','📰','💊','🎨','🚗','📷','🎤','💬','⭐','🧾','🐾','🌐','⚙️'];

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- состояние ---------- */
const defaultState = () => ({
  subscriptions: [],
  settings: { botToken: '', chatId: '', reminderDefault: 2 }
});

let state = loadState();
let view = ['list', 'calendar', 'catalog', 'settings'].includes(params.get('view')) ? params.get('view') : 'list';
let calMonth = new Date();
let editingId = null;
let formEmoji = '🔔';
let serverOnline = false;
let toastTimer = null;

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      return {
        subscriptions: Array.isArray(s.subscriptions) ? s.subscriptions : [],
        settings: Object.assign(defaultState().settings, s.settings || {})
      };
    }
  } catch (e) { /* повреждённые данные — начнём заново */ }
  return defaultState();
}

function saveState() {
  if (DEMO) return;
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {}
}

/* ---------- даты ---------- */
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const daysLeft = s => Math.round((startOfDay(new Date(s.endDate)) - startOfDay(new Date())) / 86400000);
const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
};
const fmtDate = iso => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const fmtShort = iso => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
const toInputDate = iso => {
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ---------- демо-данные для предпросмотра ---------- */
function seedDemo() {
  const now = new Date();
  const mk = (name, emoji, price, period, inDays, reminderDays) => ({
    id: 'demo-' + name.toLowerCase().replace(/\s+/g, '-'),
    name, emoji, price, period,
    endDate: P.atNoon(P.addDays(now, inDays)).toISOString(),
    reminderDays, notifiedFor: null, renewCount: 0,
    createdAt: now.toISOString(), updatedAt: now.toISOString()
  });
  state.subscriptions = [
    mk('Netflix', '🎬', 999, 'monthly', 1, 3),
    mk('Spotify', '🎵', 169, 'monthly', 6, 2),
    mk('ЛитРес', '📚', 199, 'monthly', 12, 2),
    mk('Иви', '🎬', 399, 'monthly', 28, 2),
    mk('Яндекс Плюс', '📦', 299, 'monthly', 45, 2),
    mk('Курс английского', '🎓', 2450, 'once', -3, 3)
  ];
}

/* ---------- продление повторяющихся подписок ---------- */
function processRenewals() {
  const now = new Date();
  let changed = false;
  for (const s of state.subscriptions) {
    if (!s.period || s.period === 'once') continue;
    let end = new Date(s.endDate);
    let n = 0;
    while (startOfDay(end) < startOfDay(now) && n < 60) {
      end = s.period === 'monthly' ? P.addMonths(end, 1) : P.addYears(end, 1);
      n++;
    }
    if (n > 0) {
      s.endDate = end.toISOString();
      s.notifiedFor = null;
      s.renewCount = (s.renewCount || 0) + n;
      changed = true;
    }
  }
  if (changed) saveState();
}

/* ---------- статус подписки ---------- */
function statusFor(s) {
  const dl = daysLeft(s);
  if (s.period === 'once' && dl < 0) return 'expired';
  if (dl <= 1) return 'urgent';
  if (dl <= s.reminderDays) return 'soon';
  return 'ok';
}

/* ---------- уведомления ---------- */
function buildMessage(s, dl) {
  const date = fmtDate(s.endDate);
  const extra = s.period === 'monthly'
    ? '\n🔁 Ежемесячная — после этой даты продлится автоматически.'
    : s.period === 'yearly'
      ? '\n🔁 Ежегодная — после этой даты продлится автоматически.'
      : '';
  if (dl === 0) return `⏰ ${s.emoji} Подписка «${s.name}» заканчивается сегодня (${date}). Пора решить: продлить или отменить.${extra}`;
  if (dl === 1) return `⏰ ${s.emoji} Подписка «${s.name}» закончится завтра (${date}).${extra}`;
  return `⏰ ${s.emoji} Подписка «${s.name}» закончится через ${dl} ${plural(dl, 'день', 'дня', 'дней')} (${date}).${extra}`;
}

async function sendTelegram(text, token, chatId) {
  const t = token || state.settings.botToken;
  const c = chatId || state.settings.chatId;
  if (!t || !c) return false;
  /* 1) напрямую в Telegram API */
  try {
    const r = await fetch(`https://api.telegram.org/bot${t}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: c, text, disable_web_page_preview: true })
    });
    const j = await r.json();
    if (j.ok) return true;
  } catch (e) {}
  /* 2) через локальный сервер */
  try {
    const r = await fetch(serverUrl + '/api/telegram/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    const j = await r.json();
    return !!j.ok;
  } catch (e) {}
  return false;
}

async function checkNotifications() {
  processRenewals();
  if (!state.settings.botToken || !state.settings.chatId) return;
  let changed = false;
  for (const s of state.subscriptions) {
    const dl = daysLeft(s);
    const key = s.endDate.slice(0, 10);
    if (s.notifiedFor === key) continue;
    if (dl >= 0 && dl <= s.reminderDays) {
      const ok = await sendTelegram(buildMessage(s, dl));
      if (ok) { s.notifiedFor = key; changed = true; }
      else break;
    }
  }
  if (changed) { saveState(); render(); }
}

/* ---------- синхронизация с локальным сервером ---------- */
async function pushState() {
  try {
    const r = await fetch(serverUrl + '/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscriptions: state.subscriptions })
    });
    serverOnline = r.ok;
    updateServerBadge();
  } catch (e) { serverOnline = false; updateServerBadge(); }
}

async function pushSettings() {
  try {
    await fetch(serverUrl + '/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botToken: state.settings.botToken, chatId: state.settings.chatId, reminderDefault: state.settings.reminderDefault })
    });
  } catch (e) {}
}

async function syncWithServer() {
  try {
    const r = await fetch(serverUrl + '/api/state', { headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error('bad status');
    const data = await r.json();
    serverOnline = true;
    let changed = false;
    /* подтянуть подписки, добавленные через бота */
    const local = new Map(state.subscriptions.map(s => [s.id, s]));
    for (const s of data.subscriptions || []) {
      const l = local.get(s.id);
      if (!l) { state.subscriptions.push(s); changed = true; }
      else {
        const lt = new Date(l.updatedAt || 0).getTime();
        const st = new Date(s.updatedAt || 0).getTime();
        if (st > lt) { Object.assign(l, s); changed = true; }
      }
    }
    /* chat_id мог определиться через бота */
    if (!state.settings.chatId && data.settings && data.settings.chatId) {
      state.settings.chatId = data.settings.chatId;
      changed = true;
    }
    if (changed) { saveState(); render(); }
    updateServerBadge();
  } catch (e) {
    serverOnline = false;
    updateServerBadge();
  }
}

function updateServerBadge() {
  const dot = $('server-badge');
  dot.classList.toggle('on', serverOnline);
  dot.classList.toggle('off', !serverOnline);
  dot.title = serverOnline
    ? 'Локальный сервер запущен — напоминания придут, даже если сайт закрыт'
    : 'Локальный сервер не запущен — Telegram-напоминания отправляются, пока сайт открыт';
  const st = $('server-status');
  st.className = 'server-status' + (serverOnline ? ' on' : '');
  st.textContent = serverOnline
    ? '🟢 Локальный сервер запущен: напоминания в Telegram придут, даже если сайт закрыт.'
    : '⚪ Локальный сервер не запущен: напоминания отправляются только пока сайт открыт. Запустите сервер командой node server.js и обновите страницу.';
}

/* ---------- рендер: список ---------- */
function cardHTML(s, i) {
  const dl = daysLeft(s);
  const cls = statusFor(s);
  let badge;
  if (cls === 'expired') badge = 'закончилась ' + fmtShort(s.endDate);
  else if (dl === 0) badge = 'сегодня!';
  else if (dl === 1) badge = 'завтра!';
  else badge = dl + ' ' + plural(dl, 'день', 'дня', 'дней');
  const periodTxt = s.period === 'monthly' ? 'ежемесячно' : s.period === 'yearly' ? 'ежегодно' : 'разовая';
  const priceTxt = s.price ? ' · ' + s.price.toLocaleString('ru-RU') + ' ₽' : '';
  return `
  <div class="card ${cls}" data-id="${esc(s.id)}" style="animation-delay:${Math.min(i * 45, 400)}ms">
    <div class="card-top">
      <div class="emoji">${s.emoji}</div>
      <div class="card-title">
        <div class="name">${esc(s.name)}</div>
        <div class="meta">${periodTxt}${priceTxt}</div>
      </div>
      <div class="badge ${cls}">${badge}</div>
    </div>
    <div class="endline">📅 до ${fmtDate(s.endDate)}</div>
    <div class="card-bottom">
      <div class="chip">🔔 за ${s.reminderDays} ${plural(s.reminderDays, 'день', 'дня', 'дней')}</div>
      <div class="actions">
        <button class="icon-btn act-edit" data-id="${esc(s.id)}" title="Изменить">✏️</button>
        <button class="icon-btn act-del" data-id="${esc(s.id)}" title="Удалить">🗑️</button>
      </div>
    </div>
  </div>`;
}

function emptyHTML() {
  return `
  <div class="empty">
    <span class="big">🔔</span>
    <h3>Подписок пока нет</h3>
    <p>Напишите в поле выше или нажмите на пример:</p>
    <div class="examples">
      <button class="example-chip" data-text="Иви через 30 дней">🎬 Иви через 30 дней</button>
      <button class="example-chip" data-text="Netflix 999 ₽ в месяц">🎬 Netflix 999 ₽ в месяц</button>
      <button class="example-chip" data-text="Кинопоиск до 15 декабря">🍿 Кинопоиск до 15 декабря</button>
      <button class="example-chip" data-text="Spotify ежемесячно, напомни за 3 дня">🎵 Spotify, напомни за 3 дня</button>
    </div>
  </div>`;
}

function renderList() {
  const sorted = [...state.subscriptions].sort((a, b) => {
    const da = daysLeft(a), db = daysLeft(b);
    const ea = a.period === 'once' && da < 0, eb = b.period === 'once' && db < 0;
    if (ea !== eb) return ea ? 1 : -1;
    return da - db;
  });
  const active = sorted.filter(s => !(s.period === 'once' && daysLeft(s) < 0));
  const soon = active.filter(s => daysLeft(s) <= s.reminderDays);
  $('stats').innerHTML = `
    <div class="stat"><div class="stat-num">${active.length}</div><div class="stat-label">активных подписок</div></div>
    <div class="stat"><div class="stat-num ${soon.length ? 'warn' : ''}">${soon.length}</div><div class="stat-label">скоро заканчиваются</div></div>
    <div class="stat"><div class="stat-num">${state.subscriptions.length}</div><div class="stat-label">всего в списке</div></div>`;
  $('list').innerHTML = sorted.length
    ? sorted.map((s, i) => cardHTML(s, i)).join('')
    : emptyHTML();
}

/* ---------- рендер: календарь ---------- */
function renderCalendar() {
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  $('cal-title').textContent = calMonth.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });

  const byDay = {};
  const monthSubs = [];
  for (const s of state.subscriptions) {
    const d = new Date(s.endDate);
    if (d.getFullYear() === y && d.getMonth() === m) {
      (byDay[d.getDate()] = byDay[d.getDate()] || []).push(s);
      monthSubs.push(s);
    }
  }
  monthSubs.sort((a, b) => new Date(a.endDate) - new Date(b.endDate));

  const first = new Date(y, m, 1);
  const offset = (first.getDay() + 6) % 7; /* неделя с понедельника */
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const today = new Date();
  const wd = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

  let html = wd.map(w => `<div class="cal-cell empty" style="min-height:0"><div class="cal-num" style="text-transform:uppercase">${w}</div></div>`).join('');
  for (let i = 0; i < offset; i++) html += '<div class="cal-cell empty"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const isToday = today.getFullYear() === y && today.getMonth() === m && today.getDate() === d;
    const subs = byDay[d] || [];
    const dots = subs.map(s => `<span class="cal-sub ${statusFor(s)}" title="${esc(s.name)}">${s.emoji}</span>`).join('');
    const tip = subs.length ? `<div class="cal-tip">${subs.map(s => `${s.emoji} ${esc(s.name)}`).join('<br>')}</div>` : '';
    html += `<div class="cal-cell ${isToday ? 'today' : ''}">
      <div class="cal-num">${d}</div>
      <div class="cal-subs">${dots}</div>${tip}
    </div>`;
  }
  $('cal-grid').innerHTML = html;

  $('cal-month-list').innerHTML = monthSubs.length
    ? `<div class="cal-item" style="font-weight:700;color:var(--accent-3)">В этом месяце заканчиваются (${monthSubs.length}):</div>` +
      monthSubs.map((s, i) => `
        <div class="cal-item" style="animation-delay:${Math.min(i * 40, 300)}ms">
          ${s.emoji} <b>${esc(s.name)}</b>
          ${s.price ? ` · ${s.price.toLocaleString('ru-RU')} ₽` : ''}
          <span class="d">${fmtShort(s.endDate)}${s.period !== 'once' ? ' · 🔁' : ''}</span>
        </div>`).join('')
    : '<div class="cal-item" style="color:var(--muted)">В этом месяце подписок к окончанию нет 🎉</div>';
}

/* ---------- рендер: каталог сервисов ---------- */
function catalogItemHTML(c, i) {
  const until = c.paidUntil ? fmtDate(c.paidUntil) : '';
  return `
  <a class="catalog-item" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer" style="animation-delay:${Math.min(i * 45, 400)}ms">
    <div class="emoji">${c.emoji || '🔗'}</div>
    <div class="catalog-info">
      <div class="name">${esc(c.name || c.url)}</div>
      <div class="url">${esc(c.url)}</div>
      <div class="meta">${until ? 'активна до ' + until : ''}${c.createdAt ? ' · добавлена ' + fmtDate(c.createdAt) : ''}</div>
    </div>
    <div class="catalog-arrow">↗</div>
  </a>`;
}

async function renderCatalog() {
  const el = $('catalog');
  el.innerHTML = '<div class="empty"><span class="big">🌐</span><p>Загружаю каталог…</p></div>';
  try {
    const r = await fetch(serverUrl + '/api/catalog');
    const j = await r.json();
    const items = Array.isArray(j.catalog) ? j.catalog : [];
    el.innerHTML = items.length
      ? items.map((c, i) => catalogItemHTML(c, i)).join('')
      : `<div class="empty">
           <span class="big">🌐</span>
           <h3>Каталог пока пуст</h3>
           <p>Хочешь разместить свой сервис? Напиши нашему боту ссылку — 30 ⭐/мес, продлевается автоматически.</p>
         </div>`;
  } catch (e) {
    el.innerHTML = '<div class="empty"><span class="big">🌐</span><h3>Каталог недоступен</h3><p>Запустите локальный сервер (start.cmd) — каталог хранится на нём.</p></div>';
  }
}

/* ---------- рендер: админка каталога (настройки) ---------- */
async function renderAdminCatalog() {
  const el = $('admin-catalog');
  try {
    const r = await fetch(serverUrl + '/api/catalog/admin');
    const j = await r.json();
    const subs = j.subscribers || [];
    const links = j.catalog || [];
    const now = new Date();
    el.innerHTML = `
      <div class="stat-num" style="font-size:22px;margin-bottom:10px">${subs.length} <span class="muted" style="font-size:13px;font-weight:400">активных подписчиков</span></div>
      ${links.length ? links.map(l => {
        const active = l.paidUntil && new Date(l.paidUntil) > now;
        return `<div class="cal-item">
          ${l.emoji || '🔗'} <b>${esc(l.name)}</b>
          <a class="url" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.url)}</a>
          <span class="d">${l.username ? '@' + esc(l.username) : l.userId} · до ${l.paidUntil ? fmtDate(l.paidUntil) : '—'} ${active ? '✅' : '⏳'}</span>
          <button class="icon-btn act-catdel" data-id="${esc(l.id)}" title="Удалить ссылку из каталога">🗑️</button>
        </div>`;
      }).join('') : '<div class="muted">Публикаций пока нет.</div>'}
      <p class="muted" style="margin-top:10px">Клиент пишет боту ссылку → бот выставляет счёт 30 ⭐/мес → после оплаты ссылка публикуется автоматически.</p>`;
  } catch (e) {
    el.innerHTML = '<div class="muted">Сервер не запущен — каталог недоступен.</div>';
  }
}

async function deleteCatalogLink(id) {
  if (!confirm('Удалить ссылку из каталога?')) return;
  try {
    await fetch(serverUrl + '/api/catalog/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    toast('🗑️ Ссылка удалена из каталога');
    renderAdminCatalog();
    renderCatalog();
  } catch (e) {
    toast('Не удалось удалить', false);
  }
}

/* ---------- рендер: настройки ---------- */
function renderSettings() {
  $('s-token').value = state.settings.botToken || '';
  $('s-chatid').value = state.settings.chatId || '';
  $('s-default-remind').value = String(state.settings.reminderDefault || 2);
  updateServerBadge();
  renderAdminCatalog();
}

function buildRemindSelects() {
  let opts = '';
  for (let i = 1; i <= 7; i++) opts += `<option value="${i}">за ${i} ${plural(i, 'день', 'дня', 'дней')}</option>`;
  $('f-remind').innerHTML = opts;
  $('s-default-remind').innerHTML = opts;
}

function render() {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('hidden', v.id !== 'view-' + view));
  renderList();
  renderCalendar();
  renderCatalog();
  renderSettings();
}

/* ---------- добавление свободным текстом ---------- */
function addFromText(raw) {
  const text = String(raw || '').trim();
  if (!text) return;
  const parsed = P.parseFreeText(text, new Date());
  if (!parsed.found) {
    openForm({ name: parsed.name || text, hint: 'Не смог понять дату окончания — укажите её в форме.' });
    return;
  }
  const s = {
    id: uid(), name: parsed.name, emoji: P.autoEmoji(parsed.name),
    endDate: parsed.endDate, price: parsed.price, period: parsed.period,
    reminderDays: parsed.reminderDays, notifiedFor: null, renewCount: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  state.subscriptions.push(s);
  saveState(); pushState(); render();
  toast(`${s.emoji} «${s.name}» добавлена — напомню за ${s.reminderDays} ${plural(s.reminderDays, 'день', 'дня', 'дней')} до окончания`);
  $('quick-input').value = '';
  $('quick-input').focus();
}

/* ---------- форма ---------- */
function buildEmojiPicker() {
  $('emoji-picker').innerHTML = EMOJIS.map(e =>
    `<button type="button" class="em ${e === formEmoji ? 'sel' : ''}" data-emoji="${e}" title="${e}">${e}</button>`
  ).join('');
}

function openForm(item, hint) {
  editingId = item && item.id ? item.id : null;
  formEmoji = (item && item.emoji) || P.autoEmoji((item && item.name) || '') || '🔔';
  $('modal-title').textContent = editingId ? 'Изменить подписку' : 'Новая подписка';
  $('f-name').value = (item && item.name) || '';
  $('f-date').value = item ? toInputDate(item.endDate) : '';
  $('f-period').value = (item && item.period) || 'once';
  $('f-price').value = (item && item.price) || '';
  const rem = (item && item.reminderDays) || state.settings.reminderDefault || 2;
  $('f-remind').value = String(Math.min(Math.max(rem, 1), 7));
  const hintEl = $('form-hint');
  hintEl.textContent = hint || '';
  hintEl.style.display = hint ? 'block' : 'none';
  buildEmojiPicker();
  $('modal').classList.remove('hidden');
  setTimeout(() => $('f-name').focus(), 60);
}

function closeForm() {
  $('modal').classList.add('hidden');
  editingId = null;
}

function saveForm() {
  const name = $('f-name').value.trim();
  const dateVal = $('f-date').value;
  const period = $('f-period').value;
  const price = parseFloat($('f-price').value);
  const remind = parseInt($('f-remind').value, 10) || state.settings.reminderDefault || 2;

  if (!name) { toast('Укажите название', false); $('f-name').focus(); return; }

  let endDate = null;
  if (dateVal) {
    const parts = dateVal.split('-').map(Number);
    endDate = new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0);
  } else if (period !== 'once') {
    const base = period === 'monthly' ? P.addMonths(new Date(), 1) : P.addYears(new Date(), 1);
    endDate = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 12, 0, 0);
  } else {
    toast('Укажите дату окончания', false);
    return;
  }

  const data = {
    name, emoji: formEmoji, endDate: endDate.toISOString(),
    price: isNaN(price) ? null : Math.round(price * 100) / 100,
    period, reminderDays: remind, renewCount: 0,
    updatedAt: new Date().toISOString()
  };

  if (editingId) {
    const s = state.subscriptions.find(x => x.id === editingId);
    if (s) {
      /* дата не менялась — не будем слать напоминание повторно */
      data.notifiedFor = s.endDate.slice(0, 10) === data.endDate.slice(0, 10) ? s.notifiedFor : null;
      Object.assign(s, data);
      toast(`✏️ «${name}» обновлена`);
    }
  } else {
    state.subscriptions.push(Object.assign({ id: uid(), createdAt: new Date().toISOString(), notifiedFor: null }, data));
    toast(`✅ «${name}» добавлена — напомню за ${remind} ${plural(remind, 'день', 'дня', 'дней')} до окончания`);
  }
  saveState(); pushState(); render(); closeForm();
}

function deleteSub(id) {
  const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  const done = () => {
    state.subscriptions = state.subscriptions.filter(s => s.id !== id);
    saveState(); pushState(); render();
    toast('🗑️ Подписка удалена');
  };
  if (card) { card.classList.add('removing'); setTimeout(done, 280); }
  else done();
}

/* ---------- настройки Telegram ---------- */
function saveSettings() {
  state.settings.botToken = $('s-token').value.trim();
  state.settings.chatId = $('s-chatid').value.trim();
  saveState(); pushSettings();
  toast('💾 Настройки сохранены');
}

async function detectChatId() {
  const token = state.settings.botToken || $('s-token').value.trim();
  if (!token) { toast('Сначала вставьте токен бота', false); return; }
  const btn = $('s-detect');
  const old = btn.textContent;
  btn.textContent = '⏳ Ищу…';
  btn.disabled = true;
  let ids = [];

  /* 1) напрямую из браузера — быстро и работает даже без сервера */
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=100`, { method: 'POST' });
    const j = await r.json();
    if (j.ok && Array.isArray(j.result)) {
      const seen = new Set();
      for (const u of j.result) {
        const msg = u.message || u.edited_message || u.channel_post;
        if (msg && msg.chat) seen.add(String(msg.chat.id));
      }
      ids = [...seen];
    } else if (j.description) {
      toast('Telegram: ' + j.description, false);
      btn.textContent = old; btn.disabled = false;
      return;
    }
  } catch (e) { /* продолжим через сервер */ }

  /* 2) через локальный сервер — находит чаты, которые сервер уже видел */
  if (!ids.length && serverOnline) {
    try {
      const r = await fetch(serverUrl + '/api/telegram/chatid?token=' + encodeURIComponent(token));
      const j = await r.json();
      if (Array.isArray(j.ids)) ids = j.ids;
    } catch (e) {}
  }

  btn.textContent = old; btn.disabled = false;
  if (!ids.length) {
    toast('Пока пусто: напишите боту /start и нажмите ещё раз', false);
    return;
  }
  state.settings.chatId = ids[0];
  $('s-chatid').value = ids[0];
  saveState(); pushSettings();
  toast('✅ Chat ID определён: ' + ids[0] + (ids.length > 1 ? ` (найдено ${ids.length})` : ''));
}

async function sendTest() {
  const token = state.settings.botToken || $('s-token').value.trim();
  const chatId = state.settings.chatId || $('s-chatid').value.trim();
  if (!token || !chatId) { toast('Нужны токен и chat_id', false); return; }
  const ok = await sendTelegram('✅ Тест: уведомления о подписках работают!', token, chatId);
  toast(ok ? '📨 Тест отправлен — проверьте Telegram' : '❌ Не удалось отправить: проверьте токен и chat_id', ok);
}

/* ---------- данные ---------- */
function exportJSON() {
  const blob = new Blob([JSON.stringify({
    subscriptions: state.subscriptions,
    settings: state.settings,
    exportedAt: new Date().toISOString()
  }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'podpiski-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('⬇️ Файл скачан');
}

function importJSON(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const subs = Array.isArray(data) ? data : data.subscriptions;
      if (!Array.isArray(subs)) throw new Error('bad');
      const clean = subs
        .filter(s => s && s.id && s.name && s.endDate)
        .map(s => Object.assign({ period: 'once', reminderDays: state.settings.reminderDefault || 2, price: null, emoji: '🔔', renewCount: 0, notifiedFor: null }, s));
      state.subscriptions = clean;
      if (data.settings && data.settings.botToken) state.settings.botToken = data.settings.botToken;
      if (data.settings && data.settings.chatId) state.settings.chatId = data.settings.chatId;
      saveState(); pushState(); render();
      toast(`✅ Импортировано подписок: ${clean.length}`);
    } catch (e) {
      toast('Не удалось прочитать файл', false);
    }
  };
  reader.readAsText(file);
}

function clearAll() {
  if (!confirm('Удалить ВСЕ подписки и настройки?')) return;
  state.subscriptions = [];
  state.settings.botToken = '';
  state.settings.chatId = '';
  saveState(); pushState(); render();
  toast('🗑️ Все данные очищены');
}

/* ---------- toast ---------- */
function toast(text, ok = true) {
  const t = $('toast');
  t.textContent = text;
  t.className = 'toast show ' + (ok ? 'ok' : 'err');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 3400);
}

/* ---------- события ---------- */
function bindEvents() {
  document.addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (tab) { view = tab.dataset.view; render(); return; }

    const chip = e.target.closest('.example-chip');
    if (chip) { addFromText(chip.dataset.text); return; }

    const edit = e.target.closest('.act-edit');
    if (edit) { const s = state.subscriptions.find(x => x.id === edit.dataset.id); if (s) openForm(s); return; }

    const del = e.target.closest('.act-del');
    if (del) { deleteSub(del.dataset.id); return; }

    const catdel = e.target.closest('.act-catdel');
    if (catdel) { deleteCatalogLink(catdel.dataset.id); return; }

    const em = e.target.closest('.emoji-picker .em');
    if (em) { formEmoji = em.dataset.emoji; buildEmojiPicker(); return; }

    switch (e.target.id) {
      case 'quick-add-btn': addFromText($('quick-input').value); break;
      case 'open-form-btn': openForm(null); break;
      case 'f-cancel': closeForm(); break;
      case 'f-save': saveForm(); break;
      case 'cal-prev': calMonth = P.addMonths(calMonth, -1); renderCalendar(); break;
      case 'cal-next': calMonth = P.addMonths(calMonth, 1); renderCalendar(); break;
      case 'cal-today': calMonth = new Date(); renderCalendar(); break;
      case 's-save': saveSettings(); break;
      case 's-test': sendTest(); break;
      case 's-detect': detectChatId(); break;
      case 's-export': exportJSON(); break;
      case 's-import': $('s-import-file').click(); break;
      case 's-clear': clearAll(); break;
    }
  });

  /* ripple-эффект при нажатии кнопок */
  document.addEventListener('pointerdown', e => {
    const btn = e.target.closest('.btn, .tab, .icon-btn, .example-chip, .emoji-picker .em');
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    if (!rect.width) return;
    const d = Math.max(rect.width, rect.height);
    const span = document.createElement('span');
    span.className = 'ripple';
    span.style.width = span.style.height = d + 'px';
    span.style.left = (e.clientX - rect.left - d / 2) + 'px';
    span.style.top = (e.clientY - rect.top - d / 2) + 'px';
    btn.appendChild(span);
    setTimeout(() => span.remove(), 600);
  });

  $('quick-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') addFromText($('quick-input').value);
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeForm();
  });

  $('modal').addEventListener('click', e => {
    if (e.target === $('modal')) closeForm();
  });

  $('s-import-file').addEventListener('change', e => {
    if (e.target.files && e.target.files[0]) importJSON(e.target.files[0]);
    e.target.value = '';
  });

  $('s-default-remind').addEventListener('change', e => {
    state.settings.reminderDefault = parseInt(e.target.value, 10) || 2;
    saveState(); pushSettings();
    toast('🔔 По умолчанию: напоминать за ' + state.settings.reminderDefault + ' ' + plural(state.settings.reminderDefault, 'день', 'дня', 'дней'));
  });

  /* при возврате на вкладку — проверить напоминания и синхронизацию */
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { checkNotifications(); syncWithServer(); }
  });
  window.addEventListener('focus', checkNotifications);
}

/* ---------- запуск ---------- */
function init() {
  if (DEMO) {
    seedDemo();
    $('demo-banner').classList.remove('hidden');
  }
  buildRemindSelects();
  bindEvents();
  render();
  processRenewals();
  checkNotifications();
  syncWithServer();
  setInterval(checkNotifications, 5 * 60 * 1000);
  setInterval(syncWithServer, 30 * 1000);
}

document.addEventListener('DOMContentLoaded', init);
})();
