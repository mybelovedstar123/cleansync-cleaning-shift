'use strict';
// 宿泊予約連動 清掃シフト自動化システム — HTTP サーバー（依存パッケージなし / Node.js 18+）

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

loadDotEnv();

const store = require('./src/db');
const d = require('./src/dates');
const engine = require('./src/engine/assign');
const wf = require('./src/services/workflow');
const line = require('./src/integrations/line');
const airhost = require('./src/integrations/airhost');
const sheets = require('./src/integrations/sheets');
const { parseReservationEmail } = require('./src/integrations/emailParser');
const { logEvent } = require('./src/events');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');

function loadDotEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// ---------------------------------------------------------------------------
// ルーター
// ---------------------------------------------------------------------------

const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler, ...opts });
}

function send(res, status, body, headers = {}) {
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isStr ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) {
        reject(Object.assign(new Error('リクエストが大きすぎます'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function requireSecret(req, envName) {
  const secret = process.env[envName];
  if (!secret) return; // 未設定ならデモ用に許可
  if (req.headers['x-webhook-secret'] !== secret) throw Object.assign(new Error('認証に失敗しました'), { status: 401 });
}

function checkAdminAuth(req) {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [, pass] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  return pass === pw;
}

// ---------------------------------------------------------------------------
// 表示用の整形
// ---------------------------------------------------------------------------

function enrichCleaning(db, c) {
  const p = engine.propertyById(db, c.propertyId);
  const s = c.staffId ? engine.staffById(db, c.staffId) : null;
  const r = db.reservations.find((x) => x.id === c.reservationId);
  const u = c.urgentRequestId ? db.urgentRequests.find((x) => x.id === c.urgentRequestId) : null;
  return {
    ...c,
    history: undefined,
    propertyName: p ? p.name : '',
    propertyColor: p ? p.color : '#888',
    staffName: s ? s.name : '',
    reservation: r ? { id: r.id, code: r.code, guestName: r.guestName, guests: r.guests, checkIn: r.checkIn, checkOut: r.checkOut, channel: r.channel, status: r.status } : null,
    urgent: u ? { id: u.id, status: u.status, deadline: u.deadline } : null,
  };
}

function enrichReservation(db, r) {
  const p = engine.propertyById(db, r.propertyId);
  const c = db.cleanings.find((x) => x.id === r.cleaningId);
  return {
    ...r,
    propertyName: p ? p.name : '',
    propertyColor: p ? p.color : '#888',
    cleaning: c ? { id: c.id, date: c.date, status: c.status, staffName: c.staffId ? engine.staffById(db, c.staffId).name : '', mode: c.mode, exception: c.exception } : null,
  };
}

function enrichUrgent(db, u) {
  const c = db.cleanings.find((x) => x.id === u.cleaningId);
  return {
    ...u,
    cleaning: c ? enrichCleaning(db, c) : null,
    candidates: u.candidates.map((x) => ({ ...x, name: engine.staffById(db, x.staffId)?.name || '' })),
    filledByName: u.filledBy ? engine.staffById(db, u.filledBy)?.name : '',
  };
}

function staffView(db, s, month) {
  const load = engine.monthLoad(db, s.id, month);
  return {
    ...s,
    month,
    monthHours: load.hours,
    monthCount: load.count,
    availableDays: engine.availableDays(s, month),
    submittedAt: (db.submissions[month] || {})[s.id] || null,
  };
}

function matchProperty(db, nameOrListing) {
  if (!nameOrListing) return null;
  const q = String(nameOrListing).normalize('NFKC').replace(/\s+/g, '');
  return (
    db.properties.find((p) => p.airhostListingId === nameOrListing || p.id === nameOrListing) ||
    db.properties.find((p) => p.name.replace(/\s+/g, '') === q) ||
    db.properties.find((p) => q.includes(p.name.replace(/\s+/g, '')) || p.name.replace(/\s+/g, '').includes(q)) ||
    db.properties.find((p) => q.includes(p.area))
  );
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

route('GET', '/api/bootstrap', ({ db }) => {
  const today = d.jstDate();
  return {
    today,
    month: d.monthOf(today),
    now: new Date().toISOString(),
    settings: wf.settings(db),
    properties: db.properties,
    staff: db.staff.map((s) => ({ id: s.id, name: s.name, properties: s.properties, active: s.active })),
    admins: db.admins,
    publishedMonths: db.publishedMonths,
    draftMonths: db.draftMonths,
    integrations: { airhostMode: airhost.mode(), lineLive: line.isLive(), sheetsLive: Boolean(process.env.GOOGLE_SHEETS_WEBHOOK_URL) },
  };
});

route('GET', '/api/dashboard', ({ db }) => {
  const today = d.jstDate();
  const tomorrow = d.addDays(today, 1);
  const month = d.monthOf(today);
  const monthCleanings = db.cleanings.filter((c) => d.monthOf(c.date) === month && c.status !== 'cancelled');
  const upcoming = db.cleanings
    .filter((c) => c.date >= today && c.date <= d.addDays(today, 6) && c.status !== 'cancelled')
    .sort((a, b) => (a.date + a.startTime < b.date + b.startTime ? -1 : 1));
  const fairness = engine.computeFairness(db, month);
  const synced = db.cleanings.filter((c) => c.status === 'assigned' && c.airhost?.synced).length;
  const assignedTotal = db.cleanings.filter((c) => c.status === 'assigned').length;
  return {
    today,
    tomorrow,
    kpi: {
      monthCleanings: monthCleanings.length,
      monthHours: engine.round2(monthCleanings.reduce((a, c) => a + c.hours, 0)),
      needsAction: db.cleanings.filter((c) => c.date >= today && ['unassigned', 'recruiting'].includes(c.status)).length,
      urgentOpen: db.urgentRequests.filter((u) => ['open', 'escalated'].includes(u.status)).length,
      fairnessScore: fairness.score,
      airhostSyncRate: assignedTotal ? Math.round((synced / assignedTotal) * 100) : 100,
      newReservations7d: db.reservations.filter((r) => Date.now() - new Date(r.createdAt).getTime() < 7 * 86400000).length,
    },
    upcoming: upcoming.map((c) => enrichCleaning(db, c)),
    conflicts: wf.conflicts(db).map((c) => enrichCleaning(db, c)),
    urgent: db.urgentRequests.filter((u) => ['open', 'escalated'].includes(u.status)).map((u) => enrichUrgent(db, u)),
    events: db.events.slice(0, 14),
    fairness,
  };
});

// 予約
route('GET', '/api/reservations', ({ db, query }) => {
  let list = db.reservations;
  if (query.month) list = list.filter((r) => d.monthOf(r.checkOut) === query.month || d.monthOf(r.checkIn) === query.month);
  if (query.propertyId) list = list.filter((r) => r.propertyId === query.propertyId);
  if (query.status) list = list.filter((r) => r.status === query.status);
  if (query.q) {
    const q = query.q.trim();
    list = list.filter((r) => r.guestName.includes(q) || r.code.includes(q));
  }
  return [...list].sort((a, b) => (a.checkIn < b.checkIn ? -1 : 1)).map((r) => enrichReservation(db, r));
});

route('GET', '/api/reservations/:id', ({ db, params }) => {
  const r = wf.findReservation(db, params.id);
  const c = db.cleanings.find((x) => x.id === r.cleaningId);
  return { ...enrichReservation(db, r), cleaningDetail: c ? { ...enrichCleaning(db, c), history: c.history } : null };
});

route('POST', '/api/reservations', ({ db, body }) => {
  const out = wf.createReservation(db, body, { source: body.source === 'email' ? 'email' : body.source === 'airhost_api' ? 'airhost_api' : 'manual' });
  return { reservation: enrichReservation(db, out.reservation), cleaning: enrichCleaning(db, out.cleaning), result: out.result };
});

route('PATCH', '/api/reservations/:id', ({ db, params, body }) => {
  const out = wf.updateReservation(db, params.id, body);
  return { reservation: enrichReservation(db, out.reservation), result: out.result };
});

route('POST', '/api/reservations/:id/cancel', ({ db, params }) => {
  const out = wf.cancelReservation(db, params.id);
  return { reservation: enrichReservation(db, out.reservation), result: out.result };
});

// 清掃
route('GET', '/api/cleanings', ({ db, query }) => {
  let list = db.cleanings;
  if (query.month) list = list.filter((c) => d.monthOf(c.date) === query.month);
  if (query.staffId) list = list.filter((c) => c.staffId === query.staffId);
  if (!query.includeCancelled) list = list.filter((c) => c.status !== 'cancelled');
  return [...list].sort((a, b) => (a.date < b.date ? -1 : 1)).map((c) => enrichCleaning(db, c));
});

route('GET', '/api/cleanings/:id', ({ db, params }) => {
  const c = db.cleanings.find((x) => x.id === params.id);
  if (!c) throw Object.assign(new Error('清掃予定が見つかりません'), { status: 404 });
  return {
    ...enrichCleaning(db, c),
    history: c.history,
    candidates: engine.evaluateCandidates(db, c, { allowDouble: true }),
  };
});

route('POST', '/api/cleanings/:id/assign', ({ db, params, body }) => {
  const out = wf.manualAssign(db, params.id, body.staffId, { force: Boolean(body.force) });
  return enrichCleaning(db, out.cleaning);
});

route('POST', '/api/cleanings/:id/reassign', ({ db, params }) => {
  const result = wf.reassign(db, params.id);
  return { result, cleaning: enrichCleaning(db, db.cleanings.find((x) => x.id === params.id)) };
});

// 緊急募集
route('GET', '/api/urgent', ({ db }) => db.urgentRequests.map((u) => enrichUrgent(db, u)));

route('POST', '/api/urgent/:id/respond', ({ db, params, body }) => {
  const u = db.urgentRequests.find((x) => x.id === params.id);
  if (!u) throw Object.assign(new Error('緊急募集が見つかりません'), { status: 404 });
  const cand = u.candidates.find((c) => c.staffId === body.staffId);
  if (!cand) throw Object.assign(new Error('このスタッフは募集対象外です'), { status: 400 });
  return wf.respondUrgent(db, cand.token, body.answer === 'accept' ? 'accept' : 'decline');
});

route('POST', '/api/urgent/:id/escalate', ({ db, params }) => enrichUrgent(db, wf.escalateUrgent(db, params.id)));

// スタッフ回答ページ（LINE のリンク先）
route(
  'GET',
  '/api/respond/:token',
  ({ db, params }) => {
    const found = wf.findByToken(db, params.token);
    if (!found) throw Object.assign(new Error('回答リンクが無効です'), { status: 404 });
    const { req, cand } = found;
    const c = db.cleanings.find((x) => x.id === req.cleaningId);
    const p = engine.propertyById(db, req.propertyId);
    return {
      staffName: engine.staffById(db, cand.staffId)?.name,
      status: req.status,
      myResponse: cand.response,
      isMine: req.filledBy === cand.staffId,
      filledByName: req.filledBy ? engine.staffById(db, req.filledBy)?.name : '',
      deadline: req.deadline,
      cleaning: { date: c.date, dateLabel: d.formatJa(c.date), startTime: c.startTime, endTime: c.endTime, hours: c.hours },
      property: { name: p.name, address: p.address, image: p.image, checkinTime: p.checkinTime },
      exception: cand.exception,
    };
  },
  { public: true }
);

route('POST', '/api/respond/:token', ({ db, params, body }) => wf.respondUrgent(db, params.token, body.answer === 'accept' ? 'accept' : 'decline'), { public: true });

// スタッフ
route('GET', '/api/staff', ({ db, query }) => {
  const month = query.month || d.monthOf(d.jstDate());
  return db.staff.map((s) => staffView(db, s, month));
});

route('POST', '/api/staff', ({ db, body }) => {
  if (!body.name) throw Object.assign(new Error('氏名を入力してください'), { status: 400 });
  const s = {
    id: `st${String(db.staff.length + 1).padStart(2, '0')}_${Date.now().toString(36).slice(-3)}`,
    name: String(body.name).trim(),
    properties: Array.isArray(body.properties) ? body.properties : [],
    active: body.active !== false,
    lineUserId: body.lineUserId || '',
    lineLinked: Boolean(body.lineUserId),
    phone: body.phone || '',
    note: body.note || '',
    unavailable: [],
  };
  db.staff.push(s);
  logEvent(db, { type: 'staff', message: `スタッフ登録：${s.name}` });
  return s;
});

route('PATCH', '/api/staff/:id', ({ db, params, body }) => {
  const s = engine.staffById(db, params.id);
  if (!s) throw Object.assign(new Error('スタッフが見つかりません'), { status: 404 });
  for (const k of ['name', 'properties', 'active', 'lineUserId', 'phone', 'note']) if (body[k] !== undefined) s[k] = body[k];
  s.lineLinked = Boolean(s.lineUserId);
  return s;
});

route('PUT', '/api/staff/:id/unavailable', ({ db, params, body }) => wf.submitUnavailability(db, params.id, body.month, body.dates));

// 勤務不可日の提出フォーム（スタッフ用・Google フォームの置き換え）
route(
  'GET',
  '/api/availability/:month',
  ({ db, params }) => ({
    month: params.month,
    deadline: `${d.addMonths(params.month, -1)}-20`,
    published: wf.isPublished(db, params.month),
    staff: db.staff.filter((s) => s.active).map((s) => ({ id: s.id, name: s.name, dates: (s.unavailable || []).filter((x) => x.startsWith(params.month)), submittedAt: (db.submissions[params.month] || {})[s.id] || null })),
  }),
  { public: true }
);
route('POST', '/api/availability', ({ db, body }) => wf.submitUnavailability(db, body.staffId, body.month, body.dates), { public: true });

// 施設
route('GET', '/api/properties', ({ db }) => {
  const month = d.monthOf(d.jstDate());
  return db.properties.map((p) => {
    const cl = db.cleanings.filter((c) => c.propertyId === p.id && d.monthOf(c.date) === month && c.status !== 'cancelled');
    return { ...p, restraintHours: engine.restraintHours(p), monthCleanings: cl.length, staffCount: db.staff.filter((s) => s.active && s.properties.includes(p.id)).length };
  });
});

route('POST', '/api/properties', ({ db, body }) => {
  if (!body.name) throw Object.assign(new Error('施設名を入力してください'), { status: 400 });
  const palette = ['#0ea5e9', '#14b8a6', '#f97316', '#e11d48', '#6366f1', '#84cc16'];
  const p = {
    id: `p${db.properties.length + 1}_${Date.now().toString(36).slice(-3)}`,
    name: String(body.name).trim(),
    area: body.area || '',
    address: body.address || '',
    capacity: Number(body.capacity) || 6,
    cleaningHours: Number(body.cleaningHours) || 3,
    travelHours: Number(body.travelHours) || 0.5,
    checkoutTime: body.checkoutTime || '10:00',
    checkinTime: body.checkinTime || '16:00',
    airhostListingId: body.airhostListingId || '',
    image: (db.spareImages || []).shift() || '', // 未使用画像を割当（重複させない）
    color: palette[db.properties.length % palette.length],
    active: true,
  };
  db.properties.push(p);
  logEvent(db, { type: 'property', message: `施設を追加：${p.name}` });
  return p;
});

route('PATCH', '/api/properties/:id', ({ db, params, body }) => {
  const p = engine.propertyById(db, params.id);
  if (!p) throw Object.assign(new Error('施設が見つかりません'), { status: 404 });
  for (const k of ['name', 'area', 'address', 'capacity', 'cleaningHours', 'travelHours', 'checkoutTime', 'checkinTime', 'airhostListingId', 'active']) {
    if (body[k] !== undefined) p[k] = ['capacity', 'cleaningHours', 'travelHours'].includes(k) ? Number(body[k]) : body[k];
  }
  return p;
});

// 公平性
route('GET', '/api/fairness', ({ db, query }) => engine.computeFairness(db, query.month || d.monthOf(d.jstDate())));
route('POST', '/api/fairness/sync', ({ db, body }) => sheets.sync(db, body.month || d.monthOf(d.jstDate()), '手動同期'));
route('GET', '/api/fairness/sync-log', ({ db }) => db.sheetSync.slice(0, 50));

// 月次シフト
route('GET', '/api/monthly/:month', ({ db, params }) => {
  const month = params.month;
  const cl = db.cleanings.filter((c) => d.monthOf(c.date) === month && c.status !== 'cancelled');
  const by = (st) => cl.filter((c) => c.status === st).length;
  return {
    month,
    published: wf.isPublished(db, month),
    draft: db.draftMonths.includes(month),
    deadline: `${d.addMonths(month, -1)}-20`,
    counts: { total: cl.length, awaiting: by('awaiting_monthly'), draft: by('draft'), assigned: by('assigned') + by('completed'), unassigned: by('unassigned'), recruiting: by('recruiting') },
    submissions: db.staff.filter((s) => s.active).map((s) => ({ staffId: s.id, name: s.name, submittedAt: (db.submissions[month] || {})[s.id] || null, days: (s.unavailable || []).filter((x) => x.startsWith(month)).length })),
    fairness: engine.computeFairness(db, month),
  };
});
route('POST', '/api/monthly/:month/generate', ({ db, params }) => wf.generateMonth(db, params.month));
route('POST', '/api/monthly/:month/publish', ({ db, params }) => wf.publishMonth(db, params.month));

// 通知・ログ
route('GET', '/api/notifications', ({ db, query }) => {
  let list = db.notifications;
  if (query.to === 'group') list = list.filter((n) => n.to.type === 'group');
  else if (query.to === 'admins') list = list.filter((n) => n.to.type === 'admins');
  else if (query.to) list = list.filter((n) => n.to.staffId === query.to);
  return list.slice(0, Number(query.limit) || 100).map((n) => ({ ...n, toName: n.to.type === 'staff' ? engine.staffById(db, n.to.staffId)?.name : n.to.type === 'group' ? '清掃スタッフ グループ' : '管理者' }));
});
route('GET', '/api/events', ({ db, query }) => db.events.slice(0, Number(query.limit) || 100));
route('GET', '/api/airhost/log', ({ db }) => db.airhostSync.slice(0, 200));

// 設定
route('PATCH', '/api/settings', ({ db, body }) => {
  const allowed = ['urgentThresholdDays', 'responseWindowMinutes', 'allowDoubleFallback'];
  for (const k of allowed) if (body[k] !== undefined) db.settings[k] = typeof body[k] === 'boolean' ? body[k] : Number(body[k]);
  return wf.settings(db);
});

// メール解析プレビュー
route('POST', '/api/email/parse', ({ db, body }) => {
  const parsed = parseReservationEmail(body, { year: Number(d.jstDate().slice(0, 4)) });
  const p = matchProperty(db, parsed.propertyName);
  return { ...parsed, matchedProperty: p ? { id: p.id, name: p.name } : null };
});

// ---------------------------------------------------------------------------
// Webhook（外部システム → 本システム）
// ---------------------------------------------------------------------------

function applyExternal(db, type, data, source) {
  if (type === 'cancelled') return wf.cancelReservation(db, data.code, { source });
  if (type === 'updated') {
    const changes = {};
    if (data.propertyId) changes.propertyId = data.propertyId;
    for (const k of ['checkIn', 'checkOut', 'guests', 'guestName']) if (data[k]) changes[k] = data[k];
    return wf.updateReservation(db, data.code, changes, { source });
  }
  return wf.createReservation(db, data, { source });
}

route(
  'POST',
  '/api/webhooks/airhost',
  ({ db, body, req }) => {
    requireSecret(req, 'AIRHOST_WEBHOOK_SECRET');
    const ev = String(body.event || '');
    const data = body.data || body.reservation || {};
    const p = matchProperty(db, data.listingId || data.propertyId || data.propertyName);
    if (!p && !ev.endsWith('cancelled')) throw Object.assign(new Error('施設を特定できません（listingId / propertyName を確認してください）'), { status: 422 });
    const type = ev.endsWith('cancelled') ? 'cancelled' : ev.endsWith('updated') ? 'updated' : 'created';
    const out = applyExternal(db, type, { ...data, propertyId: p ? p.id : undefined }, 'airhost_api');
    return { ok: true, type, reservationId: out.reservation.id, result: out.result };
  },
  { public: true }
);

route(
  'POST',
  '/api/webhooks/email',
  ({ db, body, req }) => {
    requireSecret(req, 'EMAIL_WEBHOOK_SECRET');
    const parsed = parseReservationEmail(body, { year: Number(d.jstDate().slice(0, 4)) });
    const p = matchProperty(db, parsed.propertyName);
    if (!parsed.ok || (!p && parsed.type !== 'cancelled')) {
      logEvent(db, { type: 'email_error', level: 'danger', message: `予約メールを解析できませんでした（${parsed.missing.join(', ') || '施設名不一致'}）件名: ${String(body.subject || '').slice(0, 40)}` });
      line.send(db, { to: { type: 'admins' }, category: 'admin', title: '【要確認】予約メールの自動取込に失敗しました', text: `件名: ${body.subject || ''}\n不足項目: ${parsed.missing.join(', ') || '施設名が一致しません'}` });
      throw Object.assign(new Error('メールの解析に失敗しました'), { status: 422, detail: parsed });
    }
    const data = {
      code: parsed.reservationCode,
      propertyId: p ? p.id : undefined,
      guestName: parsed.guestName,
      guests: parsed.guests,
      checkIn: parsed.checkIn,
      checkOut: parsed.checkOut,
      channel: parsed.channel || 'Airbnb',
      bookedAt: parsed.bookedAt ? d.jstToIso(parsed.bookedAt.date, parsed.bookedAt.time) : undefined,
    };
    const out = applyExternal(db, parsed.type, data, 'email');
    return { ok: true, parsed, reservation: enrichReservation(db, out.reservation), result: out.result };
  },
  { public: true }
);

route(
  'POST',
  '/api/webhooks/line',
  ({ db, body, raw, req }) => {
    if (!line.verifySignature(raw, req.headers['x-line-signature'])) throw Object.assign(new Error('署名が不正です'), { status: 401 });
    const results = [];
    for (const ev of body.events || []) {
      if (ev.type !== 'postback') continue;
      const q = new URLSearchParams(ev.postback.data);
      if (q.get('action') !== 'urgent') continue;
      const found = wf.findByToken(db, q.get('token'));
      if (!found) continue;
      const staff = engine.staffById(db, found.cand.staffId);
      if (staff.lineUserId !== ev.source.userId) continue; // 本人以外の押下は無視
      const out = wf.respondUrgent(db, q.get('token'), q.get('answer') === 'accept' ? 'accept' : 'decline');
      const msg = {
        filled: 'ありがとうございます！担当が確定しました。',
        already_filled: `ありがとうございます。今回は ${out.filledByName} さんに決定しました。`,
        declined: '回答を受け付けました。',
        closed: 'この募集は終了しました。',
        not_eligible: '同日に別の清掃があるため、今回は確定できませんでした。',
      }[out.result];
      if (out.result !== 'filled') line.send(db, { to: { type: 'staff', staffId: staff.id }, category: 'info', title: '緊急募集', text: msg });
      results.push(out.result);
    }
    return { ok: true, results };
  },
  { public: true }
);

// RPA ワーカー（scripts/airhost-rpa-worker.js）用
route('GET', '/api/airhost/jobs/pending', ({ db, req }) => (requireSecret(req, 'AIRHOST_WORKER_SECRET'), airhost.pendingJobs(db)), { public: true });
route('POST', '/api/airhost/jobs/:id/complete', ({ db, params, body, req }) => (requireSecret(req, 'AIRHOST_WORKER_SECRET'), airhost.completeJob(db, params.id, body.ok, body.error)), { public: true });

// デモ操作
route('POST', '/api/demo/reset', () => {
  store.reset();
  return { ok: true };
});
route('POST', '/api/demo/tick', ({ db }) => ({ escalated: wf.checkTimeouts(db) }));

// ---------------------------------------------------------------------------
// 静的ファイル
// ---------------------------------------------------------------------------

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };

function serveStatic(req, res, pathname) {
  let file = pathname;
  if (file === '/' || file === '') file = '/index.html';
  else if (file.startsWith('/r/')) file = '/respond.html';
  else if (file === '/availability') file = '/availability.html';
  const full = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(file)));
  if (!full.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not Found');
    const ext = path.extname(full);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.jpg' ? 'public, max-age=604800' : 'no-cache' });
    fs.createReadStream(full).pipe(res);
  });
}

// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  try {
    if (!pathname.startsWith('/api/')) {
      const isPublicPage = pathname.startsWith('/r/') || pathname.startsWith('/availability') || pathname.startsWith('/img/') || pathname.startsWith('/css/') || pathname.startsWith('/js/') || pathname === '/respond.html';
      if (!isPublicPage && !checkAdminAuth(req)) return send(res, 401, '認証が必要です', { 'WWW-Authenticate': 'Basic realm="admin"' });
      return serveStatic(req, res, pathname);
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.re);
      if (!m) continue;
      if (!r.public && !checkAdminAuth(req)) return send(res, 401, { error: '認証が必要です' }, { 'WWW-Authenticate': 'Basic realm="admin"' });
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const raw = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : Buffer.alloc(0);
      let body = {};
      if (raw.length) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          return send(res, 400, { error: 'JSON の形式が正しくありません' });
        }
      }
      const db = store.load();
      const result = await r.handler({ db, params, query: Object.fromEntries(url.searchParams), body, raw, req });
      store.save();
      return send(res, 200, result === undefined ? { ok: true } : result);
    }
    if (pathname === '/api/fairness.csv') {
      if (!checkAdminAuth(req)) return send(res, 401, { error: '認証が必要です' }, { 'WWW-Authenticate': 'Basic realm="admin"' });
      const db = store.load();
      const month = url.searchParams.get('month') || d.monthOf(d.jstDate());
      return send(res, 200, sheets.toCsv(engine.computeFairness(db, month)), {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="fairness-${month}.csv"`,
      });
    }
    return send(res, 404, { error: 'Not Found' });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    store.save();
    return send(res, status, { error: e.message || 'サーバーエラー', detail: e.detail });
  }
});

// 緊急募集の回答期限チェック（30 秒ごと）
setInterval(() => {
  try {
    const db = store.load();
    if (wf.checkTimeouts(db) > 0) store.save();
  } catch (e) {
    console.error('timeout check failed', e);
  }
}, 30000).unref();

if (require.main === module) {
  store.load();
  server.listen(PORT, () => {
    console.log(`\n  清掃シフト自動化システム  http://localhost:${PORT}`);
    console.log(`  AirHost 連携: ${airhost.mode()} / LINE: ${line.isLive() ? 'live' : 'mock'}\n`);
  });
}

module.exports = { server };
