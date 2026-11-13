'use strict';
// デモデータ生成
// 実際の業務フロー（workflow.js）を「過去の時刻」で順番に再生して作るため、
// 予約・割当・AirHost 同期ログ・LINE 通知・イベントがすべて整合した状態になる。
//
//   当月・翌月 : 月次シフト確定済み（確定後の新規予約は自動割当）
//   翌々月     : 月次シフト未作成（勤務不可日の提出受付中）
//   緊急募集   : 過去に充足した例 1 件 ＋ 現在募集中の例 1 件

const { emptyState } = require('./db');
const d = require('./dates');

const PROPERTIES = [
  { id: 'p1', name: '葉山 シーサイドヴィラ', area: '葉山', address: '神奈川県三浦郡葉山町一色', capacity: 8, cleaningHours: 3.0, travelHours: 0.5, checkoutTime: '10:00', checkinTime: '16:00', airhostListingId: 'AH-L-10231', image: '/img/prop-hayama.jpg', color: '#3b82f6' },
  { id: 'p2', name: '鎌倉 フォレストハウス', area: '鎌倉', address: '神奈川県鎌倉市二階堂', capacity: 6, cleaningHours: 2.5, travelHours: 0.5, checkoutTime: '10:00', checkinTime: '15:00', airhostListingId: 'AH-L-10232', image: '/img/prop-kamakura.jpg', color: '#10b981' },
  { id: 'p3', name: '逗子 プールヴィラ', area: '逗子', address: '神奈川県逗子市新宿', capacity: 10, cleaningHours: 3.5, travelHours: 0.5, checkoutTime: '10:00', checkinTime: '16:00', airhostListingId: 'AH-L-10233', image: '/img/prop-zushi.jpg', color: '#f59e0b' },
  { id: 'p4', name: '熱海 オーシャンテラス', area: '熱海', address: '静岡県熱海市伊豆山', capacity: 8, cleaningHours: 3.0, travelHours: 1.0, checkoutTime: '10:00', checkinTime: '15:00', airhostListingId: 'AH-L-10234', image: '/img/prop-atami.jpg', color: '#ec4899' },
  { id: 'p5', name: '真鶴 ホワイトレジデンス', area: '真鶴', address: '神奈川県足柄下郡真鶴町', capacity: 6, cleaningHours: 2.5, travelHours: 1.0, checkoutTime: '11:00', checkinTime: '16:00', airhostListingId: 'AH-L-10235', image: '/img/prop-manazuru.jpg', color: '#8b5cf6' },
];

/** 追加施設用の未使用画像（同じ画像を 2 回使わない） */
const SPARE_IMAGES = ['/img/prop-spare-1.jpg', '/img/prop-spare-2.jpg', '/img/prop-spare-3.jpg'];

const STAFF = [
  ['佐藤 美咲', ['p1', 'p2', 'p3']],
  ['鈴木 健太', ['p1', 'p2', 'p3', 'p4', 'p5']],
  ['高橋 由美子', ['p1', 'p2', 'p3']],
  ['田中 翔', ['p4', 'p5']],
  ['伊藤 さくら', ['p1', 'p3']],
  ['渡辺 真理子', ['p1', 'p2', 'p3']],
  ['山本 大輔', ['p3', 'p4', 'p5']],
  ['中村 恵', ['p1', 'p2']],
  ['小林 拓海', ['p1', 'p2', 'p3', 'p4', 'p5']],
  ['加藤 千尋', ['p4', 'p5']],
  ['吉田 陽子', ['p2', 'p3']],
  ['山田 隆', ['p1', 'p3', 'p4']],
  ['佐々木 舞', ['p4', 'p5']],
  ['松本 浩二', ['p1', 'p2', 'p3']],
];

const ADMINS = [
  { id: 'ad1', name: '井上 直樹', role: 'オーナー' },
  { id: 'ad2', name: '森 香織', role: '運営マネージャー' },
  { id: 'ad3', name: '石田 亮', role: '運営スタッフ' },
];

const SURNAMES = ['山口', '森田', '池田', '橋本', '阿部', '石川', '前田', '藤田', '小川', '岡田', '後藤', '長谷川', '村上', '近藤', '石井', '坂本', '遠藤', '青木', '藤井', '西村', '福田', '太田', '三浦', '藤原', '岡本', '松田', '中川', '中野', '原田', '小野', '竹内', '金子', '和田', '上田', '平野', '久保', '大野', '武田', '野口', '菊地'];
const GIVEN = ['翔太', '陽菜', '結衣', '蓮', '大翔', '葵', '悠真', '美桜', '健一', '直美', '誠', '由紀', '拓也', '真由美', '和也', '理恵', '颯太', '芽依', '隆之', '智子', '修', '愛', '浩', '彩花', '湊', '凛', '樹', '紬', '大輝', '千夏'];
const CHANNELS = ['Airbnb', 'Airbnb', 'Airbnb', 'Booking.com', 'Booking.com', '楽天トラベル', 'じゃらん', 'Vrbo', '直接予約'];

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildSeed(nowMs = Date.now()) {
  // workflow は db.js を経由するため遅延 require（循環参照回避）
  const wf = require('./services/workflow');

  const db = emptyState();
  db.meta.seeding = true;
  const rand = mulberry32(20261113);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const randint = (a, b) => a + Math.floor(rand() * (b - a + 1));

  const today = d.jstDate(nowMs);
  const M0 = d.monthOf(today);
  const M1 = d.addMonths(M0, 1);
  const M2 = d.addMonths(M0, 2);
  const Mprev = d.addMonths(M0, -1);

  db.settings = { urgentThresholdDays: 1, responseWindowMinutes: 60, allowDoubleFallback: true };
  db.admins = ADMINS;
  db.properties = PROPERTIES.map((p) => ({ ...p, active: true }));
  db.spareImages = [...SPARE_IMAGES];
  db.staff = STAFF.map(([name, props], i) => ({
    id: `st${String(i + 1).padStart(2, '0')}`,
    name,
    properties: props,
    active: name !== '松本 浩二', // 休止中スタッフの例
    lineUserId: `demo_line_${i + 1}`,
    lineLinked: i !== 12,
    phone: `090-${String(1200 + i * 37).padStart(4, '0')}-${String(3400 + i * 53).slice(-4)}`,
    note: '',
    unavailable: [],
  }));

  // --- 勤務不可日（翌々月は一部スタッフのみ提出済み）
  for (const [mi, month] of [M0, M1, M2].entries()) {
    db.submissions[month] = {};
    const prevMonth = d.addMonths(month, -1);
    for (const [si, s] of db.staff.entries()) {
      if (mi === 2 && si % 3 === 2) continue; // 未提出
      const dates = new Set();
      const n = randint(3, 8);
      const all = d.monthDates(month);
      while (dates.size < n) dates.add(pick(all));
      s.unavailable.push(...dates);
      const submittedDay = Math.min(randint(3, 19), mi === 2 ? Math.max(1, Number(today.slice(8)) - 1) : 19);
      const submitted = new Date(d.jstToIso(`${prevMonth}-${String(submittedDay).padStart(2, '0')}`, `${randint(8, 22)}:00`)).getTime();
      db.submissions[month][s.id] = new Date(Math.min(submitted, nowMs - 3600000)).toISOString();
    }
  }
  for (const s of db.staff) s.unavailable.sort();

  // --- 予約計画（シナリオ枠を確保してからランダム生成）
  const plans = [];
  const holds = []; // ランダム予約を入れない枠 { propertyId, from, to }
  const scenarioA = { propertyId: 'p2', checkIn: d.addDays(today, -6), checkOut: d.addDays(today, -5), scenario: 'urgent_past' };
  const scenarioB = { propertyId: 'p1', checkIn: today, checkOut: d.addDays(today, 1), scenario: 'urgent_open' };
  holds.push({ propertyId: 'p2', from: scenarioA.checkIn, to: scenarioA.checkOut });
  holds.push({ propertyId: 'p1', from: scenarioB.checkIn, to: scenarioB.checkOut });
  // 募集要項の例「12/12 23時に 1 泊予約 → 12/13 10時清掃」を試せるよう、翌月 12〜13 日の逗子を空けておく
  holds.push({ propertyId: 'p3', from: `${M1}-11`, to: `${M1}-14` });

  const lastDay = `${M2}-${String(d.daysInMonth(M2)).padStart(2, '0')}`;
  const guestName = () => `${pick(SURNAMES)} ${pick(GIVEN)}`;

  for (const p of PROPERTIES) {
    let cursor = d.addDays(`${M0}-01`, -randint(2, 5));
    while (true) {
      const sparse = d.monthOf(cursor) === M2;
      const gap = sparse ? randint(1, 6) : pick([0, 0, 1, 1, 1, 2, 3]);
      const checkIn = d.addDays(cursor, gap);
      const nights = pick([1, 1, 2, 2, 2, 3, 3, 4, 5]);
      const checkOut = d.addDays(checkIn, nights);
      if (checkOut > lastDay) break;
      const hold = holds.find((h) => h.propertyId === p.id && checkIn < h.to && h.from < checkOut);
      if (hold) {
        cursor = hold.to;
        continue;
      }
      cursor = checkOut;
      if (checkOut < `${M0}-01`) continue;
      plans.push({ propertyId: p.id, checkIn, checkOut });
    }
  }

  // --- タイムライン（予約受付・月次シフト・変更・キャンセル・緊急募集）を時系列で再生
  const timeline = [];
  for (const plan of plans) {
    const lead = randint(3, 70);
    const computed = new Date(d.jstToIso(d.addDays(plan.checkIn, -lead), `${String(randint(7, 23)).padStart(2, '0')}:${pick(['00', '15', '30', '45'])}`)).getTime();
    const t = computed < nowMs - 3600000 ? computed : nowMs - randint(1, 96) * 3600000 - randint(0, 59) * 60000;
    timeline.push({ t, run: (now) => book(plan, now) });
  }

  function book(plan, now) {
    try {
      return wf.createReservation(
        db,
        { propertyId: plan.propertyId, checkIn: plan.checkIn, checkOut: plan.checkOut, guestName: guestName(), guests: randint(2, PROPERTIES.find((x) => x.id === plan.propertyId).capacity), channel: pick(CHANNELS), bookedAt: now },
        { now, source: pick(['airhost_api', 'airhost_api', 'email']) }
      );
    } catch {
      return null;
    }
  }

  // 月次シフト（当月：前月21日作成・確定 / 翌月：今月20日 or 3日前のいずれか早い方）
  const m0Gen = new Date(d.jstToIso(`${Mprev}-21`, '10:00')).getTime();
  timeline.push({ t: m0Gen, run: (now) => wf.generateMonth(db, M0, { now }) });
  timeline.push({ t: m0Gen + 3600000, run: (now) => wf.publishMonth(db, M0, { now }) });
  const m1Gen = Math.min(new Date(d.jstToIso(`${M0}-20`, '10:00')).getTime(), nowMs - 3 * 86400000);
  timeline.push({ t: m1Gen, run: (now) => wf.generateMonth(db, M1, { now }) });
  timeline.push({ t: m1Gen + 3600000, run: (now) => wf.publishMonth(db, M1, { now }) });

  // 緊急募集（過去）：前夜 22:40 に 1 泊予約 → 2 名回答、1 名が承諾して確定
  const tA = new Date(d.jstToIso(scenarioA.checkIn, '22:40')).getTime();
  if (tA < nowMs) {
    timeline.push({
      t: tA,
      run: (now) => {
        const res = book(scenarioA, now);
        if (!res || !res.cleaning.urgentRequestId) return;
        const req = db.urgentRequests.find((u) => u.id === res.cleaning.urgentRequestId);
        if (req.candidates[1]) wf.respondUrgent(db, req.candidates[1].token, 'decline', { now: now + 6 * 60000 });
        if (req.candidates[0]) wf.respondUrgent(db, req.candidates[0].token, 'accept', { now: now + 11 * 60000 });
      },
    });
  }

  // 予約キャンセル・変更の例（2 日前 / 1 日前）
  timeline.push({
    t: nowMs - 2 * 86400000 - 3 * 3600000,
    run: (now) => {
      const r = db.reservations.find((x) => x.status === 'confirmed' && x.propertyId === 'p4' && d.monthOf(x.checkOut) === M1);
      if (r) wf.cancelReservation(db, r.id, { now, source: 'airhost_api' });
    },
  });
  timeline.push({
    t: nowMs - 86400000 - 5 * 3600000,
    run: (now) => {
      const list = db.reservations.filter((x) => x.status === 'confirmed' && x.propertyId === 'p2' && d.monthOf(x.checkOut) === M1);
      for (const r of list) {
        try {
          wf.updateReservation(db, r.id, { checkOut: d.addDays(r.checkOut, 1), guests: r.guests + 1 }, { now, source: 'email' });
          return;
        } catch {
          /* 次の予約で再試行 */
        }
      }
    },
  });

  // 緊急募集（現在募集中）：25 分前に今夜の 1 泊予約、1 名が辞退済み
  timeline.push({
    t: nowMs - 25 * 60000,
    run: (now) => {
      const res = book(scenarioB, now);
      if (!res || !res.cleaning.urgentRequestId) return;
      const req = db.urgentRequests.find((u) => u.id === res.cleaning.urgentRequestId);
      const last = req.candidates[req.candidates.length - 1];
      if (req.candidates.length > 1) wf.respondUrgent(db, last.token, 'decline', { now: now + 13 * 60000 });
    },
  });

  timeline.sort((a, b) => a.t - b.t);
  for (const ev of timeline) ev.run(ev.t);

  // 過去日の清掃は完了扱い
  for (const c of db.cleanings) {
    if (c.date < today && c.status === 'assigned') c.status = 'completed';
  }

  delete db.meta.seeding;
  db.meta.seededAt = new Date(nowMs).toISOString();
  return db;
}

module.exports = { buildSeed, PROPERTIES, STAFF, SPARE_IMAGES };
