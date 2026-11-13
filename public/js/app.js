'use strict';
/* CleanSync 管理画面（Vanilla JS SPA） */

// ===========================================================================
// ユーティリティ
// ===========================================================================
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const TZ = 'Asia/Tokyo';
const WD = '日月火水木金土';

function ymdParts(ymd) {
  return ymd.split('-').map(Number);
}
function weekdayIdx(ymd) {
  const [y, m, d] = ymdParts(ymd);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function fmtDate(ymd) {
  if (!ymd) return '';
  const [, m, d] = ymdParts(ymd);
  return `${m}/${d}(${WD[weekdayIdx(ymd)]})`;
}
function fmtDateLong(ymd) {
  const [y, m, d] = ymdParts(ymd);
  return `${y}年${m}月${d}日(${WD[weekdayIdx(ymd)]})`;
}
function fmtDT(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('ja-JP', { timeZone: TZ, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('ja-JP', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
}
function addDays(ymd, n) {
  const [y, m, d] = ymdParts(ymd);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function diffDays(a, b) {
  const [y1, m1, d1] = ymdParts(a);
  const [y2, m2, d2] = ymdParts(b);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}
function monthAdd(month, n) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}
function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return `${y}年${m}月`;
}
function monthDates(month) {
  const [y, m] = month.split('-').map(Number);
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}
function jstNowInput(offsetMs = 0) {
  return new Date(Date.now() + offsetMs + 9 * 3600000).toISOString().slice(0, 16);
}
function jstInputToIso(v) {
  return new Date(`${v}:00+09:00`).toISOString();
}
function relTime(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(ms);
  const m = Math.floor(abs / 60000);
  const h = Math.floor(m / 60);
  const txt = h > 0 ? `${h}時間${m % 60}分` : `${m}分`;
  return ms >= 0 ? `あと${txt}` : `${txt}超過`;
}

const AV_COLORS = ['#7dd3fc', '#86efac', '#fcd34d', '#f9a8d4', '#c4b5fd', '#fdba74', '#5eead4', '#a5b4fc', '#fca5a5', '#bef264', '#93c5fd', '#f0abfc', '#99f6e4', '#fde68a'];
function avatar(staffId, name, size) {
  const n = Number(String(staffId).replace(/\D/g, '').slice(0, 3)) || 0;
  const style = `background:${AV_COLORS[n % AV_COLORS.length]}${size ? `;width:${size}px;height:${size}px` : ''}`;
  return `<span class="avatar" style="${style}">${esc((name || '?').slice(0, 1))}</span>`;
}
const surname = (name) => (name || '').split(' ')[0];

const ST = { assigned: '割当済', completed: '完了', draft: '下書き', awaiting_monthly: '月次待ち', recruiting: '緊急募集中', unassigned: '未割当', cancelled: '取消', pending: '処理中', confirmed: '確定', open: '募集中', escalated: '要対応', filled: '充足' };
const MODE = { monthly: '月次シフト', auto: '自動割当', urgent: '緊急募集', manual: '手動' };
const SRC = { airhost_api: 'AirHost API', email: '予約メール', manual: '手動', seed: '既存', ical: 'iCal' };
const badge = (st, label) => `<span class="badge st-${esc(st)}">${esc(label || ST[st] || st)}</span>`;

const SURNAMES = ['大野', '高木', '桜井', '今井', '河野', '杉山', '千葉', '村田', '新井', '宮崎', '酒井', '工藤', '横山', '宮本', '内田', '安藤', '谷口', '大塚', '丸山', '増田'];
const GIVENS = ['湊', '陽翔', '凛', '結菜', '悠人', '咲良', '蒼', '心春', '健太郎', '美穂', '和人', '恵美', '海斗', '莉子', '直人', '早紀'];
const randomName = () => `${SURNAMES[Math.floor(Math.random() * SURNAMES.length)]} ${GIVENS[Math.floor(Math.random() * GIVENS.length)]}`;

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw Object.assign(new Error((data && data.error) || res.statusText), { data, status: res.status });
  return data;
}

function toast(msg, type = 'ok', ms = 4200) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ===========================================================================
// モーダル
// ===========================================================================
const modal = {
  open(title, body, foot = '', { wide = false } = {}) {
    $('#modal-title').innerHTML = title;
    $('#modal-body').innerHTML = body;
    $('#modal-foot').innerHTML = foot;
    $('.modal').classList.toggle('wide', wide);
    $('#modal-root').hidden = false;
    const f = $('#modal-body input, #modal-body select, #modal-body textarea');
    if (f) setTimeout(() => f.focus(), 30);
  },
  close() {
    $('#modal-root').hidden = true;
    $('#modal-body').innerHTML = '';
  },
  get isOpen() {
    return !$('#modal-root').hidden;
  },
};

// ===========================================================================
// 状態・ルーティング
// ===========================================================================
const S = {
  boot: null,
  view: null,
  month: null,
  calMonth: null,
  calMode: 'property',
  fairMonth: null,
  monthlyMonth: null,
  lineSel: 'group',
  resF: { month: '', propertyId: '', status: '', q: '' },
};

const BG = {
  dashboard: '/img/bg-dashboard.jpg',
  reservations: '/img/bg-reservations.jpg',
  calendar: '/img/bg-calendar.jpg',
  urgent: '/img/bg-urgent.jpg',
  monthly: '/img/bg-monthly.jpg',
  fairness: '/img/bg-fairness.jpg',
  staff: '/img/bg-staff.jpg',
  properties: '/img/bg-properties.jpg',
  notifications: '/img/bg-notifications.jpg',
  integrations: '/img/bg-integrations.jpg',
};

let bgIdx = 0;
let bgCurrent = '';
function setBackground(url) {
  if (url === bgCurrent) return;
  bgCurrent = url;
  const layers = $$('#bg .bg-layer');
  const next = layers[(bgIdx + 1) % 2];
  const img = new Image();
  img.onload = () => {
    next.style.backgroundImage = `url('${url}')`;
    layers[bgIdx % 2].classList.remove('on');
    next.classList.add('on');
    bgIdx++;
  };
  img.src = url;
}

const propById = (id) => S.boot.properties.find((p) => p.id === id);
const staffById = (id) => S.boot.staff.find((s) => s.id === id);

function monthOptions(selected, from = -1, to = 2) {
  const out = [];
  for (let i = from; i <= to; i++) {
    const m = monthAdd(S.boot.month, i);
    out.push(`<option value="${m}" ${m === selected ? 'selected' : ''}>${monthLabel(m)}${S.boot.publishedMonths.includes(m) ? '' : '（未確定）'}</option>`);
  }
  return out.join('');
}

async function refreshBoot() {
  S.boot = await api('GET', '/api/bootstrap');
  const ints = S.boot.integrations;
  $('#mode-pill').textContent = `AirHost: ${ints.airhostMode} ／ LINE: ${ints.lineLive ? 'live' : 'mock（デモ）'}`;
}

async function go() {
  const v = (location.hash.replace(/^#\//, '') || 'dashboard').split('?')[0];
  S.view = VIEWS[v] ? v : 'dashboard';
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === S.view));
  $('#sidebar').classList.remove('open');
  await renderView();
  window.scrollTo(0, 0);
}

let rendering = false;
async function renderView(silent = false) {
  if (rendering) return;
  rendering = true;
  const def = VIEWS[S.view];
  setBackground(BG[S.view]);
  $('#page-title').textContent = def.title;
  $('#page-sub').textContent = def.sub;
  $('#page-actions').innerHTML = def.actions ? def.actions() : '';
  const view = $('#view');
  const y = window.scrollY;
  if (!silent) view.innerHTML = '<div class="card empty">読み込み中…</div>';
  try {
    view.innerHTML = await def.render();
    if (def.after) def.after();
    if (silent) window.scrollTo(0, y);
  } catch (e) {
    view.innerHTML = `<div class="card empty">読み込みに失敗しました：${esc(e.message)}</div>`;
  } finally {
    rendering = false;
  }
}

// ===========================================================================
// 共通パーツ
// ===========================================================================
function cleaningItem(c) {
  const who = c.staffName
    ? `<div class="row" style="gap:6px">${avatar(c.staffId, c.staffName, 28)}<span class="small">${esc(c.staffName)}</span></div>`
    : '';
  return `<div class="cl-item" data-act="cleaning" data-id="${c.id}">
    <span class="bar" style="background:${esc(c.propertyColor)}"></span>
    <div class="main-col">
      <div class="title">${esc(c.propertyName)}</div>
      <div class="meta num">${c.startTime}〜${c.endTime}・拘束 ${c.hours}h${c.reservation ? `・${esc(c.reservation.guestName)} 様（${c.reservation.guests}名）` : ''}${c.mode ? `・${MODE[c.mode] || ''}` : ''}${c.exception ? '・<span style="color:var(--warn)">例外</span>' : ''}</div>
    </div>
    ${who}
    ${badge(c.status)}
  </div>`;
}

function fairnessChart(f) {
  if (!f.rows.length || !f.totalHours) return '<div class="empty">まだ割当がありません（シフト案作成後に表示されます）</div>';
  const max = Math.max(1, ...f.rows.map((r) => Math.max(r.hours, r.expectedHours))) * 1.08;
  const rows = [...f.rows].sort((a, b) => b.hours - a.hours);
  return `<div class="fchart">${rows
    .map((r) => {
      const cls = r.ratio > 1.15 ? 'ratio-hi' : r.ratio < 0.85 ? 'ratio-lo' : 'ratio-ok';
      const lbl = r.ratio > 1.15 ? '多め' : r.ratio < 0.85 ? '少なめ' : '適正';
      const tip = `<b>${esc(r.name)}</b><br>拘束時間 ${r.hours}h（${r.count}件）<br>期待値 ${r.expectedHours}h／差 ${r.diffHours > 0 ? '+' : ''}${r.diffHours}h<br>勤務可能日 ${r.availableDays}日・公平比 ${r.ratio}`;
      return `<div class="frow" data-tip="${esc(tip)}">
        <div class="nm">${esc(r.name)}</div>
        <div class="track"><div class="fill" style="width:${((r.hours / max) * 100).toFixed(1)}%"></div><div class="exp" style="left:${((r.expectedHours / max) * 100).toFixed(1)}%"></div></div>
        <div class="val">${r.hours}h <span class="${cls} small">${lbl}</span></div>
      </div>`;
    })
    .join('')}</div>
    <div class="legend"><span><span class="dot" style="background:var(--accent)"></span>実拘束時間</span><span><span class="dot" style="background:var(--ink);width:3px;height:12px;border-radius:1px"></span>期待拘束時間（勤務可能日数で按分）</span></div>`;
}

function scoreRing(score) {
  const r = 50;
  const c = 2 * Math.PI * r;
  const col = score >= 85 ? 'var(--ok)' : score >= 70 ? 'var(--warn)' : 'var(--danger)';
  return `<svg class="score-ring" viewBox="0 0 120 120" role="img" aria-label="公平性スコア ${score}">
    <circle cx="60" cy="60" r="${r}" fill="none" stroke="rgba(255,255,255,.1)" stroke-width="10"/>
    <circle cx="60" cy="60" r="${r}" fill="none" stroke="${col}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${(c * score) / 100} ${c}" transform="rotate(-90 60 60)"/>
    <text x="60" y="58" text-anchor="middle" fill="#fff" font-size="28" font-weight="700">${score}</text>
    <text x="60" y="78" text-anchor="middle" fill="#8d99ad" font-size="11">/ 100</text>
  </svg>`;
}

// ===========================================================================
// ビュー定義
// ===========================================================================
const VIEWS = {};

// ---------------- ダッシュボード ----------------
VIEWS.dashboard = {
  title: 'ダッシュボード',
  sub: '予約連動の清掃割当・緊急募集・公平性をひと目で確認',
  actions: () => `<button class="btn" data-act="emailImport">✉ 予約メール取込</button><button class="btn primary" data-act="newRes">＋ 新規予約をシミュレート</button>`,
  async render() {
    const x = await api('GET', '/api/dashboard');
    const k = x.kpi;
    const byDay = {};
    for (const c of x.upcoming) (byDay[c.date] = byDay[c.date] || []).push(c);
    const days = Object.keys(byDay).sort();

    const urgentBanner = x.urgent
      .map(
        (u) => `<div class="card urgent-card ${u.status}" style="margin-bottom:12px;padding:14px 18px">
        <div class="row">
          ${badge(u.status)}<b>${esc(u.cleaning?.propertyName)}　${fmtDate(u.date)} ${esc(u.cleaning?.startTime)}〜</b>
          <span class="muted small">${esc(u.reason)}</span><span class="spacer"></span>
          <span class="small">回答 ${u.candidates.filter((c) => c.response).length}/${u.candidates.length}名・期限 <span class="countdown" data-deadline="${u.deadline}">${relTime(u.deadline)}</span></span>
          <a class="btn sm danger" href="#/urgent">対応状況を見る</a>
        </div></div>`
      )
      .join('');

    return `
      <div class="card hero">
        <div>
          <h2>${fmtDateLong(x.today)}</h2>
          <p>新規予約を検知すると、勤務不可日・対応施設・1日1施設・拘束時間の公平性を考慮して自動で担当を決め、AirHost 登録と LINE 通知まで行います。</p>
        </div>
        <span class="spacer"></span>
        <div class="row">
          <button class="btn" data-act="newRes" data-preset="urgent">⚡ 直前予約（今夜23時）を試す</button>
          <button class="btn primary" data-act="newRes" data-preset="normal">＋ 通常予約を試す</button>
        </div>
      </div>
      ${urgentBanner}
      <div class="kpis">
        <div class="card kpi"><div class="label">今月の清掃</div><div class="value">${k.monthCleanings}<small>件</small></div><div class="foot num">拘束時間 合計 ${k.monthHours}h</div></div>
        <div class="card kpi ${k.needsAction ? 'alert' : ''}"><div class="label">要対応（未割当・募集中）</div><div class="value">${k.needsAction}<small>件</small></div><div class="foot">${k.needsAction ? '緊急募集画面で確認' : '問題ありません'}</div></div>
        <div class="card kpi"><div class="label">公平性スコア（今月）</div><div class="value">${k.fairnessScore}<small>/100</small></div><div class="foot">拘束時間ベース</div></div>
        <div class="card kpi"><div class="label">AirHost 同期率</div><div class="value">${k.airhostSyncRate}<small>%</small></div><div class="foot">割当済み清掃のうち登録済み</div></div>
        <div class="card kpi"><div class="label">直近7日の新規予約</div><div class="value">${k.newReservations7d}<small>件</small></div><div class="foot">API・メール・手動の合計</div></div>
      </div>
      <div class="grid g-main">
        <div class="stack">
          ${
            x.conflicts.length
              ? `<div class="card" style="border-color:rgba(251,146,60,.5)"><h3>⚠ 勤務不可日と確定シフトの衝突 <span class="sub">${x.conflicts.length}件</span></h3>${x.conflicts.map(cleaningItem).join('')}<p class="small muted">クリックして「自動で再割当」または手動で担当を変更してください。</p></div>`
              : ''
          }
          <div class="card">
            <h3>今後7日間の清掃 <span class="sub">${x.upcoming.length}件</span></h3>
            ${
              days.length
                ? days.map((dd) => `<div class="day-group"><div class="day-head">${fmtDate(dd)}${dd === x.today ? '（今日）' : dd === x.tomorrow ? '（明日）' : ''}</div>${byDay[dd].map(cleaningItem).join('')}</div>`).join('')
                : '<div class="empty">予定はありません</div>'
            }
          </div>
        </div>
        <div class="stack">
          <div class="card">
            <h3>今月の公平性 <a class="sub" href="#/fairness">詳細 →</a></h3>
            <div class="row" style="gap:18px;align-items:center">
              ${scoreRing(x.fairness.score)}
              <div class="small" style="flex:1;min-width:150px">
                <div>総拘束時間 <b class="num">${x.fairness.totalHours}h</b>（${x.fairness.totalCount}件）</div>
                <div class="muted">勤務可能日数に応じた期待値との差で評価。件数・報酬額ではなく「拘束時間」で均等化します。</div>
              </div>
            </div>
          </div>
          <div class="card">
            <h3>最近のアクティビティ <a class="sub" href="#/integrations">連携ログ →</a></h3>
            <ul class="timeline">${x.events
              .map((e) => `<li class="lv-${e.level}"><span class="t">${fmtDT(e.at)}</span><span class="m"></span><span>${esc(e.message)}</span></li>`)
              .join('')}</ul>
          </div>
        </div>
      </div>`;
  },
};

// ---------------- 予約一覧 ----------------
VIEWS.reservations = {
  title: '予約一覧',
  sub: 'AirHost（API／予約通知メール）から取り込んだ予約と、紐づく清掃予定',
  actions: () => `<button class="btn" data-act="emailImport">✉ 予約メール取込</button><button class="btn primary" data-act="newRes">＋ 新規予約をシミュレート</button>`,
  async render() {
    const f = S.resF;
    if (!f.month) f.month = S.boot.month;
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    const list = await api('GET', `/api/reservations?${qs}`);
    return `<div class="card">
      <div class="filters">
        <div class="field"><label>対象月</label><select class="input" data-filter="month">${monthOptions(f.month)}</select></div>
        <div class="field"><label>施設</label><select class="input" data-filter="propertyId"><option value="">すべて</option>${S.boot.properties.map((p) => `<option value="${p.id}" ${p.id === f.propertyId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
        <div class="field"><label>状態</label><select class="input" data-filter="status"><option value="">すべて</option><option value="confirmed" ${f.status === 'confirmed' ? 'selected' : ''}>確定</option><option value="cancelled" ${f.status === 'cancelled' ? 'selected' : ''}>キャンセル</option></select></div>
        <div class="field" style="flex:1"><label>検索（ゲスト名・予約番号）</label><input class="input" data-filter="q" value="${esc(f.q)}" placeholder="例：山口 / HM26…" /></div>
        <span class="muted small">${list.length}件</span>
      </div>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>予約番号</th><th>ゲスト</th><th>施設</th><th>宿泊期間</th><th class="r">人数</th><th>経路</th><th>受付</th><th>清掃（チェックアウト日）</th><th></th></tr></thead>
        <tbody>${
          list
            .map(
              (r) => `<tr class="${r.status === 'cancelled' ? 'cancelled' : ''}">
            <td class="num small">${esc(r.code)}</td>
            <td class="strong" style="white-space:nowrap">${esc(r.guestName)} 様</td>
            <td style="white-space:nowrap"><span class="row" style="gap:6px;flex-wrap:nowrap"><span class="dot" style="background:${esc(r.propertyColor)}"></span>${esc(r.propertyName)}</span></td>
            <td class="num">${fmtDate(r.checkIn)} → ${fmtDate(r.checkOut)} <span class="muted small">${r.nights}泊</span></td>
            <td class="r num">${r.guests}</td>
            <td class="small">${esc(r.channel)}</td>
            <td class="small muted">${fmtDT(r.bookedAt)}<br>${esc(SRC[r.source] || r.source)}</td>
            <td>${r.cleaning ? `<span class="row" style="gap:6px;cursor:pointer" data-act="cleaning" data-id="${r.cleaning.id}">${badge(r.cleaning.status)}<span class="small">${esc(r.cleaning.staffName || '')}</span></span>` : ''}</td>
            <td class="r" style="white-space:nowrap">${
              r.status === 'confirmed' && r.checkOut >= S.boot.today
                ? `<button class="btn sm" data-act="editRes" data-id="${r.id}">変更</button> <button class="btn sm danger" data-act="cancelRes" data-id="${r.id}">キャンセル</button>`
                : r.status === 'cancelled'
                  ? badge('cancelled', 'キャンセル済')
                  : '<span class="small muted">滞在終了</span>'
            }</td>
          </tr>`
            )
            .join('') || '<tr><td colspan="9" class="empty">該当する予約はありません</td></tr>'
        }</tbody>
      </table></div>
    </div>`;
  },
};

// ---------------- 清掃カレンダー ----------------
VIEWS.calendar = {
  title: '清掃カレンダー',
  sub: 'AirHost 清掃カレンダーと同期する担当表（クリックで候補ランキング・手動変更）',
  actions: () => `<div class="seg"><button data-act="calMode" data-mode="property" class="${S.calMode === 'property' ? 'on' : ''}">施設別</button><button data-act="calMode" data-mode="staff" class="${S.calMode === 'staff' ? 'on' : ''}">スタッフ別</button></div>`,
  async render() {
    const month = (S.calMonth = S.calMonth || S.boot.month);
    const [cleanings, reservations, staff] = await Promise.all([api('GET', `/api/cleanings?month=${month}`), api('GET', `/api/reservations?month=${month}&status=confirmed`), api('GET', `/api/staff?month=${month}`)]);
    const dates = monthDates(month);
    const today = S.boot.today;
    const head = `<tr><th class="rowhead">${S.calMode === 'property' ? '施設' : 'スタッフ'}</th>${dates
      .map((dd) => {
        const w = weekdayIdx(dd);
        return `<th class="${w === 6 ? 'sat' : w === 0 ? 'sun' : ''} ${dd === today ? 'today' : ''}">${Number(dd.slice(8))}<span class="wd">${WD[w]}</span></th>`;
      })
      .join('')}</tr>`;

    const chip = (c, label, sub) =>
      `<span class="chip st-${c.status} ${c.exception ? 'exc' : ''}" data-act="cleaning" data-id="${c.id}" data-tip="${esc(`<b>${esc(c.propertyName)}</b><br>${fmtDate(c.date)} ${esc(c.startTime)}〜${esc(c.endTime)}（拘束${c.hours}h）<br>担当：${esc(c.staffName) || '—'}<br>状態：${ST[c.status]}${c.mode ? `・${MODE[c.mode]}` : ''}${c.reservation ? `<br>${esc(c.reservation.guestName)} 様` : ''}`)}">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>`;

    let body = '';
    if (S.calMode === 'property') {
      body = S.boot.properties
        .map((p) => {
          const cells = dates
            .map((dd) => {
              const occ = reservations.some((r) => r.propertyId === p.id && r.checkIn <= dd && dd < r.checkOut);
              const cs = cleanings.filter((c) => c.propertyId === p.id && c.date === dd);
              const inner = cs.map((c) => chip(c, c.staffName ? surname(c.staffName) : { recruiting: '募集中', unassigned: '未割当', awaiting_monthly: '待ち' }[c.status] || '—', c.startTime)).join('');
              return `<td class="cell ${occ ? 'occ' : ''} ${dd === today ? 'todaycol' : ''}">${inner}</td>`;
            })
            .join('');
          return `<tr><th class="rowhead"><span class="row" style="gap:8px;flex-wrap:nowrap"><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}</span></th>${cells}</tr>`;
        })
        .join('');
    } else {
      body = staff
        .filter((s) => s.active)
        .map((s) => {
          const off = new Set(s.unavailable);
          const cells = dates
            .map((dd) => {
              const cs = cleanings.filter((c) => c.staffId === s.id && c.date === dd);
              const inner = cs.map((c) => chip(c, propById(c.propertyId)?.area || '', c.startTime)).join('');
              return `<td class="cell ${off.has(dd) ? 'off' : ''} ${dd === today ? 'todaycol' : ''}">${inner}</td>`;
            })
            .join('');
          return `<tr><th class="rowhead"><span class="row" style="gap:8px;flex-wrap:nowrap">${avatar(s.id, s.name, 24)}${esc(s.name)}<span class="muted small num">${s.monthHours}h</span></span></th>${cells}</tr>`;
        })
        .join('');
    }

    return `<div class="card">
      <div class="filters">
        <div class="field"><label>表示月</label><select class="input" data-act-change="calMonth">${monthOptions(month)}</select></div>
        <span class="spacer"></span>
        ${S.boot.publishedMonths.includes(month) ? badge('assigned', '月次シフト確定済') : badge('awaiting_monthly', '月次シフト未確定')}
      </div>
      <div class="cal-wrap"><table class="cal"><thead>${head}</thead><tbody>${body}</tbody></table></div>
      <div class="legend">
        <span>${badge('assigned')}</span><span>${badge('draft')}</span><span>${badge('recruiting')}</span><span>${badge('unassigned')}</span><span>${badge('awaiting_monthly')}</span><span>${badge('completed')}</span>
        ${S.calMode === 'property' ? '<span><span class="dot" style="background:rgba(255,255,255,.18)"></span>宿泊中</span>' : '<span><span class="dot" style="background:repeating-linear-gradient(135deg,rgba(248,113,113,.6) 0 2px,transparent 2px 4px)"></span>勤務不可日</span>'}
        <span><span class="dot" style="box-shadow:0 0 0 2px var(--warn)"></span>例外（同日2件目）</span>
      </div>
    </div>`;
  },
};

// ---------------- 緊急募集 ----------------
VIEWS.urgent = {
  title: '緊急募集',
  sub: '清掃前日・当日の直前予約は、勤務可能な全員へ LINE で募集 → 先着1名で確定 → AirHost 登録',
  actions: () => `<button class="btn" data-act="tick">⏱ 期限チェックを実行</button><button class="btn primary" data-act="newRes" data-preset="urgent">⚡ 直前予約を発生させる</button>`,
  async render() {
    const list = await api('GET', '/api/urgent');
    const active = list.filter((u) => ['open', 'escalated'].includes(u.status));
    const past = list.filter((u) => !['open', 'escalated'].includes(u.status));
    const card = (u) => {
      const c = u.cleaning || {};
      const isActive = ['open', 'escalated'].includes(u.status);
      return `<div class="card urgent-card ${u.status}">
        <div class="row">
          ${badge(u.status)}
          <h3 style="margin:0">${esc(c.propertyName)}　${fmtDate(u.date)} ${esc(c.startTime)}〜${esc(c.endTime)}</h3>
          <span class="spacer"></span>
          ${isActive ? `<span class="small">回答期限 ${fmtDT(u.deadline)}（<span class="countdown" data-deadline="${u.deadline}">${relTime(u.deadline)}</span>）</span>` : ''}
        </div>
        <div class="small muted" style="margin-top:6px">
          ${esc(u.reason)}・受付 ${fmtDT(u.createdAt)}・拘束 ${c.hours}h${c.reservation ? `・${esc(c.reservation.guestName)} 様（${c.reservation.guests}名・${esc(c.reservation.code)}）` : ''}
          ${u.status === 'filled' ? `・<b style="color:var(--ok)">${esc(u.filledByName)} さんに確定（${fmtDT(u.filledAt)}）</b>` : ''}
          ${u.status === 'cancelled' ? `・${esc(u.closeReason || '終了')}` : ''}
        </div>
        ${
          u.candidates.length
            ? `<div class="cand-list">${u.candidates
                .map((cd) => {
                  const r = cd.response;
                  const st = r === 'accepted' ? '承諾' : r === 'declined' ? '辞退' : r === 'ineligible' ? '対象外' : '未回答';
                  return `<div class="cand ${r || ''}">
                  ${avatar(cd.staffId, cd.name, 30)}
                  <div class="nm">${esc(cd.name)}<small>${st}${cd.respondedAt ? `・${fmtTime(cd.respondedAt)}` : ''}${cd.exception ? '・同日2件目' : ''}</small></div>
                  ${
                    isActive && !r
                      ? `<button class="btn sm ok" data-act="urgRespond" data-id="${u.id}" data-staff="${cd.staffId}" data-answer="accept" title="このスタッフとして承諾（デモ）">承諾</button>
                         <button class="btn sm ghost" data-act="urgRespond" data-id="${u.id}" data-staff="${cd.staffId}" data-answer="decline" title="このスタッフとして辞退（デモ）">辞退</button>
                         <a class="btn sm ghost" href="/r/${cd.token}" target="_blank" title="スタッフが LINE から開く回答ページ">↗</a>`
                      : ''
                  }
                </div>`;
                })
                .join('')}</div>`
            : '<p class="small" style="color:var(--serious)">条件を満たすスタッフがいないため、管理者へエスカレーションしました。</p>'
        }
        ${
          isActive
            ? `<div class="row mt">
                <button class="btn sm" data-act="cleaning" data-id="${c.id}">管理者が手動で割当</button>
                ${u.status === 'open' ? `<button class="btn sm danger" data-act="urgEscalate" data-id="${u.id}">期限切れをシミュレート（エスカレーション）</button>` : ''}
                <a class="btn sm line" href="#/notifications" data-act="lineSel" data-sel="group">LINE グループの投稿を見る</a>
              </div>`
            : ''
        }
      </div>`;
    };
    return `<div class="stack">
      <div class="card">
        <h3>緊急募集の流れ</h3>
        <div class="flow">
          <div class="step"><b>STEP 1</b>清掃日が予約受付日の前日・当日以内の予約を検知</div>
          <div class="step"><b>STEP 2</b>勤務可能・対応可能なスタッフ全員を抽出</div>
          <div class="step"><b>STEP 3</b>LINE グループにメンション投稿＋個別に回答ボタン送信</div>
          <div class="step"><b>STEP 4</b>最初に「対応できます」を押した人で確定（先着1名）</div>
          <div class="step"><b>STEP 5</b>AirHost 登録・全員へ決定通知・管理者へ報告</div>
          <div class="step"><b>期限切れ</b>回答がなければ管理者へエスカレーション＋未回答者へ再送</div>
        </div>
      </div>
      ${active.length ? active.map(card).join('') : '<div class="card empty">現在募集中の案件はありません。右上の「直前予約を発生させる」で動作を確認できます。</div>'}
      ${past.length ? `<h3 style="margin:8px 0 0">履歴</h3>${past.map(card).join('')}` : ''}
    </div>`;
  },
};

// ---------------- 月次シフト ----------------
VIEWS.monthly = {
  title: '月次シフト',
  sub: '毎月20日締めの勤務不可日をもとに、翌月シフトを公平性を考慮して自動作成 → 確定で AirHost 登録・LINE 配信',
  actions: () => `<a class="btn" href="/availability" target="_blank">📝 勤務不可日 提出フォーム（スタッフ用）</a>`,
  async render() {
    if (!S.monthlyMonth) {
      // 既定は「まだ確定していない最初の月」
      S.monthlyMonth = [0, 1, 2].map((i) => monthAdd(S.boot.month, i)).find((m) => !S.boot.publishedMonths.includes(m)) || monthAdd(S.boot.month, 1);
    }
    const month = S.monthlyMonth;
    const [x, cleanings] = await Promise.all([api('GET', `/api/monthly/${month}`), api('GET', `/api/cleanings?month=${month}`)]);
    const submitted = x.submissions.filter((s) => s.submittedAt).length;
    const drafts = cleanings.filter((c) => ['draft', 'assigned', 'completed'].includes(c.status) && c.staffId);
    const byStaff = {};
    for (const c of drafts) (byStaff[c.staffId] = byStaff[c.staffId] || []).push(c);
    const unassigned = cleanings.filter((c) => c.status === 'unassigned');

    return `<div class="stack">
      <div class="card">
        <div class="filters" style="margin-bottom:0">
          <div class="field"><label>対象月</label><select class="input" data-act-change="monthlyMonth">${monthOptions(month, 0, 2)}</select></div>
          <div>${x.published ? badge('assigned', '確定・配信済') : x.draft ? badge('draft', 'シフト案あり（未確定）') : badge('awaiting_monthly', '未作成')}</div>
          <span class="spacer"></span>
          ${
            x.published
              ? '<span class="small muted">確定後に入った予約は自動割当・緊急募集で処理されます</span>'
              : `<button class="btn" data-act="mGenerate" data-month="${month}">⚙ シフト案を自動作成${x.draft ? '（作り直し）' : ''}</button>
                 <button class="btn primary" data-act="mPublish" data-month="${month}" ${x.counts.draft ? '' : 'disabled'}>✔ 確定して AirHost 登録・LINE 配信</button>`
          }
        </div>
      </div>
      <div class="kpis" style="margin:0">
        <div class="card kpi"><div class="label">清掃予定</div><div class="value">${x.counts.total}<small>件</small></div></div>
        <div class="card kpi"><div class="label">割当済 / 下書き</div><div class="value">${x.counts.assigned}<small>/ ${x.counts.draft}</small></div></div>
        <div class="card kpi"><div class="label">作成待ち</div><div class="value">${x.counts.awaiting}<small>件</small></div></div>
        <div class="card kpi ${x.counts.unassigned ? 'alert' : ''}"><div class="label">未割当</div><div class="value">${x.counts.unassigned}<small>件</small></div></div>
        <div class="card kpi"><div class="label">勤務不可日 提出</div><div class="value">${submitted}<small>/ ${x.submissions.length}名</small></div><div class="foot">締切 ${fmtDate(x.deadline)}</div></div>
      </div>
      <div class="grid g2">
        <div class="card">
          <h3>スタッフ別シフト <span class="sub">拘束時間の多い順</span></h3>
          ${
            Object.keys(byStaff).length
              ? Object.entries(byStaff)
                  .map(([sid, list]) => ({ sid, list, h: list.reduce((a, c) => a + c.hours, 0) }))
                  .sort((a, b) => b.h - a.h)
                  .map(
                    ({ sid, list, h }) => `<div class="row" style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,.06);align-items:flex-start;flex-wrap:nowrap">
                      ${avatar(sid, staffById(sid)?.name, 30)}
                      <div style="flex:1;min-width:0"><b>${esc(staffById(sid)?.name)}</b> <span class="muted small num">${list.length}件・${Math.round(h * 10) / 10}h</span>
                      <div class="row" style="gap:4px;margin-top:4px">${list
                        .sort((a, b) => (a.date < b.date ? -1 : 1))
                        .map((c) => `<span class="tag" style="cursor:pointer;border-color:${esc(c.propertyColor)}66" data-act="cleaning" data-id="${c.id}">${Number(c.date.slice(8))}日 ${esc(propById(c.propertyId)?.area)}</span>`)
                        .join('')}</div></div></div>`
                  )
                  .join('')
              : '<div class="empty">まだシフト案がありません。「シフト案を自動作成」を押してください。</div>'
          }
          ${unassigned.length ? `<h3 class="mt" style="color:var(--serious)">未割当</h3>${unassigned.map(cleaningItem).join('')}` : ''}
        </div>
        <div class="stack">
          <div class="card"><h3>公平性プレビュー <span class="sub">${x.fairness.totalHours ? `スコア ${x.fairness.score}` : ''}</span></h3>${fairnessChart(x.fairness)}</div>
          <div class="card">
            <h3>勤務不可日の提出状況 <a class="sub" href="/availability?month=${month}" target="_blank">提出フォーム →</a></h3>
            <div class="table-wrap"><table class="tbl"><thead><tr><th>スタッフ</th><th class="r">不可日数</th><th>提出日時</th></tr></thead><tbody>
              ${x.submissions.map((s) => `<tr><td>${esc(s.name)}</td><td class="r num">${s.days}</td><td>${s.submittedAt ? `<span class="small">${fmtDT(s.submittedAt)}</span>` : badge('unassigned', '未提出')}</td></tr>`).join('')}
            </tbody></table></div>
          </div>
        </div>
      </div>
    </div>`;
  },
};

// ---------------- 公平性管理 ----------------
VIEWS.fairness = {
  title: '公平性管理シート',
  sub: '清掃件数や報酬額ではなく「拘束時間（清掃＋移動）」で公平性を管理',
  actions: () => `<a class="btn" href="/api/fairness.csv?month=${S.fairMonth || S.boot.month}">⬇ CSV（Excel／スプレッドシート）</a><button class="btn primary" data-act="sheetSync">⇪ スプレッドシートへ同期</button>`,
  async render() {
    const month = (S.fairMonth = S.fairMonth || S.boot.month);
    const [f, log] = await Promise.all([api('GET', `/api/fairness?month=${month}`), api('GET', '/api/fairness/sync-log')]);
    const maxDev = f.rows.reduce((a, r) => Math.max(a, Math.abs(r.diffHours)), 0);
    return `<div class="stack">
      <div class="card"><div class="filters" style="margin-bottom:0">
        <div class="field"><label>対象月</label><select class="input" data-act-change="fairMonth">${monthOptions(month)}</select></div>
        <span class="spacer"></span><span class="small muted">期待拘束時間 = 当月総拘束時間 × 本人の勤務可能日数 ÷ 全員の勤務可能日数</span>
      </div></div>
      <div class="grid g-main">
        <div class="card"><h3>スタッフ別 拘束時間と期待値</h3>${fairnessChart(f)}</div>
        <div class="card">
          <h3>サマリー</h3>
          <div class="row" style="gap:20px">${scoreRing(f.score)}
            <dl class="kv" style="flex:1;min-width:150px">
              <dt>総拘束時間</dt><dd class="num">${f.totalHours} h</dd>
              <dt>清掃件数</dt><dd class="num">${f.totalCount} 件</dd>
              <dt>最大乖離</dt><dd class="num">±${maxDev} h</dd>
              <dt>対象スタッフ</dt><dd class="num">${f.rows.length} 名</dd>
            </dl>
          </div>
          <p class="small muted">スコアは「公平比（実績÷期待値）」の 1.0 からの平均乖離で算出。自動割当は常に「割当後の（拘束時間 ÷ 勤務可能日数）」が最も小さいスタッフを選ぶため、月内で自然に均されます。</p>
        </div>
      </div>
      <div class="card">
        <h3>公平性管理シート（${monthLabel(month)}）</h3>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>スタッフ</th><th class="r">勤務可能日</th><th class="r">清掃件数</th><th class="r">拘束時間</th><th class="r">期待拘束時間</th><th class="r">差分</th><th class="r">公平比</th><th class="r">割当率</th></tr></thead>
          <tbody>${f.rows
            .map((r) => {
              const cls = r.ratio > 1.15 ? 'ratio-hi' : r.ratio < 0.85 ? 'ratio-lo' : 'ratio-ok';
              return `<tr><td class="strong"><span class="row" style="gap:8px;flex-wrap:nowrap">${avatar(r.staffId, r.name, 26)}${esc(r.name)}</span></td><td class="r num">${r.availableDays}日</td><td class="r num">${r.count}件</td><td class="r num strong">${r.hours}h</td><td class="r num">${r.expectedHours}h</td><td class="r num">${r.diffHours > 0 ? '+' : ''}${r.diffHours}h</td><td class="r num ${cls}">${r.ratio.toFixed(2)}</td><td class="r num">${r.share}%</td></tr>`;
            })
            .join('')}</tbody>
          <tfoot><tr><td class="strong">合計</td><td></td><td class="r num">${f.totalCount}件</td><td class="r num strong">${f.totalHours}h</td><td colspan="4"></td></tr></tfoot>
        </table></div>
      </div>
      <div class="card"><h3>シート同期ログ <span class="sub">割当・変更のたびに自動反映</span></h3>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>日時</th><th>対象月</th><th>契機</th><th>方式</th><th class="r">スコア</th><th>結果</th></tr></thead><tbody>
        ${log.slice(0, 12).map((l) => `<tr><td class="small">${fmtDT(l.at)}</td><td>${l.month}</td><td class="small">${esc(l.reason)}</td><td>${l.mode === 'live' ? 'Google Sheets' : 'モック'}</td><td class="r num">${l.score}</td><td>${badge(l.status === 'success' ? 'assigned' : l.status === 'failed' ? 'unassigned' : 'draft', l.status === 'success' ? '反映済' : l.status)}</td></tr>`).join('')}
        </tbody></table></div>
      </div>
    </div>`;
  },
};

// ---------------- スタッフ ----------------
VIEWS.staff = {
  title: '清掃スタッフ',
  sub: '対応可能施設・勤務不可日・LINE 連携の管理',
  actions: () => `<button class="btn primary" data-act="staffEdit">＋ スタッフを追加</button>`,
  async render() {
    const list = await api('GET', `/api/staff?month=${S.boot.month}`);
    return `<div class="cards">${list
      .map(
        (s) => `<div class="card staff-card ${s.active ? '' : 'inactive'}">
        <div class="head">${avatar(s.id, s.name)}<div style="flex:1;min-width:0"><div class="name">${esc(s.name)}</div><div class="small muted">${esc(s.phone)}</div></div>
          ${s.active ? '' : badge('cancelled', '休止中')}
          ${s.lineLinked ? '<span class="badge plain" style="background:rgba(6,199,85,.18);color:#86efac">LINE連携</span>' : '<span class="badge plain st-unassigned">LINE未連携</span>'}
        </div>
        <div class="row" style="gap:5px">${S.boot.properties.map((p) => (s.properties.includes(p.id) ? `<span class="tag" style="border-color:${esc(p.color)}88">${esc(p.area)}</span>` : '')).join('')}</div>
        <div class="stats">
          <div class="stat"><b>${s.monthCount}</b><span>今月の件数</span></div>
          <div class="stat"><b>${s.monthHours}h</b><span>拘束時間</span></div>
          <div class="stat"><b>${s.availableDays}</b><span>勤務可能日</span></div>
        </div>
        <div class="row small muted"><span>今月の不可日 ${s.unavailable.filter((x) => x.startsWith(S.boot.month)).length}日</span><span class="spacer"></span><button class="btn sm" data-act="staffEdit" data-id="${s.id}">編集・不可日</button></div>
      </div>`
      )
      .join('')}</div>`;
  },
};

// ---------------- 施設 ----------------
VIEWS.properties = {
  title: '施設',
  sub: '一棟貸し施設ごとの清掃時間・移動時間（＝拘束時間）とチェックアウト／イン時刻',
  actions: () => `<button class="btn primary" data-act="propEdit">＋ 施設を追加</button>`,
  async render() {
    const list = await api('GET', '/api/properties');
    return `<div class="cards">${list
      .map(
        (p) => `<div class="card prop-card">
        <div class="img ${p.image ? '' : 'noimg'}" style="${p.image ? `background-image:url('${esc(p.image)}')` : ''}"><div class="ttl"><b>${esc(p.name)}</b><span>${esc(p.address)}</span></div></div>
        <div class="body">
          <dl class="kv">
            <dt>拘束時間</dt><dd><b class="num">${p.restraintHours}h</b> <span class="muted small">（清掃 ${p.cleaningHours}h ＋ 移動 ${p.travelHours}h）</span></dd>
            <dt>清掃枠</dt><dd class="num">OUT ${esc(p.checkoutTime)} → IN ${esc(p.checkinTime)}</dd>
            <dt>定員</dt><dd class="num">${p.capacity}名</dd>
            <dt>AirHost ID</dt><dd class="num small">${esc(p.airhostListingId || '未設定')}</dd>
            <dt>対応スタッフ</dt><dd class="num">${p.staffCount}名</dd>
            <dt>今月の清掃</dt><dd class="num">${p.monthCleanings}件</dd>
          </dl>
          <div class="row mt"><span class="spacer"></span><button class="btn sm" data-act="propEdit" data-id="${p.id}">編集</button></div>
        </div>
      </div>`
      )
      .join('')}</div>`;
  },
};

// ---------------- LINE 通知 ----------------
VIEWS.notifications = {
  title: 'LINE 通知',
  sub: 'スタッフ・グループ・管理者へ送信された LINE メッセージ（デモではモック送信をプレビュー表示）',
  async render() {
    const sel = S.lineSel;
    const [msgs, counts] = await Promise.all([api('GET', `/api/notifications?to=${encodeURIComponent(sel)}&limit=60`), api('GET', '/api/notifications?limit=500')]);
    const cnt = (pred) => counts.filter(pred).length;
    const entries = [
      { key: 'group', label: '清掃スタッフ グループ', icon: '👥', n: cnt((n) => n.to.type === 'group') },
      { key: 'admins', label: '管理者', icon: '🛡', n: cnt((n) => n.to.type === 'admins') },
      ...S.boot.staff.map((s) => ({ key: s.id, label: s.name, staff: s, n: cnt((n) => n.to.staffId === s.id) })),
    ];
    const cur = entries.find((e) => e.key === sel) || entries[0];
    const nameOf = (id) => staffById(id)?.name || '';
    const bubble = (m) => `<div class="bubble-row">
      <div class="av">LINE</div>
      <div class="bubble"><b>${esc(m.title)}</b>${m.mentions.length ? `<span class="mention">${m.mentions.map((id) => '@' + esc(nameOf(id))).join(' ')}</span>\n` : ''}${esc(m.text)}${
        m.actions.length
          ? `<div class="bubble-actions">${m.actions
              .map((a) => (a.kind === 'link' ? `<a href="/r/${esc(a.url.split('/r/')[1] || '')}" target="_blank">${esc(a.label)}</a>` : `<button data-act="lineAnswer" data-token="${a.token}" data-answer="${a.kind}">${esc(a.label)}</button>`))
              .join('')}</div>`
          : ''
      }</div>
      <span class="bubble-time">${fmtDT(m.at)}${m.mode === 'live' ? ` ・${m.status}` : ''}</span>
    </div>`;
    return `<div class="line-layout">
      <div class="card" style="padding:12px"><div class="line-list">${entries
        .map((e) => `<button class="${e.key === cur.key ? 'on' : ''}" data-act="lineSel" data-sel="${e.key}">${e.staff ? avatar(e.staff.id, e.staff.name, 26) : `<span style="width:26px;text-align:center">${e.icon}</span>`}<span>${esc(e.label)}</span><span class="cnt">${e.n}</span></button>`)
        .join('')}</div></div>
      <div class="phone">
        <div class="phone-head"><span class="lg">LINE</span>${esc(cur.label)}<span class="spacer"></span><span class="small" style="font-weight:400;opacity:.8">${S.boot.integrations.lineLive ? 'Messaging API 送信中' : 'モック送信（デモ）'}</span></div>
        <div class="phone-body">${msgs.length ? msgs.map(bubble).join('') : '<div class="empty" style="color:#1f2937">メッセージはありません</div>'}</div>
      </div>
    </div>`;
  },
};

// ---------------- 連携設定 ----------------
VIEWS.integrations = {
  title: 'AirHost・連携設定',
  sub: '予約検知／AirHost 清掃カレンダー登録／LINE／公平性シートの連携方式と同期ログ',
  async render() {
    const [log, events] = await Promise.all([api('GET', '/api/airhost/log'), api('GET', '/api/events?limit=40')]);
    const st = S.boot.settings;
    const ints = S.boot.integrations;
    const origin = location.origin;
    return `<div class="stack">
      <div class="card">
        <h3>自動化フロー</h3>
        <div class="flow">
          <div class="step"><b>① 予約検知</b>AirHost API／予約通知メール（Gmail→GAS）／手動</div>
          <div class="step"><b>清掃予定生成</b>チェックアウト日・時刻＋拘束時間を自動計算</div>
          <div class="step"><b>② 自動割当</b>不可日・対応施設・1日1施設・公平性（拘束時間）</div>
          <div class="step"><b>③ AirHost 登録</b>清掃カレンダーへ担当者を登録</div>
          <div class="step"><b>④ LINE 通知</b>担当者へ清掃日・施設・時間を通知</div>
          <div class="step"><b>⑤ 緊急募集</b>前日・当日の予約はグループ募集→先着確定</div>
          <div class="step"><b>⑥ 変更・取消</b>担当維持 or 再割当、取消通知、シート更新</div>
        </div>
      </div>
      <div class="grid g2">
        <div class="card">
          <h3>① 予約の検知方法</h3>
          <div class="method"><span class="lvl">${badge('assigned', '推奨')}</span><div><b>予約通知メール → Gmail → Google Apps Script → Webhook</b><div class="small muted">AirHost の予約通知メール（新規・変更・キャンセル）を GAS が1分間隔で検知し本システムへ転送。API 契約不要で即日導入可能。表記ゆれに強いパーサ実装済み。</div></div></div>
          <div class="method"><span class="lvl">${badge('draft', '要確認')}</span><div><b>AirHost API／Webhook</b><div class="small muted">AirHost 社へ API 提供可否を確認のうえ接続。受信口は実装済み（下記エンドポイント）。</div></div></div>
          <div class="method"><span class="lvl">${badge('awaiting_monthly', '補助')}</span><div><b>iCal 定期取得</b><div class="small muted">日程のみ取得可能。ゲスト名・人数が取れないため、取りこぼし検知の補助として利用。</div></div></div>
          <div class="code">POST ${esc(origin)}/api/webhooks/email
Header: X-Webhook-Secret: (EMAIL_WEBHOOK_SECRET)
{ "subject": "...", "body": "..." }

POST ${esc(origin)}/api/webhooks/airhost
{ "event": "reservation.created", "data": { "code": "HM...", "listingId": "AH-L-10231", "guestName": "山口 翔太", "guests": 4, "checkIn": "2026-12-12", "checkOut": "2026-12-13" } }</div>
          <div class="row mt"><button class="btn" data-act="emailImport">✉ メール取込を試す</button></div>
        </div>
        <div class="card">
          <h3>③ AirHost 清掃カレンダー登録 <span class="sub">現在: ${esc(ints.airhostMode)}</span></h3>
          <div class="method"><span class="lvl">${badge('draft', 'API')}</span><div><b>AirHost API（AIRHOST_MODE=api）</b><div class="small muted">清掃タスク API が利用できる場合に直接登録。</div></div></div>
          <div class="method"><span class="lvl">${badge('assigned', '代替')}</span><div><b>RPA（AIRHOST_MODE=rpa）</b><div class="small muted">API が無い場合、Playwright ワーカーが管理画面の清掃カレンダーへ担当者を登録。登録ジョブはキュー管理・失敗時は再試行／管理者通知。</div></div></div>
          <div class="method"><span class="lvl">${badge('awaiting_monthly', 'デモ')}</span><div><b>モック（AIRHOST_MODE=mock）</b><div class="small muted">登録内容を同期ログに記録（このデモの既定）。</div></div></div>
          <div class="table-wrap" style="max-height:260px;overflow-y:auto"><table class="tbl"><thead><tr><th>日時</th><th>操作</th><th>施設・清掃日</th><th>担当</th><th>結果</th></tr></thead><tbody>
            ${log.slice(0, 30).map((j) => `<tr><td class="small">${fmtDT(j.at)}</td><td>${{ assign: '登録', unassign: '解除', update: '更新' }[j.action]}</td><td class="small">${esc(j.propertyName)}<br>${fmtDate(j.date)} ${esc(j.startTime)}</td><td class="small">${esc(j.staffName)}</td><td>${badge(j.status === 'success' ? 'assigned' : j.status === 'failed' ? 'unassigned' : 'draft', j.status === 'success' ? '成功' : j.status)}</td></tr>`).join('')}
          </tbody></table></div>
        </div>
        <div class="card">
          <h3>④ LINE 通知 <span class="sub">${ints.lineLive ? 'Messaging API 接続中' : 'モック送信（デモ）'}</span></h3>
          <ul class="small" style="margin:0;padding-left:18px;color:var(--ink-2)">
            <li>LINE 公式アカウント（Messaging API）から各スタッフへ個別 push 通知</li>
            <li>緊急募集はスタッフグループへ <b>メンション付き投稿（textV2）</b>＋各候補者へ「対応できます／難しい」ボタン</li>
            <li>ボタン押下（postback）を Webhook で受信し、<b>先着1名</b>で自動確定・本人以外の押下は無視</li>
            <li>メンションが使えない環境ではグループ通知＋個別通知の二段構えで代替</li>
          </ul>
          <div class="code mt">LINE_CHANNEL_ACCESS_TOKEN=...
LINE_CHANNEL_SECRET=...
LINE_STAFF_GROUP_ID=C...
LINE_ADMIN_USER_IDS=U...,U...
Webhook URL: ${esc(origin)}/api/webhooks/line</div>
        </div>
        <div class="card">
          <h3>割当ルール設定</h3>
          <form data-form="settings" class="form-grid">
            <div class="field"><label>緊急募集とする日数（清掃日 − 予約受付日）</label><select class="input" name="urgentThresholdDays"><option value="0" ${st.urgentThresholdDays === 0 ? 'selected' : ''}>当日のみ</option><option value="1" ${st.urgentThresholdDays === 1 ? 'selected' : ''}>前日・当日</option><option value="2" ${st.urgentThresholdDays === 2 ? 'selected' : ''}>2日前まで</option></select></div>
            <div class="field"><label>緊急募集の回答待ち時間（分）</label><input class="input" type="number" min="10" max="600" name="responseWindowMinutes" value="${st.responseWindowMinutes}" /></div>
            <label class="check full"><input type="checkbox" name="allowDoubleFallback" ${st.allowDoubleFallback ? 'checked' : ''}/> 候補者がいない場合のみ、時間的に可能なら同日2件目を例外として許可する</label>
            <div class="full row"><button class="btn primary" type="submit">保存</button></div>
          </form>
          <h3 class="mt">デモ操作</h3>
          <div class="row"><button class="btn danger" data-act="demoReset">デモデータを初期化</button><button class="btn" data-act="tick">緊急募集の期限チェック</button></div>
        </div>
      </div>
      <div class="card"><h3>イベントログ</h3><ul class="timeline">${events.map((e) => `<li class="lv-${e.level}"><span class="t">${fmtDT(e.at)}</span><span class="m"></span><span>${esc(e.message)}</span></li>`).join('')}</ul></div>
    </div>`;
  },
};

// ===========================================================================
// モーダル：予約作成・変更・メール取込・清掃詳細・スタッフ・施設
// ===========================================================================
function presetValues(kind) {
  const today = S.boot.today;
  const nextMonth = monthAdd(S.boot.month, 1);
  if (kind === 'urgent') {
    return { propertyId: 'p2', checkIn: today, checkOut: addDays(today, 1), bookedAt: `${today}T23:00`, guests: 2 };
  }
  if (kind === 'example') {
    return { propertyId: 'p3', checkIn: `${nextMonth}-12`, checkOut: `${nextMonth}-13`, bookedAt: `${nextMonth}-12T23:00`, guests: 4 };
  }
  if (kind === 'sameday') {
    return { propertyId: 'p5', checkIn: addDays(today, -1), checkOut: today, bookedAt: jstNowInput(), guests: 2 };
  }
  const ci = addDays(today, 16);
  return { propertyId: 'p4', checkIn: ci, checkOut: addDays(ci, 2), bookedAt: jstNowInput(), guests: 4 };
}

function openNewReservation(preset) {
  const v = presetValues(preset || 'normal');
  const nextMonth = monthAdd(S.boot.month, 1);
  const [, nm] = nextMonth.split('-').map(Number);
  const body = `
    <div class="presets">
      <button class="preset" type="button" data-act="applyPreset" data-preset="normal"><b>通常予約</b><span>16日後・2泊 → 自動割当</span></button>
      <button class="preset urgent" type="button" data-act="applyPreset" data-preset="urgent"><b>直前予約（今夜23時受付）</b><span>翌朝の清掃 → 緊急募集</span></button>
      <button class="preset urgent" type="button" data-act="applyPreset" data-preset="example"><b>募集要項の例</b><span>${nm}/12 23:00受付・1泊 → ${nm}/13 10時清掃</span></button>
    </div>
    <form data-form="newRes" class="form-grid">
      <div class="field"><label>施設</label><select class="input" name="propertyId">${S.boot.properties.map((p) => `<option value="${p.id}" ${p.id === v.propertyId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      <div class="field"><label>ゲスト名</label><div class="row" style="flex-wrap:nowrap"><input class="input" name="guestName" value="${esc(randomName())}" required /><button class="btn sm" type="button" data-act="randName">↻</button></div></div>
      <div class="field"><label>チェックイン</label><input class="input" type="date" name="checkIn" value="${v.checkIn}" required /></div>
      <div class="field"><label>チェックアウト（＝清掃日）</label><input class="input" type="date" name="checkOut" value="${v.checkOut}" required /></div>
      <div class="field"><label>人数</label><input class="input" type="number" min="1" max="20" name="guests" value="${v.guests}" /></div>
      <div class="field"><label>予約経路</label><select class="input" name="channel">${['Airbnb', 'Booking.com', '楽天トラベル', 'じゃらん', 'Vrbo', '直接予約'].map((c) => `<option>${c}</option>`).join('')}</select></div>
      <div class="field"><label>予約受付日時（緊急判定の基準）</label><input class="input" type="datetime-local" name="bookedAt" value="${v.bookedAt}" /></div>
      <div class="field"><label>取込経路</label><select class="input" name="source"><option value="airhost_api">AirHost API（Webhook）</option><option value="email">予約通知メール</option><option value="manual">手動登録</option></select></div>
    </form>
    <p class="small muted">登録すると、清掃予定の生成 → 割当（または緊急募集）→ AirHost 登録 → LINE 通知 → 公平性シート反映 が自動で実行されます。</p>`;
  modal.open('新規予約をシミュレート', body, `<button class="btn" data-close>閉じる</button><button class="btn primary" data-act="submitNewRes">予約を登録</button>`);
}

function applyPreset(kind) {
  const v = presetValues(kind);
  const f = $('form[data-form="newRes"]');
  f.propertyId.value = v.propertyId;
  f.checkIn.value = v.checkIn;
  f.checkOut.value = v.checkOut;
  f.bookedAt.value = v.bookedAt;
  f.guests.value = v.guests;
  f.guestName.value = randomName();
}

async function submitNewRes() {
  const f = $('form[data-form="newRes"]');
  const data = Object.fromEntries(new FormData(f));
  data.bookedAt = data.bookedAt ? jstInputToIso(data.bookedAt) : undefined;
  try {
    const out = await api('POST', '/api/reservations', data);
    showResult('予約を登録しました', out);
    renderView(true);
  } catch (e) {
    toast(esc(e.message), 'err');
  }
}

function rankingTable(ranking) {
  if (!ranking || !ranking.length) return '';
  return `<div class="table-wrap"><table class="tbl"><thead><tr><th>候補</th><th class="r">当月拘束</th><th class="r">勤務可能日</th><th class="r">割当後の負荷</th><th>判定</th></tr></thead><tbody>
    ${ranking
      .map((r, i) => `<tr><td>${i === 0 && r.eligible ? '🏆 ' : ''}${esc(r.name)}</td><td class="r num">${r.hours}h</td><td class="r num">${r.availableDays}日</td><td class="r num">${r.projected}${r.consecutive ? ' <span class="muted small">連勤</span>' : ''}</td><td>${r.eligible ? badge('assigned', r.exception ? '可（例外）' : '可') : `<span class="small muted">${esc(r.reasons.join('・'))}</span>`}</td></tr>`)
      .join('')}</tbody></table></div>`;
}

function showResult(title, out) {
  const r = out.result || {};
  const c = out.cleaning;
  const res = out.reservation;
  let html = '';
  if (res) html += `<p><b>${esc(res.guestName)} 様</b>　${esc(res.propertyName)}　${fmtDate(res.checkIn)} → ${fmtDate(res.checkOut)}（${res.nights}泊・${res.guests}名）<br><span class="small muted">予約番号 ${esc(res.code)}</span></p>`;
  const steps = (arr) => `<div class="flow" style="margin:12px 0">${arr.map(([t, d]) => `<div class="step"><b>${t}</b>${d}</div>`).join('')}</div>`;
  if (r.outcome === 'assigned') {
    const name = r.ranking?.find((x) => x.staffId === r.staffId)?.name || c?.staffName || '';
    html += `<div class="card" style="background:rgba(52,211,153,.1);border-color:rgba(52,211,153,.4);padding:14px">✅ <b>${esc(name)}</b> さんに自動割当しました${r.exception ? '（例外：同日2件目）' : ''}</div>`;
    html += steps([
      ['清掃予定', `${fmtDate(c?.date || res.checkOut)} ${c?.startTime || ''}〜 拘束${c?.hours || ''}h`],
      ['AirHost', '清掃カレンダーへ登録済'],
      ['LINE', `${esc(name)} さんへ通知済`],
      ['公平性シート', '反映済'],
    ]);
    html += `<h3 style="font-size:14px">選定理由（拘束時間ベースのスコア上位）</h3>${rankingTable(r.ranking)}`;
  } else if (r.outcome === 'recruiting') {
    html += `<div class="card" style="background:rgba(248,113,113,.12);border-color:rgba(248,113,113,.5);padding:14px">⚡ 清掃日が前日・当日のため <b>緊急募集</b> を開始しました（候補 ${r.candidates} 名）</div>`;
    html += steps([
      ['LINE グループ', '候補者をメンションして募集投稿'],
      ['個別 LINE', '「対応できます／難しい」ボタンを送信'],
      ['先着確定', '最初の承諾者で確定 → AirHost 登録'],
    ]);
    html += `<div class="row"><a class="btn danger" href="#/urgent" data-close>緊急募集の状況を見る</a><a class="btn line" href="#/notifications" data-act="lineSel" data-sel="group">LINE グループを見る</a></div>`;
  } else if (r.outcome === 'awaiting_monthly') {
    html += `<div class="card" style="padding:14px">🗓 清掃日の月はまだ月次シフトが確定していないため「月次シフト作成待ち」として登録しました。月次シフト作成時に公平性を考慮して割り当てられます。</div>`;
  } else if (r.outcome === 'unassigned') {
    html += `<div class="card" style="background:rgba(251,146,60,.12);border-color:rgba(251,146,60,.5);padding:14px">⚠ 条件を満たすスタッフがいないため未割当です。管理者へ LINE 通知しました。</div>${rankingTable(r.ranking)}`;
  } else if (r.outcome === 'kept') {
    html += `<div class="card" style="padding:14px">✅ 変更後の日程でも同じ担当者が対応可能なため、担当を維持して変更通知を送りました。</div>`;
  } else if (r.outcome === 'cancelled') {
    html += `<div class="card" style="padding:14px">🗑 清掃予定を取り消し、担当者へ LINE 通知・AirHost 登録を解除しました。</div>`;
  } else if (r.outcome === 'info_updated') {
    html += `<div class="card" style="padding:14px">予約情報を更新しました（清掃日に変更はありません）。担当者がいる場合は変更内容を通知しました。</div>`;
  }
  modal.open(title, html, `<button class="btn primary" data-close>OK</button>`, { wide: true });
}

async function openEditReservation(id) {
  const r = await api('GET', `/api/reservations/${id}`);
  const body = `<form data-form="editRes" class="form-grid" data-id="${r.id}">
    <div class="field full"><label>予約</label><div>${esc(r.code)}　<b>${esc(r.guestName)} 様</b>　${esc(r.channel)}</div></div>
    <div class="field"><label>施設</label><select class="input" name="propertyId">${S.boot.properties.map((p) => `<option value="${p.id}" ${p.id === r.propertyId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
    <div class="field"><label>人数</label><input class="input" type="number" min="1" name="guests" value="${r.guests}" /></div>
    <div class="field"><label>チェックイン</label><input class="input" type="date" name="checkIn" value="${r.checkIn}" /></div>
    <div class="field"><label>チェックアウト（＝清掃日）</label><input class="input" type="date" name="checkOut" value="${r.checkOut}" /></div>
  </form>
  <p class="small muted">清掃日・施設が変わる場合、現担当者が引き続き対応可能なら担当を維持し、不可なら担当解除の通知後に再割当（直前なら緊急募集）します。</p>
  ${r.cleaningDetail ? `<h3 style="font-size:14px">現在の清掃予定</h3>${cleaningItem(r.cleaningDetail)}` : ''}`;
  modal.open('予約変更（AirHost からの変更通知をシミュレート）', body, `<button class="btn" data-close>閉じる</button><button class="btn primary" data-act="submitEditRes">変更を反映</button>`);
}

async function submitEditRes() {
  const f = $('form[data-form="editRes"]');
  const data = Object.fromEntries(new FormData(f));
  try {
    const out = await api('PATCH', `/api/reservations/${f.dataset.id}`, data);
    showResult('予約変更を反映しました', out);
    renderView(true);
  } catch (e) {
    toast(esc(e.message), 'err');
  }
}

function confirmCancel(id) {
  modal.open(
    '予約キャンセル',
    '<p>この予約をキャンセルしますか？<br><span class="small muted">清掃予定を取消し、担当スタッフへ LINE 通知、AirHost 清掃カレンダーの登録を解除します。</span></p>',
    `<button class="btn" data-close>戻る</button><button class="btn danger" data-act="doCancel" data-id="${id}">キャンセルを反映</button>`
  );
}

async function emailSamples() {
  const list = await api('GET', '/api/reservations?status=confirmed');
  const today = S.boot.today;
  const future = list.filter((r) => r.checkOut > addDays(today, 3) && S.boot.publishedMonths.includes(r.checkOut.slice(0, 7)));
  const forChange = future.find((r) => r.nights >= 2) || future[0];
  const forCancel = future.filter((r) => r !== forChange).slice(-1)[0];
  const nm = monthAdd(S.boot.month, 1);
  const slash = (ymd) => ymd.replace(/-/g, '/');
  const nowTxt = jstNowInput().replace('T', ' ').replace(/-/g, '/');
  const pn = (r) => propById(r.propertyId)?.name;
  const samples = {
    created: {
      subject: '【AirHost】新規予約が確定しました（逗子 プールヴィラ）',
      body: `AirHost 予約通知\n\n新しい予約が確定しました。\n\n■ 予約番号: HM${String(Date.now()).slice(-8)}\n■ 物件名: 逗子 プールヴィラ\n■ ゲスト名: ${randomName()} 様\n■ チェックイン: ${slash(`${nm}-11`)}\n■ チェックアウト: ${slash(`${nm}-12`)}\n■ 宿泊人数: 5名\n■ 予約経路: Booking.com\n■ 予約日時: ${nowTxt}\n\n※本メールは送信専用です。`,
    },
  };
  if (forChange) {
    samples.updated = {
      subject: `【AirHost】予約内容が変更されました（${pn(forChange)}）`,
      body: `予約内容の変更がありました。\n\n予約番号：${forChange.code}\n物件名：${pn(forChange)}\nゲスト名：${forChange.guestName} 様\nチェックイン：${slash(forChange.checkIn)}\nチェックアウト：${slash(addDays(forChange.checkOut, -1))}\n宿泊人数：${forChange.guests}名\n予約経路：${forChange.channel}`,
    };
  }
  if (forCancel) {
    samples.cancelled = {
      subject: `【AirHost】予約がキャンセルされました（${pn(forCancel)}）`,
      body: `以下の予約がキャンセルされました。\n\n予約番号: ${forCancel.code}\n物件名: ${pn(forCancel)}\nゲスト名: ${forCancel.guestName} 様\nチェックイン: ${slash(forCancel.checkIn)}\nチェックアウト: ${slash(forCancel.checkOut)}`,
    };
  }
  return samples;
}

let SAMPLES = {};
async function openEmailImport() {
  SAMPLES = await emailSamples();
  const s = SAMPLES.created;
  const body = `
    <p class="small muted" style="margin-top:0">AirHost の予約通知メールを Gmail で受信 → Google Apps Script が本システムへ転送する想定です。サンプルを選ぶか、実際のメール本文を貼り付けてください。</p>
    <div class="row" style="margin-bottom:12px">
      <button class="btn sm" data-act="emailSample" data-kind="created">新規予約メール</button>
      ${SAMPLES.updated ? '<button class="btn sm" data-act="emailSample" data-kind="updated">変更メール</button>' : ''}
      ${SAMPLES.cancelled ? '<button class="btn sm" data-act="emailSample" data-kind="cancelled">キャンセルメール</button>' : ''}
    </div>
    <div class="field"><label>件名</label><input class="input" id="mail-subject" value="${esc(s.subject)}" /></div>
    <div class="field mt"><label>本文</label><textarea class="input" id="mail-body" rows="12">${esc(s.body)}</textarea></div>
    <div id="mail-preview" class="mt"></div>`;
  modal.open('予約通知メールの取込', body, `<button class="btn" data-close>閉じる</button><button class="btn" data-act="emailParse">解析プレビュー</button><button class="btn primary" data-act="emailIngest">取り込んで処理</button>`, { wide: true });
}

async function emailParse() {
  const out = await api('POST', '/api/email/parse', { subject: $('#mail-subject').value, body: $('#mail-body').value });
  const T = { created: '新規予約', updated: '予約変更', cancelled: 'キャンセル' };
  $('#mail-preview').innerHTML = `<div class="card" style="padding:14px">
    <div class="row">${out.ok ? badge('assigned', '解析OK') : badge('unassigned', '不足項目あり')}<b>${T[out.type] || '種別不明'}</b><span class="spacer"></span>${out.matchedProperty ? `<span class="small">施設照合: <b>${esc(out.matchedProperty.name)}</b></span>` : '<span class="small" style="color:var(--serious)">施設を照合できません</span>'}</div>
    <dl class="kv mt"><dt>予約番号</dt><dd>${esc(out.reservationCode || '—')}</dd><dt>物件名</dt><dd>${esc(out.propertyName || '—')}</dd><dt>ゲスト名</dt><dd>${esc(out.guestName || '—')}</dd><dt>宿泊</dt><dd>${esc(out.checkIn || '—')} → ${esc(out.checkOut || '—')}</dd><dt>人数</dt><dd>${esc(out.guests || '—')}</dd><dt>予約経路</dt><dd>${esc(out.channel || '—')}</dd></dl>
    ${out.missing.length ? `<p class="small" style="color:var(--serious)">不足: ${esc(out.missing.join(', '))}</p>` : ''}
  </div>`;
}

async function emailIngest() {
  try {
    const out = await api('POST', '/api/webhooks/email', { subject: $('#mail-subject').value, body: $('#mail-body').value });
    const res = out.reservation;
    const c = res.cleaning ? { ...res.cleaning, staffName: res.cleaning.staffName } : null;
    showResult('予約メールを取り込みました', { reservation: res, cleaning: c, result: out.result });
    renderView(true);
  } catch (e) {
    toast(`取込に失敗：${esc(e.message)}`, 'err');
  }
}

async function openCleaning(id) {
  const c = await api('GET', `/api/cleanings/${id}`);
  const r = c.reservation;
  const cands = c.candidates;
  const canEdit = !['cancelled', 'completed'].includes(c.status);
  const body = `
    <div class="row" style="margin-bottom:10px">${badge(c.status)}${c.mode ? `<span class="tag">${MODE[c.mode]}</span>` : ''}${c.exception ? '<span class="tag" style="color:var(--warn)">例外：同日2件目</span>' : ''}${c.airhost ? `<span class="tag">AirHost: ${c.airhost.synced ? '登録済' : esc(c.airhost.status)}</span>` : ''}</div>
    <div class="grid g2">
      <dl class="kv">
        <dt>施設</dt><dd><b>${esc(c.propertyName)}</b></dd>
        <dt>清掃日時</dt><dd class="num">${fmtDate(c.date)} ${c.startTime}〜${c.endTime}</dd>
        <dt>拘束時間</dt><dd class="num">${c.hours}h</dd>
        <dt>担当</dt><dd>${c.staffName ? esc(c.staffName) : '—'}</dd>
      </dl>
      ${r ? `<dl class="kv"><dt>予約</dt><dd class="num">${esc(r.code)}</dd><dt>ゲスト</dt><dd>${esc(r.guestName)} 様（${r.guests}名）</dd><dt>宿泊</dt><dd class="num">${fmtDate(r.checkIn)} → ${fmtDate(r.checkOut)}</dd><dt>経路</dt><dd>${esc(r.channel)}</dd></dl>` : ''}
    </div>
    <h3 style="font-size:14px;margin-top:18px">候補ランキング <span class="muted small" style="font-weight:400">（スコア＝割当後の拘束時間 ÷ 勤務可能日数、小さいほど優先）</span></h3>
    <div class="table-wrap"><table class="tbl"><thead><tr><th>スタッフ</th><th class="r">当月拘束</th><th class="r">件数</th><th class="r">勤務可能日</th><th class="r">スコア</th><th>判定</th><th></th></tr></thead><tbody>
      ${cands
        .map(
          (x) => `<tr ${x.staffId === c.staffId ? 'style="background:rgba(56,189,248,.1)"' : ''}><td class="strong">${esc(x.name)}${x.staffId === c.staffId ? ' <span class="tag">現担当</span>' : ''}</td><td class="r num">${x.hours}h</td><td class="r num">${x.count}</td><td class="r num">${x.availableDays}</td><td class="r num">${x.score}</td>
          <td>${x.eligible ? badge('assigned', x.exception ? '可（例外）' : '可') : `<span class="small muted">${esc(x.reasons.join('・'))}</span>`}</td>
          <td class="r">${canEdit && x.staffId !== c.staffId ? `<button class="btn sm ${x.eligible ? '' : 'ghost'}" data-act="assignTo" data-id="${c.id}" data-staff="${x.staffId}" data-eligible="${x.eligible}">割当</button>` : ''}</td></tr>`
        )
        .join('')}
    </tbody></table></div>
    <h3 style="font-size:14px;margin-top:18px">履歴</h3>
    <ul class="timeline">${(c.history || [])
      .slice()
      .reverse()
      .map((h) => `<li class="lv-info"><span class="t">${fmtDT(h.at)}</span><span class="m"></span><span>${esc(h.note)}</span></li>`)
      .join('')}</ul>`;
  modal.open(`清掃予定 ${esc(c.propertyName)} ${fmtDate(c.date)}`, body, canEdit ? `<button class="btn" data-close>閉じる</button><button class="btn primary" data-act="reassign" data-id="${c.id}">自動で再割当</button>` : `<button class="btn" data-close>閉じる</button>`, { wide: true });
}

async function openStaffEdit(id) {
  const month0 = S.boot.month;
  let s = { name: '', properties: [], active: true, lineUserId: '', phone: '', note: '', unavailable: [] };
  if (id) s = (await api('GET', `/api/staff?month=${month0}`)).find((x) => x.id === id);
  const dpMonth = monthAdd(month0, 1);
  const body = `<form data-form="staff" class="form-grid" data-id="${id || ''}">
    <div class="field"><label>氏名</label><input class="input" name="name" value="${esc(s.name)}" required /></div>
    <div class="field"><label>電話番号</label><input class="input" name="phone" value="${esc(s.phone)}" /></div>
    <div class="field"><label>LINE ユーザーID（連携後に自動取得）</label><input class="input" name="lineUserId" value="${esc(s.lineUserId)}" placeholder="U..." /></div>
    <div class="field"><label>状態</label><label class="check"><input type="checkbox" name="active" ${s.active ? 'checked' : ''}/> 稼働中</label></div>
    <div class="field full"><label>対応可能な施設（チェックなし＝対応不可施設）</label><div class="row">${S.boot.properties.map((p) => `<label class="check"><input type="checkbox" name="prop" value="${p.id}" ${s.properties.includes(p.id) ? 'checked' : ''}/>${esc(p.name)}</label>`).join('')}</div></div>
  </form>
  ${
    id
      ? `<div class="mt"><div class="row"><h3 style="font-size:14px;margin:0">勤務不可日</h3><span class="spacer"></span><select class="input" style="width:auto" id="dp-month">${monthOptions(dpMonth, 0, 2)}</select></div>
         <p class="small muted">日付をタップして不可日を切替（緑の下線＝その日に割当あり）。確定シフトと重なる場合は管理者へ通知されます。</p>
         <div id="dp" data-staff="${id}"></div></div>`
      : ''
  }`;
  modal.open(id ? `スタッフ編集：${esc(s.name)}` : 'スタッフを追加', body, `<button class="btn" data-close>閉じる</button><button class="btn primary" data-act="saveStaff">保存</button>`, { wide: Boolean(id) });
  if (id) {
    S.dp = { staffId: id, month: dpMonth, dates: new Set(s.unavailable.filter((x) => x.startsWith(dpMonth))), all: s.unavailable };
    await renderDatePicker();
  }
}

async function renderDatePicker() {
  const { staffId, month } = S.dp;
  const cl = await api('GET', `/api/cleanings?month=${month}&staffId=${staffId}`);
  const has = new Set(cl.map((c) => c.date));
  const dates = monthDates(month);
  const pad = weekdayIdx(dates[0]);
  $('#dp').innerHTML = `<div class="dpick">${[...WD].map((w) => `<div class="wd">${w}</div>`).join('')}${'<span></span>'.repeat(pad)}${dates
    .map((dd) => `<button type="button" class="${S.dp.dates.has(dd) ? 'on' : ''} ${has.has(dd) ? 'has' : ''}" data-act="dpToggle" data-date="${dd}">${Number(dd.slice(8))}</button>`)
    .join('')}</div>`;
}

async function saveStaff() {
  const f = $('form[data-form="staff"]');
  const data = {
    name: f.name.value.trim(),
    phone: f.phone.value.trim(),
    lineUserId: f.lineUserId.value.trim(),
    active: f.active.checked,
    properties: $$('input[name="prop"]:checked', f).map((x) => x.value),
  };
  try {
    if (f.dataset.id) {
      await api('PATCH', `/api/staff/${f.dataset.id}`, data);
      if (S.dp) {
        const out = await api('PUT', `/api/staff/${f.dataset.id}/unavailable`, { month: S.dp.month, dates: [...S.dp.dates] });
        if (out.conflicts.length) toast(`⚠ 確定シフトと重なる不可日が ${out.conflicts.length} 件あります（管理者へ通知済）`, 'warn', 6000);
      }
    } else {
      await api('POST', '/api/staff', data);
    }
    await refreshBoot();
    modal.close();
    toast('保存しました');
    renderView(true);
  } catch (e) {
    toast(esc(e.message), 'err');
  }
}

async function openPropEdit(id) {
  const p = id ? S.boot.properties.find((x) => x.id === id) : { name: '', area: '', address: '', capacity: 6, cleaningHours: 3, travelHours: 0.5, checkoutTime: '10:00', checkinTime: '16:00', airhostListingId: '' };
  const body = `<form data-form="prop" class="form-grid" data-id="${id || ''}">
    <div class="field"><label>施設名</label><input class="input" name="name" value="${esc(p.name)}" required /></div>
    <div class="field"><label>エリア（短縮名）</label><input class="input" name="area" value="${esc(p.area)}" /></div>
    <div class="field full"><label>住所</label><input class="input" name="address" value="${esc(p.address)}" /></div>
    <div class="field"><label>清掃時間（h）</label><input class="input" type="number" step="0.5" min="0.5" name="cleaningHours" value="${p.cleaningHours}" /></div>
    <div class="field"><label>移動時間（h）</label><input class="input" type="number" step="0.25" min="0" name="travelHours" value="${p.travelHours}" /></div>
    <div class="field"><label>チェックアウト</label><input class="input" type="time" name="checkoutTime" value="${p.checkoutTime}" /></div>
    <div class="field"><label>チェックイン</label><input class="input" type="time" name="checkinTime" value="${p.checkinTime}" /></div>
    <div class="field"><label>定員</label><input class="input" type="number" min="1" name="capacity" value="${p.capacity}" /></div>
    <div class="field"><label>AirHost リスティングID</label><input class="input" name="airhostListingId" value="${esc(p.airhostListingId)}" /></div>
  </form><p class="small muted">拘束時間（清掃＋移動）が公平性計算の単位になります。${id ? '' : '新しい施設には未使用の写真が自動で割り当てられます。'}</p>`;
  modal.open(id ? '施設を編集' : '施設を追加', body, `<button class="btn" data-close>閉じる</button><button class="btn primary" data-act="saveProp">保存</button>`);
}

async function saveProp() {
  const f = $('form[data-form="prop"]');
  const data = Object.fromEntries(new FormData(f));
  try {
    await api(f.dataset.id ? 'PATCH' : 'POST', f.dataset.id ? `/api/properties/${f.dataset.id}` : '/api/properties', data);
    await refreshBoot();
    modal.close();
    toast('保存しました');
    renderView(true);
  } catch (e) {
    toast(esc(e.message), 'err');
  }
}

// ===========================================================================
// アクション（イベント委譲）
// ===========================================================================
const RESPOND_MSG = {
  filled: '✅ 担当が確定しました（AirHost 登録・全員へ決定通知済）',
  already_filled: 'すでに他のスタッフで確定しています',
  declined: '辞退を記録しました',
  closed: 'この募集は終了しています',
  not_eligible: '同日に別の清掃があるため確定できませんでした',
};

const ACTIONS = {
  newRes: (el) => openNewReservation(el.dataset.preset),
  applyPreset: (el) => applyPreset(el.dataset.preset),
  randName: () => ($('form[data-form="newRes"]').guestName.value = randomName()),
  submitNewRes,
  editRes: (el) => openEditReservation(el.dataset.id),
  submitEditRes,
  cancelRes: (el) => confirmCancel(el.dataset.id),
  async doCancel(el) {
    try {
      const out = await api('POST', `/api/reservations/${el.dataset.id}/cancel`);
      showResult('キャンセルを反映しました', out);
      renderView(true);
    } catch (e) {
      toast(esc(e.message), 'err');
    }
  },
  emailImport: openEmailImport,
  emailSample(el) {
    const s = SAMPLES[el.dataset.kind];
    $('#mail-subject').value = s.subject;
    $('#mail-body').value = s.body;
    $('#mail-preview').innerHTML = '';
  },
  emailParse,
  emailIngest,
  cleaning: (el) => openCleaning(el.dataset.id),
  async assignTo(el) {
    const eligible = el.dataset.eligible === 'true';
    if (!eligible && !confirm('条件外のスタッフです（勤務不可日・対応不可施設・同日重複など）。強制的に割り当てますか？')) return;
    try {
      await api('POST', `/api/cleanings/${el.dataset.id}/assign`, { staffId: el.dataset.staff, force: !eligible });
      toast('担当を変更しました（AirHost 更新・LINE 通知済）');
      modal.close();
      renderView(true);
    } catch (e) {
      toast(esc(e.message), 'err');
    }
  },
  async reassign(el) {
    try {
      const out = await api('POST', `/api/cleanings/${el.dataset.id}/reassign`);
      modal.close();
      showResult('再割当しました', { cleaning: out.cleaning, result: out.result });
      renderView(true);
    } catch (e) {
      toast(esc(e.message), 'err');
    }
  },
  calMode(el) {
    S.calMode = el.dataset.mode;
    renderView();
  },
  async urgRespond(el) {
    try {
      const out = await api('POST', `/api/urgent/${el.dataset.id}/respond`, { staffId: el.dataset.staff, answer: el.dataset.answer });
      toast(RESPOND_MSG[out.result] || out.result, out.result === 'filled' ? 'ok' : 'warn');
      renderView(true);
      updateBadge();
    } catch (e) {
      toast(esc(e.message), 'err');
    }
  },
  async urgEscalate(el) {
    await api('POST', `/api/urgent/${el.dataset.id}/escalate`);
    toast('管理者へエスカレーションし、未回答者へ再送しました', 'warn');
    renderView(true);
  },
  async tick() {
    const out = await api('POST', '/api/demo/tick');
    toast(out.escalated ? `${out.escalated} 件をエスカレーションしました` : '期限切れの募集はありません', out.escalated ? 'warn' : 'ok');
    renderView(true);
  },
  async lineAnswer(el) {
    try {
      const out = await api('POST', `/api/respond/${el.dataset.token}`, { answer: el.dataset.answer });
      toast(RESPOND_MSG[out.result] || out.result, out.result === 'filled' ? 'ok' : 'warn');
      renderView(true);
      updateBadge();
    } catch (e) {
      toast(esc(e.message), 'err');
    }
  },
  lineSel(el, ev) {
    S.lineSel = el.dataset.sel;
    modal.close();
    if (S.view === 'notifications') {
      ev.preventDefault();
      renderView(true);
    }
  },
  async mGenerate(el) {
    try {
      const out = await api('POST', `/api/monthly/${el.dataset.month}/generate`);
      toast(`シフト案を作成：割当 ${out.assigned} 件・未割当 ${out.unassigned} 件（公平性スコア ${out.fairness.score}）`);
      await refreshBoot();
      renderView(true);
    } catch (e) {
      toast(esc(e.message), 'err');
    }
  },
  async mPublish(el) {
    if (!confirm(`${monthLabel(el.dataset.month)} のシフトを確定し、AirHost 登録と LINE 配信を行います。よろしいですか？`)) return;
    try {
      const out = await api('POST', `/api/monthly/${el.dataset.month}/publish`);
      toast(`確定しました：${out.published} 件・${out.staff} 名へ LINE 配信`);
      await refreshBoot();
      renderView(true);
    } catch (e) {
      toast(esc(e.message), 'err');
    }
  },
  async sheetSync() {
    await api('POST', '/api/fairness/sync', { month: S.fairMonth });
    toast('公平性管理シートへ同期しました');
    renderView(true);
  },
  staffEdit: (el) => openStaffEdit(el.dataset.id),
  saveStaff,
  dpToggle(el) {
    const dd = el.dataset.date;
    if (S.dp.dates.has(dd)) S.dp.dates.delete(dd);
    else S.dp.dates.add(dd);
    el.classList.toggle('on');
  },
  propEdit: (el) => openPropEdit(el.dataset.id),
  saveProp,
  async demoReset() {
    if (!confirm('デモデータを初期状態に戻します。よろしいですか？')) return;
    await api('POST', '/api/demo/reset');
    await refreshBoot();
    toast('デモデータを初期化しました');
    renderView();
  },
};

document.addEventListener('click', (ev) => {
  const closer = ev.target.closest('[data-close]');
  const el = ev.target.closest('[data-act]');
  if (closer) {
    modal.close();
    if (!el) return; // <a href data-close> はそのまま遷移
  }
  if (!el) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  // 「LINE を見る」リンク：選択だけ更新して href で遷移
  if (el.tagName === 'A' && el.dataset.act === 'lineSel') {
    S.lineSel = el.dataset.sel;
    modal.close();
    if (S.view === 'notifications') {
      ev.preventDefault();
      renderView(true);
    }
    return;
  }
  ev.preventDefault();
  fn(el, ev);
});

document.addEventListener('change', async (ev) => {
  const el = ev.target;
  if (el.dataset.filter) {
    S.resF[el.dataset.filter] = el.value;
    renderView(true);
  } else if (el.dataset.actChange) {
    S[el.dataset.actChange] = el.value;
    renderView();
  } else if (el.id === 'dp-month' && S.dp) {
    const staff = (await api('GET', `/api/staff?month=${el.value}`)).find((x) => x.id === S.dp.staffId);
    // 月を切替える前に現在の選択を保存
    await api('PUT', `/api/staff/${S.dp.staffId}/unavailable`, { month: S.dp.month, dates: [...S.dp.dates] });
    S.dp.month = el.value;
    S.dp.dates = new Set(staff.unavailable.filter((x) => x.startsWith(el.value)));
    renderDatePicker();
  }
});

let qTimer;
document.addEventListener('input', (ev) => {
  if (ev.target.dataset.filter === 'q') {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      S.resF.q = ev.target.value;
      renderView(true).then(() => {
        const q = $('[data-filter="q"]');
        if (q) {
          q.focus();
          q.setSelectionRange(q.value.length, q.value.length);
        }
      });
    }, 300);
  }
});

document.addEventListener('submit', async (ev) => {
  const f = ev.target;
  if (f.dataset.form === 'settings') {
    ev.preventDefault();
    const fd = new FormData(f);
    await api('PATCH', '/api/settings', {
      urgentThresholdDays: Number(fd.get('urgentThresholdDays')),
      responseWindowMinutes: Number(fd.get('responseWindowMinutes')),
      allowDoubleFallback: fd.get('allowDoubleFallback') === 'on',
    });
    await refreshBoot();
    toast('設定を保存しました');
  } else if (f.dataset.form) {
    ev.preventDefault();
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && modal.isOpen) modal.close();
});

// ツールチップ
const tip = $('#tooltip');
document.addEventListener('mouseover', (ev) => {
  const el = ev.target.closest('[data-tip]');
  if (!el) return (tip.hidden = true);
  tip.innerHTML = el.dataset.tip;
  tip.hidden = false;
});
document.addEventListener('mousemove', (ev) => {
  if (tip.hidden) return;
  const x = Math.min(ev.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  const y = Math.min(ev.clientY + 14, window.innerHeight - tip.offsetHeight - 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
});

$('#menu-btn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

// ===========================================================================
// 定期更新
// ===========================================================================
async function updateBadge() {
  try {
    const list = await api('GET', '/api/urgent');
    const n = list.filter((u) => ['open', 'escalated'].includes(u.status)).length;
    const b = $('#badge-urgent');
    b.hidden = n === 0;
    b.textContent = n;
  } catch {
    /* noop */
  }
}

function tickClock() {
  $('#clock').textContent = new Date().toLocaleString('ja-JP', { timeZone: TZ, month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }) + '（JST）';
  $$('[data-deadline]').forEach((el) => (el.textContent = relTime(el.dataset.deadline)));
}

setInterval(tickClock, 1000);
setInterval(() => {
  updateBadge();
  const active = document.activeElement;
  const typing = active && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName);
  if (!modal.isOpen && !typing && ['dashboard', 'urgent', 'notifications'].includes(S.view)) renderView(true);
}, 10000);

(async function init() {
  await refreshBoot();
  tickClock();
  updateBadge();
  window.addEventListener('hashchange', go);
  go();
})();
