(function () {
'use strict';
var $ = function (id) { return document.getElementById(id); };
var DAY = 86400000;
var NATIVE = !!(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform());
var _plug = {};
function plug(n) {
  if (!NATIVE || !window.Capacitor || !Capacitor.registerPlugin) return null;
  if (!(n in _plug)) { try { _plug[n] = Capacitor.registerPlugin(n); } catch (e) { _plug[n] = null; } }
  return _plug[n];
}
function load(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
function store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

/* ---------- state ---------- */
var DEF = { lang: 'fr', theme: 'dark', weekStart: 0, work: 42, rest: 14, bonus: 2, ownFar: 4, ownNear: 2, comp: 2,
  notifOn: false, notifTime: '08:00', notifDays: 2, lastBackup: null };
var S = Object.assign({}, DEF, load('gcbShiftSettings', {}));
// migration : ancien réglage "own" (véhicule personnel) -> ">= 800 km"
if (S.own != null) { var _o = parseInt(S.own, 10); if (!isNaN(_o) && !load('gcbShiftSettings', {}).ownFar) S.ownFar = _o; delete S.own; }
var rotations = load('gcbShiftRotations', []);
if (!Array.isArray(rotations)) rotations = [];
// migration : ancien transport 'Propres Moyens' -> 'own_far'
rotations.forEach(function (r) { if (r && r.transport === 'Propres Moyens') r.transport = 'own_far'; });
store('gcbShiftRotations', rotations);
var customH = load('gcbShiftCustomHolidays', []);
var hOv = load('gcbShiftHolidayOverrides', {});
var editingId = null, holEditId = null, calSel = null, notifState = '';
var saveSettings = function () { store('gcbShiftSettings', S); };

/* ---------- helpers ---------- */
function t(k, v) {
  var dict = (window.I18N && I18N[S.lang]) || {};
  var s = dict[k] != null ? dict[k] : ((I18N.fr && I18N.fr[k]) || k);
  if (v) for (var x in v) s = s.split('{' + x + '}').join(v[x]);
  return s;
}
function loc() { return { fr: 'fr-FR', en: 'en-GB', ar: 'ar-DZ' }[S.lang] || 'fr-FR'; }
function fmt(d) { return d.toLocaleDateString(loc(), { day: '2-digit', month: 'short', year: 'numeric' }); }
function iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function parse(s) { var p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function today() { var d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function uid() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2); }
function daysBetween(a, b) { return Math.round((b - a) / DAY); }

/* ---------- holidays ---------- */
function hName(h) {
  if (h.custom) return h.name;
  var n = (window.HNAMES || {})[h.key];
  var base = n ? (n[S.lang] || n.fr) : h.key;
  return h.day ? base + ' (' + t('dayN', { n: h.day }) + ')' : base;
}
function holidays() {
  var out = (window.GCB_HOLIDAYS || []).map(function (h) {
    return Object.assign({}, h, { orig: h.date, date: hOv[h.id] || h.date, modified: !!hOv[h.id] });
  });
  customH.forEach(function (c) { out.push({ id: c.id, date: c.date, name: c.name, type: 'custom', custom: true }); });
  out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  return out;
}

/* ---------- rotation maths ---------- */
function calc(r, hs) {
  var start = parse(r.start), endWork = addDays(start, S.work - 1);
  var worked = hs.filter(function (h) { var d = parse(h.date); return d >= start && d <= endWork; });
  var route = r.transport === 'own_far' ? S.ownFar : r.transport === 'own_near' ? S.ownNear : S.comp;
  var rest = S.rest + worked.length * S.bonus + route;
  var endRest = addDays(endWork, rest), next = addDays(endRest, 1), td = today();
  var status, remaining = 0, phaseEnd, progress = 0;
  if (td < start) { status = 'upcoming'; remaining = daysBetween(td, start); phaseEnd = start; }
  else if (td <= endWork) { status = 'work'; remaining = daysBetween(td, endWork); phaseEnd = endWork; progress = Math.min(100, Math.round((daysBetween(start, td) + 1) / S.work * 100)); }
  else if (td <= endRest) { status = 'rest'; remaining = daysBetween(td, endRest); phaseEnd = endRest; progress = rest ? Math.min(100, Math.round(daysBetween(endWork, td) / rest * 100)) : 100; }
  else { status = 'done'; phaseEnd = endRest; progress = 100; }
  return Object.assign({}, r, { startDate: start, endWork: endWork, worked: worked, route: route, rest: rest,
    endRest: endRest, next: next, status: status, remaining: remaining, phaseEnd: phaseEnd, progress: progress });
}
function pick(all) {
  var cur = all.filter(function (r) { return r.status === 'work' || r.status === 'rest'; })[0];
  if (cur) return cur;
  var up = all.filter(function (r) { return r.status === 'upcoming'; }).sort(function (a, b) { return a.startDate - b.startDate; })[0];
  if (up) return up;
  return all.slice().sort(function (a, b) { return b.startDate - a.startDate; })[0];
}
function chrono(all) { return all.slice().sort(function (a, b) { return a.startDate - b.startDate; }); }
var ST_LABEL = { upcoming: 'stUpcoming', work: 'stWork', rest: 'stRest', done: 'stDone' };
var ST_REM = { upcoming: 'remStart', work: 'remWork', rest: 'remRest', done: 'remDone' };
var ST_PH = { upcoming: 'phBefore', work: 'phWork', rest: 'phRest', done: 'phDone' };

/* ---------- selects ---------- */
function fillSelect(sel, opts) {
  var cur = sel.value;
  sel.innerHTML = opts.map(function (o) { return '<option value="' + o[0] + '">' + esc(o[1]) + '</option>'; }).join('');
  if (cur && opts.some(function (o) { return String(o[0]) === cur; })) sel.value = cur;
}
var DAYSUF = { fr: 'j', en: 'd', ar: 'يوم' };
function fillSelects() {
  var u = DAYSUF[S.lang] || 'j';
  fillSelect($('transport'), [['own_far', t('ownFar') + ' (+' + S.ownFar + ' ' + u + ')'], ['own_near', t('ownNear') + ' (+' + S.ownNear + ' ' + u + ')'], ['Réservation entreprise', t('compVehicle') + ' (+' + S.comp + ' ' + u + ')']]);
  fillSelect($('setTheme'), [['auto', t('themeAuto')], ['dark', t('themeDark')], ['light', t('themeLight')]]);
  fillSelect($('setWeek'), [['6', t('daySat')], ['0', t('daySun')], ['1', t('dayMon')]]);
  fillSelect($('setNotifDays'), [1, 2, 3, 5, 7].map(function (n) { return [n, t('notifDaysOpt', { n: n })]; }));
}
function syncSettingsUI() {
  $('setLang').value = S.lang; $('setTheme').value = S.theme; $('setWeek').value = String(S.weekStart);
  $('setWork').value = S.work; $('setRest').value = S.rest; $('setBonus').value = S.bonus;
  $('setOwnFar').value = S.ownFar; $('setOwnNear').value = S.ownNear; $('setComp').value = S.comp;
  $('setNotifOn').checked = !!S.notifOn; $('setNotifTime').value = S.notifTime; $('setNotifDays').value = String(S.notifDays);
}

/* ---------- language / theme ---------- */
function applyLang() {
  document.documentElement.lang = S.lang;
  document.documentElement.dir = S.lang === 'ar' ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i18n]').forEach(function (e) { e.textContent = t(e.getAttribute('data-i18n')); });
  document.querySelectorAll('[data-i18n-ph]').forEach(function (e) { e.placeholder = t(e.getAttribute('data-i18n-ph')); });
  fillSelects(); syncSettingsUI(); formMode(); renderNotifMsg();
}
function applyTheme() {
  var th = S.theme;
  if (th === 'auto') th = (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', th);
}

/* ---------- rendering ---------- */
function renderHome() {
  var hs = holidays(), all = rotations.map(function (r) { return calc(r, hs); }), cur = pick(all);
  if (!cur) {
    $('status').textContent = t('noRotation'); $('statusSub').textContent = t('addFirst');
    $('remaining').textContent = '—'; $('remainingSub').textContent = t('byPhase');
    $('phaseEnd').textContent = '—'; $('nextStart').textContent = '—';
    $('progressBar').style.width = '0%'; $('progressLabel').textContent = '0%';
    $('phaseTitle').textContent = t('progress'); $('progressSub').textContent = t('autoUpdate');
  } else {
    $('status').textContent = t(ST_LABEL[cur.status]);
    $('statusSub').textContent = t('cycleStarted', { d: fmt(cur.startDate) });
    $('remaining').textContent = cur.status === 'done' ? '0' : cur.remaining;
    $('remainingSub').textContent = t(ST_REM[cur.status]);
    $('phaseEnd').textContent = fmt(cur.phaseEnd); $('nextStart').textContent = fmt(cur.next);
    $('progressBar').style.width = cur.progress + '%'; $('progressLabel').textContent = cur.progress + '%';
    $('phaseTitle').textContent = t(ST_PH[cur.status]);
    $('progressSub').textContent = t('progressSub', { w: fmt(cur.endWork), r: fmt(cur.endRest), n: cur.worked.length });
  }
  var order = chrono(all), list = $('rotationList');
  if (!all.length) { list.innerHTML = '<div class="card empty">' + esc(t('noneSaved')) + '</div>'; return; }
  list.innerHTML = all.slice().sort(function (a, b) { return b.startDate - a.startDate; }).map(function (r) {
    var n = order.indexOf(r) + 1;
    return '<div class="card" style="margin-bottom:10px"><div class="rotation">' +
      '<div class="datebox"><small>' + esc(r.startDate.toLocaleDateString(loc(), { month: 'short' })) + '</small><b>' + String(r.startDate.getDate()).padStart(2, '0') + '</b><small>' + r.startDate.getFullYear() + '</small></div>' +
      '<div class="rotation-main"><div class="rotation-title"><span>' + esc(t('cycle', { n: n })) + '</span><span class="badge">' + esc(t(ST_LABEL[r.status])) + '</span></div>' +
      '<div class="rotation-meta">' + esc(t('workLine', { a: fmt(r.startDate), b: fmt(r.endWork) })) + '<br>' +
      esc(t('restLine', { a: fmt(r.endRest), b: fmt(r.next) })) + '<br>' +
      esc(t('restDays', { n: r.rest, base: S.rest, h: r.worked.length * S.bonus, r: r.route })) + '</div>' +
      (r.note ? '<div class="sub">' + esc(r.note) + '</div>' : '') +
      '<div class="rotation-actions"><button class="secondary" data-act="edit" data-id="' + esc(r.id) + '">' + esc(t('edit')) + '</button>' +
      '<button class="secondary" data-act="del" data-id="' + esc(r.id) + '">' + esc(t('del')) + '</button></div></div></div></div>';
  }).join('');
}

function phaseOf(all, dt) {
  var found = null;
  for (var i = 0; i < all.length; i++) {
    var r = all[i];
    if (dt >= r.startDate && dt <= r.endWork) return { type: 'work', r: r };
    if (!found && dt > r.endWork && dt <= r.endRest) found = { type: 'rest', r: r };
  }
  return found || { type: '', r: null };
}
var calState = { y: today().getFullYear(), m: today().getMonth() };
function renderCalendar() {
  var hs = holidays(), all = rotations.map(function (r) { return calc(r, hs); });
  var first = new Date(calState.y, calState.m, 1), dim = new Date(calState.y, calState.m + 1, 0).getDate();
  var offset = (first.getDay() - S.weekStart + 7) % 7;
  $('calTitle').textContent = first.toLocaleDateString(loc(), { month: 'long', year: 'numeric' });
  var html = '';
  for (var i = 0; i < 7; i++) {
    var wd = new Date(2023, 0, 1 + ((S.weekStart + i) % 7));
    html += '<div class="cal-dow">' + esc(wd.toLocaleDateString(loc(), { weekday: 'short' })) + '</div>';
  }
  for (var j = 0; j < offset; j++) html += '<div class="cal-cell empty-cell"></div>';
  var hset = {}; hs.forEach(function (h) { hset[h.date] = true; });
  var tk = iso(today());
  for (var d = 1; d <= dim; d++) {
    var dt = new Date(calState.y, calState.m, d), k = iso(dt), ph = phaseOf(all, dt);
    html += '<button class="cal-cell ' + ph.type + (hset[k] ? ' hol' : '') + (k === tk ? ' today' : '') + (k === calSel ? ' sel' : '') + '" data-d="' + k + '">' + d + '</button>';
  }
  $('calGrid').innerHTML = html;
  renderDayDetail(all, hs);
}
function renderDayDetail(all, hs) {
  var box = $('dayDetail');
  if (!calSel) { box.innerHTML = ''; return; }
  all = all || rotations.map(function (r) { return calc(r, holidays()); }); hs = hs || holidays();
  var dt = parse(calSel), ph = phaseOf(all, dt), lines = [];
  lines.push('<b>' + esc(dt.toLocaleDateString(loc(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })) + '</b>');
  if (ph.type) {
    lines.push(esc(t(ph.type === 'work' ? 'dayWork' : 'dayRest')) + ' · ' + esc(t('cycle', { n: chrono(all).indexOf(ph.r) + 1 })));
  } else lines.push(esc(t('dayNone')));
  hs.filter(function (h) { return h.date === calSel; }).forEach(function (h) { lines.push('<span class="dot"></span>' + esc(hName(h))); });
  box.innerHTML = lines.join('<br>');
}

var TYPE_COLOR = { national: '#f28c28', eid: '#16865c', islamic: '#3478c8', custom: '#a24fd8' };
function renderHolidays() {
  $('holIntro').textContent = t('holIntro', { n: S.bonus });
  var from = new Date().getFullYear() + '-01-01';
  $('holidayList').innerHTML = holidays().filter(function (h) { return h.date >= from; }).map(function (h) {
    var note = h.approx ? '<div class="sub">' + esc(t('approx')) + '</div>' : '';
    var mod = h.modified ? '<span class="badge mod">' + esc(t('modified')) + '</span>' : '';
    return '<div class="holiday-row"><span><i class="dot" style="background:' + (TYPE_COLOR[h.type] || '#f4511e') + '"></i>' + esc(hName(h)) + mod + note + '</span>' +
      '<span class="hr-right"><b>' + esc(fmt(parse(h.date))) + '</b><button class="icon-btn" data-h="' + esc(h.id) + '" aria-label="edit">✎</button></span></div>';
  }).join('');
}
function renderBackupInfo() {
  $('lastBackup').textContent = t('lastBackup', { d: S.lastBackup ? fmt(parse(S.lastBackup)) : t('never') });
  var old = !S.lastBackup || daysBetween(parse(S.lastBackup), today()) > 30;
  $('backupBanner').classList.toggle('hidden', !(rotations.length && old));
}
function renderNotifMsg() {
  $('notifMsg').textContent = notifState === 'denied' ? t('notifDenied') : (notifState === 'web' ? t('notifWeb') : '');
}
function renderAll() { renderHome(); renderCalendar(); renderHolidays(); renderBackupInfo(); }
function formMode() {
  $('formTitle').textContent = t(editingId ? 'editRotation' : 'addRotation');
  $('saveBtn').textContent = t(editingId ? 'updateRotation' : 'saveRotation');
  $('cancelEdit').classList.toggle('hidden', !editingId);
}

/* ---------- save + native sync ---------- */
function afterDataChange() { scheduleNotifications(); pushWidget(); }
function saveRotations() { store('gcbShiftRotations', rotations); renderAll(); afterDataChange(); }

function ensureNotifPermission() {
  var LN = plug('LocalNotifications');
  if (!LN) { notifState = 'web'; return Promise.resolve(false); }
  return LN.checkPermissions().then(function (p) {
    if (p.display === 'granted') return true;
    return LN.requestPermissions().then(function (r) { return r.display === 'granted'; });
  }).then(function (ok) { notifState = ok ? '' : 'denied'; return ok; }).catch(function () { notifState = 'denied'; return false; });
}
function scheduleNotifications() {
  var LN = plug('LocalNotifications');
  if (!LN) return Promise.resolve();
  return LN.getPending().then(function (p) {
    var ns = (p && p.notifications) || [];
    return ns.length ? LN.cancel({ notifications: ns.map(function (n) { return { id: n.id }; }) }) : null;
  }).then(function () {
    if (!S.notifOn) return null;
    return LN.checkPermissions().then(function (perm) {
      if (perm.display !== 'granted') return null;
      return LN.createChannel({ id: 'gcb-shift', name: 'GCB Shift', description: 'GCB Shift', importance: 4, visibility: 1 }).catch(function () {}).then(function () {
        var tm = (S.notifTime || '08:00').split(':').map(Number), hh = tm[0] || 0, mm = tm[1] || 0;
        var now = new Date(), list = [], id = 100, n = S.notifDays, hs = holidays();
        rotations.map(function (r) { return calc(r, hs); }).forEach(function (r) {
          [[r.startDate, 'ntStartIn', 'ntStartToday'], [r.endWork, 'ntWorkIn', 'ntWorkToday'], [r.next, 'ntNextIn', 'ntNextToday']].forEach(function (ev) {
            [[addDays(ev[0], -n), t(ev[1], { n: n })], [ev[0], t(ev[2])]].forEach(function (x) {
              var at = new Date(x[0].getFullYear(), x[0].getMonth(), x[0].getDate(), hh, mm, 0);
              if (at > now) list.push({ id: id++, title: 'GCB Shift', body: x[1], channelId: 'gcb-shift', schedule: { at: at, allowWhileIdle: true } });
            });
          });
        });
        list.push({ id: 1, title: 'GCB Shift', body: t('ntBackup'), channelId: 'gcb-shift', schedule: { on: { day: 1, hour: 10, minute: 0 }, allowWhileIdle: true } });
        return LN.schedule({ notifications: list.slice(0, 200) });
      });
    });
  }).catch(function () {});
}
function pushWidget() {
  var P = plug('Preferences');
  if (!P) return Promise.resolve();
  var hs = holidays();
  var data = { loc: loc(),
    labels: { upcoming: t('stUpcoming'), work: t('stWork'), rest: t('stRest'), done: t('stDone'), days: t('wDays'), until: t('wUntil'), open: t('wOpen') },
    rots: rotations.map(function (r) { return calc(r, hs); }).map(function (r) { return { s: iso(r.startDate), w: iso(r.endWork), e: iso(r.endRest) }; }) };
  return P.set({ key: 'widget_data', value: JSON.stringify(data) }).then(function () {
    var W = plug('GcbWidget'); return W ? W.refresh() : null;
  }).catch(function () {});
}

/* ---------- backup ---------- */
function doExport() {
  var payload = { app: 'GCB Shift', version: 2, rotations: rotations, settings: S, customHolidays: customH, holidayOverrides: hOv };
  var str = JSON.stringify(payload, null, 2), name = 'gcb-shift-backup-' + iso(today()) + '.json';
  var done = function () { S.lastBackup = iso(today()); saveSettings(); renderBackupInfo(); };
  if (NATIVE && plug('Filesystem') && plug('Share')) {
    return plug('Filesystem').writeFile({ path: name, data: str, directory: 'CACHE', encoding: 'utf8' }).then(function (r) {
      return plug('Share').share({ title: 'GCB Shift', text: name, files: [r.uri], dialogTitle: t('export') });
    }).then(done).catch(function (e) {
      if (!/cancel/i.test(String((e && e.message) || e))) alert(t('backupFail'));
    });
  }
  try {
    var blob = new Blob([str], { type: 'application/json' }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click(); URL.revokeObjectURL(a.href); done();
  } catch (e) { alert(t('backupFail')); }
  return Promise.resolve();
}
function doImport(file) {
  return file.text().then(function (txt) {
    var obj = JSON.parse(txt);
    if (!obj || !Array.isArray(obj.rotations)) throw new Error('bad');
    var rots = obj.rotations.filter(function (r) { return r && typeof r.start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.start); })
      .map(function (r) { return { id: r.id || uid(), start: r.start, transport: (!r.transport || r.transport === 'Propres Moyens') ? 'own_far' : r.transport, note: r.note || '' }; });
    if (!confirm(t('importConfirm'))) return;
    rotations = rots;
    if (obj.settings && typeof obj.settings === 'object') { S = Object.assign({}, DEF, obj.settings); if (S.own != null) { if (obj.settings.ownFar == null) S.ownFar = parseInt(S.own, 10) || DEF.ownFar; delete S.own; } }
    if (Array.isArray(obj.customHolidays)) customH = obj.customHolidays;
    if (obj.holidayOverrides && typeof obj.holidayOverrides === 'object') hOv = obj.holidayOverrides;
    store('gcbShiftCustomHolidays', customH); store('gcbShiftHolidayOverrides', hOv); saveSettings();
    applyTheme(); applyLang(); saveRotations();
  }).catch(function () { alert(t('importBad')); });
}

/* ---------- holiday modal ---------- */
function openHol(id) {
  holEditId = id; var h = id ? holidays().filter(function (x) { return x.id === id; })[0] : null;
  $('holModalTitle').textContent = t(h ? 'holEditTitle' : 'holNewTitle');
  $('holNameWrap').classList.toggle('hidden', !!(h && !h.custom));
  $('holName').value = h && h.custom ? h.name : '';
  $('holDate').value = h ? h.date : iso(today());
  $('holModalNote').textContent = h && !h.custom ? hName(h) + (h.approx ? ' · ' + t('approx') : '') : '';
  $('holReset').classList.toggle('hidden', !(h && h.modified));
  $('holDelete').classList.toggle('hidden', !(h && h.custom));
  $('holModal').classList.remove('hidden');
}
function closeHol() { $('holModal').classList.add('hidden'); holEditId = null; }
function saveHol() {
  var date = $('holDate').value; if (!date) return;
  if (!holEditId) {
    var nm = $('holName').value.trim(); if (!nm) return;
    customH.push({ id: 'c:' + uid(), name: nm, date: date });
  } else {
    var c = customH.filter(function (x) { return x.id === holEditId; })[0];
    if (c) { var nn = $('holName').value.trim(); if (!nn) return; c.name = nn; c.date = date; }
    else {
      var b = (window.GCB_HOLIDAYS || []).filter(function (x) { return x.id === holEditId; })[0];
      if (b) { if (date === b.date) delete hOv[holEditId]; else hOv[holEditId] = date; }
    }
  }
  store('gcbShiftCustomHolidays', customH); store('gcbShiftHolidayOverrides', hOv);
  closeHol(); renderAll(); afterDataChange();
}

/* ---------- events ---------- */
function setup() {
  $('rotationForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var start = $('startDate').value; if (!start) return;
    var item = { start: start, transport: $('transport').value, note: $('note').value.trim() };
    if (editingId) { rotations = rotations.map(function (r) { return r.id === editingId ? Object.assign({}, r, item) : r; }); }
    else rotations.push(Object.assign({ id: uid() }, item));
    editingId = null; $('note').value = ''; formMode(); saveRotations();
  });
  $('cancelEdit').addEventListener('click', function () { editingId = null; $('note').value = ''; $('startDate').value = iso(today()); formMode(); });
  $('rotationList').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-act]'); if (!b) return;
    var id = b.getAttribute('data-id');
    if (b.getAttribute('data-act') === 'del') {
      if (confirm(t('confirmDel'))) { rotations = rotations.filter(function (r) { return r.id !== id; }); if (editingId === id) { editingId = null; formMode(); } saveRotations(); }
    } else {
      var r = rotations.filter(function (x) { return x.id === id; })[0]; if (!r) return;
      editingId = id; $('startDate').value = r.start; $('transport').value = r.transport; $('note').value = r.note || '';
      formMode(); $('formTitle').scrollIntoView({ behavior: 'smooth' });
    }
  });
  var pages = ['dashboard', 'calendarPage', 'holidays', 'settingsPage'];
  document.querySelectorAll('nav button').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('nav button').forEach(function (x) { x.classList.toggle('active', x === b); });
      pages.forEach(function (p) { $(p).classList.toggle('hidden', p !== b.getAttribute('data-page')); });
      if (b.getAttribute('data-page') === 'calendarPage') renderCalendar();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
  $('calPrev').addEventListener('click', function () { calState.m--; if (calState.m < 0) { calState.m = 11; calState.y--; } renderCalendar(); });
  $('calNext').addEventListener('click', function () { calState.m++; if (calState.m > 11) { calState.m = 0; calState.y++; } renderCalendar(); });
  $('calGrid').addEventListener('click', function (e) {
    var c = e.target.closest('button[data-d]'); if (!c) return; calSel = c.getAttribute('data-d'); renderCalendar();
  });
  $('holidayList').addEventListener('click', function (e) { var b = e.target.closest('button[data-h]'); if (b) openHol(b.getAttribute('data-h')); });
  $('addHolBtn').addEventListener('click', function () { openHol(null); });
  $('holCancel').addEventListener('click', closeHol);
  $('holSave').addEventListener('click', saveHol);
  $('holReset').addEventListener('click', function () { delete hOv[holEditId]; store('gcbShiftHolidayOverrides', hOv); closeHol(); renderAll(); afterDataChange(); });
  $('holDelete').addEventListener('click', function () {
    if (!confirm(t('delHol'))) return;
    customH = customH.filter(function (x) { return x.id !== holEditId; }); store('gcbShiftCustomHolidays', customH); closeHol(); renderAll(); afterDataChange();
  });
  $('holModal').addEventListener('click', function (e) { if (e.target === $('holModal')) closeHol(); });

  $('setLang').addEventListener('change', function (e) { S.lang = e.target.value; saveSettings(); applyLang(); renderAll(); pushWidget(); scheduleNotifications(); });
  $('setTheme').addEventListener('change', function (e) { S.theme = e.target.value; saveSettings(); applyTheme(); });
  $('setWeek').addEventListener('change', function (e) { S.weekStart = parseInt(e.target.value, 10); saveSettings(); renderCalendar(); });
  [['setWork', 'work', 1, 365], ['setRest', 'rest', 0, 365], ['setBonus', 'bonus', 0, 30], ['setOwnFar', 'ownFar', 0, 30], ['setOwnNear', 'ownNear', 0, 30], ['setComp', 'comp', 0, 30]].forEach(function (c) {
    $(c[0]).addEventListener('change', function () {
      var v = parseInt($(c[0]).value, 10); if (isNaN(v)) v = DEF[c[1]];
      v = Math.max(c[2], Math.min(c[3], v)); S[c[1]] = v; $(c[0]).value = v; saveSettings(); fillSelects(); syncSettingsUI(); renderAll(); afterDataChange();
    });
  });
  $('setNotifOn').addEventListener('change', function (e) {
    var on = e.target.checked;
    if (!on) { S.notifOn = false; saveSettings(); notifState = ''; renderNotifMsg(); scheduleNotifications(); return; }
    ensureNotifPermission().then(function (ok) {
      S.notifOn = ok; saveSettings(); $('setNotifOn').checked = ok; renderNotifMsg(); scheduleNotifications();
    });
  });
  $('setNotifTime').addEventListener('change', function (e) { if (e.target.value) { S.notifTime = e.target.value; saveSettings(); scheduleNotifications(); } });
  $('setNotifDays').addEventListener('change', function (e) { S.notifDays = parseInt(e.target.value, 10); saveSettings(); scheduleNotifications(); });

  $('exportBtn').addEventListener('click', doExport);
  $('bannerBackup').addEventListener('click', doExport);
  $('importBtn').addEventListener('click', function () { $('importFile').click(); });
  $('importFile').addEventListener('change', function (e) { var f = e.target.files && e.target.files[0]; if (f) doImport(f); e.target.value = ''; });
  $('clearBtn').addEventListener('click', function () {
    if (confirm(t('resetConfirm'))) { rotations = []; editingId = null; formMode(); saveRotations(); }
  });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { renderAll(); pushWidget(); } });
  if (window.matchMedia) {
    var mq = matchMedia('(prefers-color-scheme: light)');
    var onMq = function () { if (S.theme === 'auto') applyTheme(); };
    if (mq.addEventListener) mq.addEventListener('change', onMq);
  }
}

/* ---------- init ---------- */
function init() {
  setup(); applyTheme(); applyLang();
  $('startDate').value = iso(today());
  renderAll();
  if (NATIVE) {
    var SB = plug('StatusBar');
    if (SB) { SB.setBackgroundColor({ color: '#f4511e' }).catch(function () {}); SB.setStyle({ style: 'LIGHT' }).catch(function () {}); }
    afterDataChange();
  }
  if ('serviceWorker' in navigator) {
    if (NATIVE) {
      navigator.serviceWorker.getRegistrations().then(function (rs) { rs.forEach(function (r) { r.unregister(); }); }).catch(function () {});
      if (window.caches) caches.keys().then(function (ks) { ks.forEach(function (k) { caches.delete(k); }); }).catch(function () {});
    } else if (location.protocol.indexOf('http') === 0) {
      navigator.serviceWorker.register('./sw.js').catch(function () {});
    }
  }
}
init();
})();
