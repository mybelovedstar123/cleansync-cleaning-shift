'use strict';
// 予約 → 清掃予定 → 割当 → AirHost 登録 → LINE 通知 の業務フロー本体
//
// ① 新規予約の自動検知      : createReservation()（API / メール / 手動 のいずれの入口からも同じ処理）
// ② 清掃スタッフの自動割当  : scheduleCleaning() → engine.pickStaff()
// ③ AirHost への自動登録    : airhost.register()
// ④ LINE への自動通知       : line.send()
// ⑤ 直前予約の緊急募集      : openUrgent() / respondUrgent() / checkTimeouts()
// ⑥ 予約変更・キャンセル    : updateReservation() / cancelReservation()
// （＋）月次シフト           : generateMonth() / publishMonth()

const crypto = require('crypto');
const { nextId } = require('../db');
const d = require('../dates');
const engine = require('../engine/assign');
const line = require('../integrations/line');
const airhost = require('../integrations/airhost');
const sheets = require('../integrations/sheets');
const { logEvent } = require('../events');

class WorkflowError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// 共通ヘルパー
// ---------------------------------------------------------------------------

function settings(db) {
  return {
    urgentThresholdDays: 1, // 清掃日が予約受付日の「前日・当日」以内なら緊急募集
    responseWindowMinutes: 60, // 緊急募集の回答待ち時間（超過で管理者へエスカレーション）
    allowDoubleFallback: true, // 候補ゼロ時のみ同日 2 件目を例外許容
    ...db.settings,
  };
}

function prop(db, id) {
  const p = engine.propertyById(db, id);
  if (!p) throw new WorkflowError(`施設が見つかりません: ${id}`, 404);
  return p;
}

function staffName(db, id) {
  const s = id && engine.staffById(db, id);
  return s ? s.name : '';
}

function history(entity, action, note, now, extra = {}) {
  entity.history = entity.history || [];
  entity.history.push({ at: new Date(now).toISOString(), action, note, ...extra });
}

function isPublished(db, month) {
  return db.publishedMonths.includes(month);
}

function cleaningSummary(db, c) {
  const p = prop(db, c.propertyId);
  const r = db.reservations.find((x) => x.id === c.reservationId);
  return [
    `施設: ${p.name}`,
    `日時: ${d.formatJa(c.date)} ${c.startTime}〜${c.endTime}`,
    `拘束時間: ${c.hours}時間（清掃${p.cleaningHours}h＋移動${p.travelHours}h）`,
    r ? `ゲスト: ${r.guests}名 / 次回チェックイン ${p.checkinTime}` : null,
    r ? `予約番号: ${r.code}` : null,
    p.address ? `住所: ${p.address}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function syncSheet(db, date, reason, now) {
  sheets.sync(db, d.monthOf(date), reason, now);
}

function buildCleaning(db, reservation, now) {
  const p = prop(db, reservation.propertyId);
  const hours = engine.restraintHours(p);
  return {
    id: nextId(db, 'cl'),
    reservationId: reservation.id,
    propertyId: p.id,
    date: reservation.checkOut,
    startTime: p.checkoutTime,
    endTime: d.addHoursToTime(p.checkoutTime, hours),
    hours,
    staffId: null,
    status: 'pending',
    mode: null,
    locked: false,
    exception: false,
    urgentRequestId: null,
    airhost: null,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    history: [],
  };
}

// ---------------------------------------------------------------------------
// 割当・解除（AirHost 登録 + LINE 通知 + 公平性シート反映を必ずセットで行う）
// ---------------------------------------------------------------------------

function assignCleaning(db, cleaning, staffId, { mode, now, exception = false, notify = true, note = '' }) {
  cleaning.staffId = staffId;
  cleaning.status = 'assigned';
  cleaning.mode = mode;
  cleaning.exception = exception;
  cleaning.locked = true;
  cleaning.updatedAt = new Date(now).toISOString();
  history(cleaning, 'assign', note || `${staffName(db, staffId)} を割当（${modeLabel(mode)}）`, now, { staffId });

  airhost.register(db, cleaning, 'assign', now);

  if (notify) {
    line.send(
      db,
      {
        to: { type: 'staff', staffId },
        category: 'assign',
        title: mode === 'urgent' ? '【担当確定】緊急清掃のご対応ありがとうございます' : '【清掃担当のお知らせ】新しい清掃が割り当てられました',
        text: cleaningSummary(db, cleaning) + (exception ? '\n※同日2件目のため、移動時間にご注意ください' : ''),
        refs: { cleaningId: cleaning.id },
      },
      now
    );
  }
  syncSheet(db, cleaning.date, `割当: ${staffName(db, staffId)}`, now);
  logEvent(
    db,
    {
      type: 'assign',
      level: exception ? 'warning' : 'success',
      message: `${prop(db, cleaning.propertyId).name} ${d.formatJa(cleaning.date)} → ${staffName(db, staffId)}（${modeLabel(mode)}${
        exception ? '・例外: 同日2件目' : ''
      }）`,
      refs: { cleaningId: cleaning.id, staffId },
    },
    now
  );
}

function unassignCleaning(db, cleaning, { now, reason, notifyText }) {
  const prevStaffId = cleaning.staffId;
  if (!prevStaffId) return null;
  cleaning.prevStaffName = staffName(db, prevStaffId);
  airhost.register(db, cleaning, 'unassign', now);
  cleaning.staffId = null;
  cleaning.updatedAt = new Date(now).toISOString();
  history(cleaning, 'unassign', `${cleaning.prevStaffName} の担当を解除（${reason}）`, now, { staffId: prevStaffId });
  if (notifyText) {
    line.send(
      db,
      {
        to: { type: 'staff', staffId: prevStaffId },
        category: 'cancel',
        title: `【清掃予定の${reason}】担当が取り消されました`,
        text: notifyText,
        refs: { cleaningId: cleaning.id },
      },
      now
    );
  }
  syncSheet(db, cleaning.date, `解除: ${cleaning.prevStaffName}`, now);
  return prevStaffId;
}

function modeLabel(mode) {
  return { monthly: '月次シフト', auto: '自動割当', urgent: '緊急募集', manual: '手動' }[mode] || mode || '';
}

// ---------------------------------------------------------------------------
// 清掃予定の割当判断（通常 / 緊急 / 月次待ち）
// ---------------------------------------------------------------------------

/**
 * @param {number} bookingMs 予約（または変更）を受け付けた時刻。緊急判定の基準。
 */
function scheduleCleaning(db, cleaning, { now, bookingMs = now, reason = '新規予約' }) {
  const s = settings(db);
  const bookingDate = d.jstDate(bookingMs);
  const leadDays = d.diffDays(bookingDate, cleaning.date);

  if (leadDays <= s.urgentThresholdDays) {
    return openUrgent(db, cleaning, { now, reason: `${reason}（清掃まで${leadDays <= 0 ? '当日' : '前日'}）` });
  }

  if (!isPublished(db, d.monthOf(cleaning.date))) {
    cleaning.status = 'awaiting_monthly';
    history(cleaning, 'awaiting', `${d.monthOf(cleaning.date)} の月次シフト作成時に割当`, now);
    return { outcome: 'awaiting_monthly' };
  }

  const pick = engine.pickStaff(db, cleaning);
  if (pick.staffId && (!pick.exception || s.allowDoubleFallback)) {
    assignCleaning(db, cleaning, pick.staffId, { mode: 'auto', now, exception: pick.exception });
    return { outcome: 'assigned', staffId: pick.staffId, exception: pick.exception, ranking: pick.ranking.slice(0, 5) };
  }

  cleaning.status = 'unassigned';
  history(cleaning, 'unassigned', '条件を満たすスタッフがいません', now);
  line.send(
    db,
    {
      to: { type: 'admins' },
      category: 'admin',
      title: '【要対応】自動割当できない清掃があります',
      text: `${cleaningSummary(db, cleaning)}\n\n条件を満たすスタッフがいないため、管理画面から手動で割り当ててください。`,
      refs: { cleaningId: cleaning.id },
    },
    now
  );
  logEvent(db, { type: 'unassigned', level: 'danger', message: `${prop(db, cleaning.propertyId).name} ${d.formatJa(cleaning.date)} は割当候補なし`, refs: { cleaningId: cleaning.id } }, now);
  return { outcome: 'unassigned', ranking: pick.ranking.slice(0, 5) };
}

// ---------------------------------------------------------------------------
// ① 新規予約
// ---------------------------------------------------------------------------

function validateStay(db, { propertyId, checkIn, checkOut }, excludeId) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn || '') || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut || '')) {
    throw new WorkflowError('チェックイン日・チェックアウト日を正しく入力してください');
  }
  if (d.diffDays(checkIn, checkOut) < 1) throw new WorkflowError('チェックアウト日はチェックイン日の翌日以降にしてください');
  prop(db, propertyId);
  const clash = db.reservations.find(
    (r) => r.id !== excludeId && r.status === 'confirmed' && r.propertyId === propertyId && r.checkIn < checkOut && checkIn < r.checkOut
  );
  if (clash) throw new WorkflowError(`同じ施設に重複する予約があります（${clash.code} ${clash.guestName} 様 ${clash.checkIn}〜${clash.checkOut}）`, 409);
}

function newCode(db) {
  return `HM${String(26000000 + db.meta.seq * 7 + 13).slice(-8)}`;
}

/**
 * @param {{propertyId, guestName, guests, checkIn, checkOut, channel, code?, bookedAt?}} input
 */
function createReservation(db, input, { now = Date.now(), source = 'manual' } = {}) {
  if (input.code && db.reservations.some((r) => r.code === input.code)) {
    throw new WorkflowError(`予約番号 ${input.code} は登録済みです`, 409);
  }
  validateStay(db, input);
  const today = d.jstDate(now);
  if (input.checkOut < today) throw new WorkflowError('チェックアウト日が過去の予約は登録できません');

  const bookedAtIso = input.bookedAt ? new Date(input.bookedAt).toISOString() : new Date(now).toISOString();
  const r = {
    id: nextId(db, 'rs'),
    code: input.code || newCode(db),
    propertyId: input.propertyId,
    guestName: String(input.guestName || '').trim() || 'ゲスト',
    guests: Number(input.guests) || 2,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    nights: d.diffDays(input.checkIn, input.checkOut),
    channel: input.channel || 'Airbnb',
    status: 'confirmed',
    bookedAt: bookedAtIso,
    source,
    cleaningId: null,
    createdAt: new Date(now).toISOString(),
    history: [],
  };
  history(r, 'created', `予約受付（${sourceLabel(source)}）`, now);
  db.reservations.push(r);

  const c = buildCleaning(db, r, now);
  r.cleaningId = c.id;
  db.cleanings.push(c);

  logEvent(
    db,
    {
      type: 'reservation',
      message: `新規予約 ${r.code}：${prop(db, r.propertyId).name} ${r.guestName} 様（${r.checkIn}〜${r.checkOut}・${sourceLabel(source)}）`,
      refs: { reservationId: r.id },
    },
    now
  );

  const result = scheduleCleaning(db, c, { now, bookingMs: new Date(bookedAtIso).getTime() });
  return { reservation: r, cleaning: c, result };
}

function sourceLabel(source) {
  return { airhost_api: 'AirHost API', email: '予約通知メール', manual: '手動登録', seed: '既存予約', ical: 'iCal' }[source] || source;
}

// ---------------------------------------------------------------------------
// ⑥ 予約変更・キャンセル
// ---------------------------------------------------------------------------

function findReservation(db, idOrCode) {
  const r = db.reservations.find((x) => x.id === idOrCode || x.code === idOrCode);
  if (!r) throw new WorkflowError(`予約が見つかりません: ${idOrCode}`, 404);
  return r;
}

function closeUrgentFor(db, cleaning, now, why) {
  if (!cleaning.urgentRequestId) return;
  const req = db.urgentRequests.find((u) => u.id === cleaning.urgentRequestId);
  if (req && (req.status === 'open' || req.status === 'escalated')) {
    req.status = 'cancelled';
    req.closedAt = new Date(now).toISOString();
    req.closeReason = why;
    line.send(
      db,
      {
        to: { type: 'group' },
        category: 'urgent_closed',
        title: '【緊急募集 終了】',
        text: `${prop(db, cleaning.propertyId).name} ${d.formatJa(cleaning.date)} の募集は${why}のため終了しました。ご協力ありがとうございました。`,
        refs: { urgentRequestId: req.id },
      },
      now
    );
  }
}

function updateReservation(db, idOrCode, changes, { now = Date.now(), source = 'manual' } = {}) {
  const r = findReservation(db, idOrCode);
  if (r.status === 'cancelled') throw new WorkflowError('キャンセル済みの予約は変更できません');
  const next = {
    propertyId: changes.propertyId || r.propertyId,
    checkIn: changes.checkIn || r.checkIn,
    checkOut: changes.checkOut || r.checkOut,
  };
  validateStay(db, next, r.id);

  const before = { ...r };
  if (changes.guestName) r.guestName = String(changes.guestName).trim();
  if (changes.guests) r.guests = Number(changes.guests);
  if (changes.channel) r.channel = changes.channel;
  Object.assign(r, next);
  r.nights = d.diffDays(r.checkIn, r.checkOut);

  const diffs = [];
  if (before.propertyId !== r.propertyId) diffs.push(`施設 ${prop(db, before.propertyId).name}→${prop(db, r.propertyId).name}`);
  if (before.checkIn !== r.checkIn) diffs.push(`チェックイン ${before.checkIn}→${r.checkIn}`);
  if (before.checkOut !== r.checkOut) diffs.push(`チェックアウト ${before.checkOut}→${r.checkOut}`);
  if (before.guests !== r.guests) diffs.push(`人数 ${before.guests}→${r.guests}名`);
  if (before.guestName !== r.guestName) diffs.push(`ゲスト名 ${before.guestName}→${r.guestName}`);
  history(r, 'updated', diffs.join(' / ') || '変更なし', now);
  logEvent(db, { type: 'reservation_update', level: 'warning', message: `予約変更 ${r.code}：${diffs.join(' / ') || '変更なし'}（${sourceLabel(source)}）`, refs: { reservationId: r.id } }, now);

  const c = db.cleanings.find((x) => x.id === r.cleaningId);
  const cleaningMoved = c && (c.date !== r.checkOut || c.propertyId !== r.propertyId);
  let result = { outcome: 'info_updated' };

  if (c && cleaningMoved) {
    const oldDate = c.date;
    const oldProp = prop(db, c.propertyId).name;
    const p = prop(db, r.propertyId);
    c.date = r.checkOut;
    c.propertyId = r.propertyId;
    c.hours = engine.restraintHours(p);
    c.startTime = p.checkoutTime;
    c.endTime = d.addHoursToTime(p.checkoutTime, c.hours);
    c.exception = false;
    history(c, 'moved', `${oldProp} ${oldDate} → ${p.name} ${c.date}`, now);
    closeUrgentFor(db, c, now, '予約変更');
    c.urgentRequestId = null;

    if (c.staffId) {
      // 担当者が新しい日程・施設でも条件を満たせば維持（既存シフトを極力変えない）
      const ev = engine.evaluateCandidates(db, c).find((x) => x.staffId === c.staffId);
      if (ev && ev.eligible && isPublished(db, d.monthOf(c.date))) {
        c.updatedAt = new Date(now).toISOString();
        airhost.register(db, c, 'update', now);
        line.send(
          db,
          {
            to: { type: 'staff', staffId: c.staffId },
            category: 'change',
            title: '【清掃予定の変更】日程または施設が変更になりました',
            text: `変更前: ${oldProp} ${d.formatJa(oldDate)}\n変更後:\n${cleaningSummary(db, c)}\n\n引き続きご担当をお願いします。`,
            refs: { cleaningId: c.id },
          },
          now
        );
        syncSheet(db, c.date, '予約変更（担当維持）', now);
        if (d.monthOf(oldDate) !== d.monthOf(c.date)) syncSheet(db, oldDate, '予約変更（月跨ぎ）', now);
        logEvent(db, { type: 'change', message: `${r.code} の清掃は ${staffName(db, c.staffId)} が引き続き担当`, refs: { cleaningId: c.id } }, now);
        result = { outcome: 'kept', staffId: c.staffId };
      } else {
        unassignCleaning(db, c, {
          now,
          reason: '変更',
          notifyText: `${oldProp} ${d.formatJa(oldDate)} の清掃は予約変更により担当が外れました。\n（変更後の日程はご都合が合わないため別の方に依頼します）`,
        });
        c.status = 'pending';
        result = scheduleCleaning(db, c, { now, reason: '予約変更' });
      }
    } else {
      c.status = 'pending';
      result = scheduleCleaning(db, c, { now, reason: '予約変更' });
    }
  } else if (c && c.staffId && diffs.length > 0) {
    line.send(
      db,
      {
        to: { type: 'staff', staffId: c.staffId },
        category: 'change',
        title: '【予約内容の変更】ご担当の清掃に関する予約情報が更新されました',
        text: `${diffs.join('\n')}\n\n${cleaningSummary(db, c)}`,
        refs: { cleaningId: c.id },
      },
      now
    );
  }
  return { reservation: r, cleaning: c, result };
}

function cancelReservation(db, idOrCode, { now = Date.now(), source = 'manual' } = {}) {
  const r = findReservation(db, idOrCode);
  if (r.status === 'cancelled') return { reservation: r, result: { outcome: 'already_cancelled' } };
  r.status = 'cancelled';
  r.cancelledAt = new Date(now).toISOString();
  history(r, 'cancelled', `キャンセル（${sourceLabel(source)}）`, now);

  const c = db.cleanings.find((x) => x.id === r.cleaningId);
  if (c) {
    closeUrgentFor(db, c, now, '予約キャンセル');
    if (c.staffId) {
      unassignCleaning(db, c, {
        now,
        reason: '取消',
        notifyText: `予約キャンセルのため、下記の清掃は不要になりました。\n${cleaningSummary(db, c)}`,
      });
    }
    c.status = 'cancelled';
    c.updatedAt = new Date(now).toISOString();
    history(c, 'cancelled', '予約キャンセルにより取消', now);
  }
  logEvent(db, { type: 'cancel', level: 'warning', message: `予約キャンセル ${r.code}：${prop(db, r.propertyId).name} ${r.guestName} 様（${sourceLabel(source)}）`, refs: { reservationId: r.id } }, now);
  return { reservation: r, cleaning: c, result: { outcome: 'cancelled' } };
}

// ---------------------------------------------------------------------------
// ⑤ 緊急募集
// ---------------------------------------------------------------------------

function openUrgent(db, cleaning, { now, reason }) {
  const s = settings(db);
  const candidates = engine.urgentCandidates(db, cleaning);
  const startMs = new Date(d.jstToIso(cleaning.date, cleaning.startTime)).getTime();
  let deadline = Math.min(now + s.responseWindowMinutes * 60000, startMs - 3 * 3600000);
  if (deadline < now + 15 * 60000) deadline = now + 15 * 60000;

  const req = {
    id: nextId(db, 'ur'),
    cleaningId: cleaning.id,
    reservationId: cleaning.reservationId,
    propertyId: cleaning.propertyId,
    date: cleaning.date,
    reason,
    status: candidates.length ? 'open' : 'escalated',
    createdAt: new Date(now).toISOString(),
    deadline: new Date(deadline).toISOString(),
    candidates: candidates.map((c) => ({
      staffId: c.staffId,
      token: crypto.randomBytes(12).toString('hex'),
      exception: c.exception,
      response: null,
      respondedAt: null,
    })),
    filledBy: null,
    filledAt: null,
    escalatedAt: candidates.length ? null : new Date(now).toISOString(),
  };
  db.urgentRequests.unshift(req);
  cleaning.status = 'recruiting';
  cleaning.urgentRequestId = req.id;
  cleaning.mode = 'urgent';
  history(cleaning, 'recruiting', `緊急募集を開始（候補 ${candidates.length} 名）`, now);

  const p = prop(db, cleaning.propertyId);
  const deadlineText = d.jstDateTime(deadline).replace('T', ' ');

  if (candidates.length) {
    line.send(
      db,
      {
        to: { type: 'group' },
        category: 'urgent',
        title: `【緊急募集】${d.formatJa(cleaning.date)} ${cleaning.startTime}〜 ${p.name}`,
        text: `直前予約が入りました。対応可能な方は個別に届いたボタン、または下のリンクから回答をお願いします（先着1名で確定）。\n${cleaningSummary(
          db,
          cleaning
        )}\n回答期限: ${deadlineText}`,
        mentions: req.candidates.map((c) => c.staffId),
        refs: { urgentRequestId: req.id, cleaningId: cleaning.id },
      },
      now
    );
    for (const cand of req.candidates) {
      line.send(
        db,
        {
          to: { type: 'staff', staffId: cand.staffId },
          category: 'urgent',
          title: `【緊急】${d.formatJa(cleaning.date)} ${p.name} の清掃をお願いできますか？`,
          text: `${cleaningSummary(db, cleaning)}\n回答期限: ${deadlineText}\n先着1名で確定します。${cand.exception ? '\n※同日2件目となります' : ''}`,
          actions: [
            { label: '対応できます', kind: 'accept', token: cand.token },
            { label: '今回は難しい', kind: 'decline', token: cand.token },
            { label: '詳細を見る', kind: 'link', url: line.respondUrl(cand.token) },
          ],
          refs: { urgentRequestId: req.id, cleaningId: cleaning.id },
        },
        now
      );
    }
    logEvent(db, { type: 'urgent', level: 'danger', message: `緊急募集を開始：${p.name} ${d.formatJa(cleaning.date)}（候補 ${candidates.length} 名へ LINE 通知）`, refs: { urgentRequestId: req.id } }, now);
  } else {
    notifyAdminsEscalation(db, req, cleaning, '勤務可能なスタッフがいません', now);
  }
  return { outcome: 'recruiting', urgentRequestId: req.id, candidates: candidates.length };
}

function notifyAdminsEscalation(db, req, cleaning, why, now) {
  line.send(
    db,
    {
      to: { type: 'admins' },
      category: 'admin',
      title: '【要対応】緊急募集で担当者が決まっていません',
      text: `${why}\n${cleaningSummary(db, cleaning)}\n\n管理画面「緊急募集」から手動で割り当てるか、条件を緩めて再募集してください。`,
      refs: { urgentRequestId: req.id, cleaningId: cleaning.id },
    },
    now
  );
  logEvent(db, { type: 'escalation', level: 'danger', message: `エスカレーション：${prop(db, cleaning.propertyId).name} ${d.formatJa(cleaning.date)}（${why}）`, refs: { urgentRequestId: req.id } }, now);
}

function findByToken(db, token) {
  for (const req of db.urgentRequests) {
    const cand = req.candidates.find((c) => c.token === token);
    if (cand) return { req, cand };
  }
  return null;
}

/**
 * スタッフの回答（LINE postback / 回答ページ / 管理画面の代理入力）
 * @returns {{result:'filled'|'already_filled'|'declined'|'closed'|'not_eligible', ...}}
 */
function respondUrgent(db, token, answer, { now = Date.now() } = {}) {
  const found = findByToken(db, token);
  if (!found) throw new WorkflowError('回答リンクが無効です', 404);
  const { req, cand } = found;
  const cleaning = db.cleanings.find((c) => c.id === req.cleaningId);

  if (req.status === 'filled') {
    return { result: cand.staffId === req.filledBy ? 'filled' : 'already_filled', request: req, filledByName: staffName(db, req.filledBy) };
  }
  if (req.status === 'cancelled') return { result: 'closed', request: req };

  cand.response = answer === 'accept' ? 'accepted' : 'declined';
  cand.respondedAt = new Date(now).toISOString();

  if (answer !== 'accept') {
    logEvent(db, { type: 'urgent_decline', message: `${staffName(db, cand.staffId)} が緊急募集を辞退（${prop(db, req.propertyId).name} ${d.formatJa(req.date)}）`, refs: { urgentRequestId: req.id } }, now);
    if (req.candidates.every((c) => c.response === 'declined') && req.status === 'open') {
      req.status = 'escalated';
      req.escalatedAt = new Date(now).toISOString();
      notifyAdminsEscalation(db, req, cleaning, '候補者全員が辞退しました', now);
    }
    return { result: 'declined', request: req };
  }

  // 回答までの間に別の清掃が入っていないか再確認（同日重複防止）
  const ev = engine.evaluateCandidates(db, cleaning, { allowDouble: cand.exception }).find((x) => x.staffId === cand.staffId);
  if (!ev || !ev.eligible) {
    cand.response = 'ineligible';
    return { result: 'not_eligible', request: req, reasons: ev ? ev.reasons : [] };
  }

  // 先着確定（単一プロセス・同期処理のため、この区間に他の回答が割り込むことはない）
  req.status = 'filled';
  req.filledBy = cand.staffId;
  req.filledAt = new Date(now).toISOString();
  assignCleaning(db, cleaning, cand.staffId, { mode: 'urgent', now, exception: cand.exception, note: `${staffName(db, cand.staffId)} が緊急募集を承諾` });

  const p = prop(db, req.propertyId);
  line.send(
    db,
    {
      to: { type: 'group' },
      category: 'urgent_closed',
      title: '【緊急募集 決定】ありがとうございました',
      text: `${p.name} ${d.formatJa(req.date)} ${cleaning.startTime}〜 の清掃は ${staffName(db, cand.staffId)} さんに決定しました。`,
      refs: { urgentRequestId: req.id },
    },
    now
  );
  line.send(
    db,
    {
      to: { type: 'admins' },
      category: 'admin',
      title: '【緊急募集 確定】',
      text: `${p.name} ${d.formatJa(req.date)} → ${staffName(db, cand.staffId)}（AirHost 登録済み）`,
      refs: { urgentRequestId: req.id },
    },
    now
  );
  return { result: 'filled', request: req, filledByName: staffName(db, cand.staffId) };
}

/** 期限切れの募集をエスカレーション（サーバーの定期ジョブから呼ばれる） */
function checkTimeouts(db, now = Date.now()) {
  let n = 0;
  for (const req of db.urgentRequests) {
    if (req.status !== 'open') continue;
    if (new Date(req.deadline).getTime() > now) continue;
    escalateUrgent(db, req.id, { now, why: '回答期限までに承諾がありませんでした' });
    n++;
  }
  return n;
}

function escalateUrgent(db, id, { now = Date.now(), why = '管理者が手動でエスカレーション' } = {}) {
  const req = db.urgentRequests.find((u) => u.id === id);
  if (!req) throw new WorkflowError('緊急募集が見つかりません', 404);
  if (req.status !== 'open') return req;
  req.status = 'escalated';
  req.escalatedAt = new Date(now).toISOString();
  const cleaning = db.cleanings.find((c) => c.id === req.cleaningId);
  notifyAdminsEscalation(db, req, cleaning, why, now);
  // 未回答者へリマインド（エスカレーション後も先着で受付継続）
  for (const cand of req.candidates.filter((c) => !c.response)) {
    line.send(
      db,
      {
        to: { type: 'staff', staffId: cand.staffId },
        category: 'urgent',
        title: '【再送・緊急】まだ担当者が決まっていません',
        text: `${cleaningSummary(db, cleaning)}\nご対応可能でしたら回答をお願いします。`,
        actions: [
          { label: '対応できます', kind: 'accept', token: cand.token },
          { label: '今回は難しい', kind: 'decline', token: cand.token },
        ],
        refs: { urgentRequestId: req.id },
      },
      now
    );
  }
  return req;
}

// ---------------------------------------------------------------------------
// 管理者操作
// ---------------------------------------------------------------------------

function manualAssign(db, cleaningId, staffId, { now = Date.now(), force = false } = {}) {
  const c = db.cleanings.find((x) => x.id === cleaningId);
  if (!c) throw new WorkflowError('清掃予定が見つかりません', 404);
  if (c.status === 'cancelled') throw new WorkflowError('取消済みの清掃です');
  const ev = engine.evaluateCandidates(db, c, { allowDouble: true }).find((x) => x.staffId === staffId);
  if (!ev) throw new WorkflowError('スタッフが見つかりません', 404);
  if (!ev.eligible && !force) {
    throw new WorkflowError(`条件外のスタッフです（${ev.reasons.join('・')}）。強制割当する場合は確認してください`, 409);
  }
  if (c.staffId === staffId) return { cleaning: c };

  if (c.staffId) {
    unassignCleaning(db, c, { now, reason: '変更', notifyText: `${prop(db, c.propertyId).name} ${d.formatJa(c.date)} の担当は管理者により変更されました。` });
  }
  closeUrgentFor(db, c, now, '管理者による手動割当');
  if (c.urgentRequestId) {
    const req = db.urgentRequests.find((u) => u.id === c.urgentRequestId);
    if (req && req.status === 'cancelled') {
      req.status = 'filled';
      req.filledBy = staffId;
      req.filledAt = new Date(now).toISOString();
      req.closeReason = '管理者が手動割当';
    }
  }
  if (!isPublished(db, d.monthOf(c.date)) && ['draft', 'awaiting_monthly', 'unassigned'].includes(c.status)) {
    c.staffId = staffId;
    c.status = 'draft';
    c.mode = 'manual';
    history(c, 'draft', `下書きシフトを ${staffName(db, staffId)} に変更`, now);
    return { cleaning: c };
  }
  assignCleaning(db, c, staffId, { mode: 'manual', now, exception: ev.exception || !ev.eligible, note: `管理者が ${staffName(db, staffId)} を割当${ev.eligible ? '' : `（条件外: ${ev.reasons.join('・')}）`}` });
  return { cleaning: c };
}

/** 担当者を外して再割当（勤務不可日の後出し等） */
function reassign(db, cleaningId, { now = Date.now() } = {}) {
  const c = db.cleanings.find((x) => x.id === cleaningId);
  if (!c) throw new WorkflowError('清掃予定が見つかりません', 404);
  if (c.status === 'cancelled') throw new WorkflowError('取消済みの清掃です');
  if (c.staffId) {
    unassignCleaning(db, c, { now, reason: '変更', notifyText: `${prop(db, c.propertyId).name} ${d.formatJa(c.date)} の担当は再調整により解除されました。` });
  }
  closeUrgentFor(db, c, now, '再割当');
  c.urgentRequestId = null;
  c.status = 'pending';
  return scheduleCleaning(db, c, { now, reason: '再割当' });
}

// ---------------------------------------------------------------------------
// 月次シフト（既存運用 ①〜④ の自動化）
// ---------------------------------------------------------------------------

function generateMonth(db, month, { now = Date.now() } = {}) {
  if (isPublished(db, month)) throw new WorkflowError(`${month} は確定済みです（確定後の新規予約は自動割当されます）`);
  const targets = db.cleanings.filter(
    (c) => d.monthOf(c.date) === month && ['awaiting_monthly', 'draft', 'unassigned'].includes(c.status) && c.mode !== 'manual'
  );
  for (const c of targets) {
    c.staffId = null;
    c.status = 'awaiting_monthly';
  }
  // 日付順、同日内は候補者が少ない（制約の厳しい）施設から割り当てる
  targets.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const ca = engine.evaluateCandidates(db, a).filter((x) => x.eligible).length;
    const cb = engine.evaluateCandidates(db, b).filter((x) => x.eligible).length;
    return ca - cb;
  });
  let assigned = 0;
  let unassigned = 0;
  let exceptions = 0;
  for (const c of targets) {
    const pick = engine.pickStaff(db, c);
    if (pick.staffId) {
      c.staffId = pick.staffId;
      c.status = 'draft';
      c.mode = 'monthly';
      c.exception = pick.exception;
      assigned++;
      if (pick.exception) exceptions++;
    } else {
      c.status = 'unassigned';
      unassigned++;
    }
  }
  if (!db.draftMonths.includes(month)) db.draftMonths.push(month);
  logEvent(db, { type: 'monthly', message: `${month} の月次シフト案を作成（割当 ${assigned} 件・未割当 ${unassigned} 件・例外 ${exceptions} 件）` }, now);
  return { month, assigned, unassigned, exceptions, fairness: engine.computeFairness(db, month) };
}

function publishMonth(db, month, { now = Date.now() } = {}) {
  if (isPublished(db, month)) throw new WorkflowError(`${month} は確定済みです`);
  if (!db.cleanings.some((c) => d.monthOf(c.date) === month && c.status === 'draft')) throw new WorkflowError('先にシフト案を作成してください');
  // シフト案作成後〜確定までに入った予約も、確定前に同じルールで割り当てる
  for (const c of db.cleanings.filter((x) => d.monthOf(x.date) === month && x.status === 'awaiting_monthly').sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const pick = engine.pickStaff(db, c);
    if (pick.staffId) Object.assign(c, { staffId: pick.staffId, status: 'draft', mode: 'monthly', exception: pick.exception });
    else c.status = 'unassigned';
  }
  const drafts = db.cleanings.filter((c) => d.monthOf(c.date) === month && c.status === 'draft');
  const byStaff = new Map();
  for (const c of drafts) {
    c.status = 'assigned';
    c.locked = true;
    c.updatedAt = new Date(now).toISOString();
    history(c, 'assign', `月次シフト確定：${staffName(db, c.staffId)}`, now, { staffId: c.staffId });
    airhost.register(db, c, 'assign', now);
    if (!byStaff.has(c.staffId)) byStaff.set(c.staffId, []);
    byStaff.get(c.staffId).push(c);
  }
  for (const [staffId, list] of byStaff) {
    list.sort((a, b) => (a.date < b.date ? -1 : 1));
    const hours = engine.round2(list.reduce((a, c) => a + c.hours, 0));
    line.send(
      db,
      {
        to: { type: 'staff', staffId },
        category: 'monthly',
        title: `【${Number(month.slice(5))}月の清掃シフト確定】`,
        text: `${list.length}件・拘束時間 合計${hours}時間\n` + list.map((c) => `・${d.formatJa(c.date)} ${c.startTime} ${prop(db, c.propertyId).name}`).join('\n'),
        refs: { month },
      },
      now
    );
  }
  db.publishedMonths.push(month);
  db.draftMonths = db.draftMonths.filter((m) => m !== month);
  sheets.sync(db, month, '月次シフト確定', now);
  const left = db.cleanings.filter((c) => d.monthOf(c.date) === month && c.status === 'unassigned').length;
  if (left > 0) {
    line.send(db, { to: { type: 'admins' }, category: 'admin', title: '【要対応】月次シフトに未割当があります', text: `${month}：未割当 ${left} 件。管理画面から手動割当してください。` }, now);
  }
  logEvent(db, { type: 'monthly', level: 'success', message: `${month} の月次シフトを確定・配信（${drafts.length} 件・スタッフ ${byStaff.size} 名へ LINE 通知・AirHost 登録）` }, now);
  return { month, published: drafts.length, staff: byStaff.size, unassigned: left };
}

// ---------------------------------------------------------------------------
// 勤務不可日の提出（Google フォームの置き換え）
// ---------------------------------------------------------------------------

function submitUnavailability(db, staffId, month, dates, { now = Date.now() } = {}) {
  const s = engine.staffById(db, staffId);
  if (!s) throw new WorkflowError('スタッフが見つかりません', 404);
  const clean = [...new Set((dates || []).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x) && x.startsWith(month)))].sort();
  s.unavailable = (s.unavailable || []).filter((x) => !x.startsWith(month)).concat(clean).sort();
  db.submissions[month] = db.submissions[month] || {};
  db.submissions[month][staffId] = new Date(now).toISOString();

  // 確定済みシフトと衝突する場合は管理者へ通知（自動では外さない＝確定シフト維持の原則）
  const conflicts = db.cleanings.filter((c) => c.staffId === staffId && c.status === 'assigned' && clean.includes(c.date));
  if (conflicts.length) {
    line.send(
      db,
      {
        to: { type: 'admins' },
        category: 'admin',
        title: '【要確認】確定シフトと勤務不可日が重なっています',
        text: `${s.name}：\n` + conflicts.map((c) => `・${d.formatJa(c.date)} ${prop(db, c.propertyId).name}`).join('\n') + '\n管理画面から再割当してください。',
      },
      now
    );
  }
  logEvent(db, { type: 'availability', message: `${s.name} が ${month} の勤務不可日を提出（${clean.length} 日${conflicts.length ? `・確定シフトと衝突 ${conflicts.length} 件` : ''}）`, refs: { staffId } }, now);
  return { staffId, month, dates: clean, conflicts: conflicts.map((c) => c.id) };
}

/** 確定シフトと勤務不可日が衝突している清掃 */
function conflicts(db) {
  return db.cleanings.filter((c) => {
    if (c.status !== 'assigned' || !c.staffId) return false;
    const s = engine.staffById(db, c.staffId);
    return s && (s.unavailable || []).includes(c.date);
  });
}

module.exports = {
  WorkflowError,
  settings,
  createReservation,
  updateReservation,
  cancelReservation,
  scheduleCleaning,
  openUrgent,
  respondUrgent,
  escalateUrgent,
  checkTimeouts,
  findByToken,
  manualAssign,
  reassign,
  generateMonth,
  publishMonth,
  submitUnavailability,
  conflicts,
  findReservation,
  cleaningSummary,
  sourceLabel,
  isPublished,
};
