'use strict';
// 清掃スタッフ自動割当エンジン
//
// ルール（募集要項 ② に対応）
//   1. 勤務不可日には割り当てない                   … hard
//   2. 対応不可施設には割り当てない                 … hard
//   3. 原則 1 人 1 日 1 施設まで                    … hard（候補ゼロ時のみ例外フォールバック）
//   4. 既存の確定シフトは原則維持                   … 割当済み清掃は再計算対象にしない
//   5. 件数・報酬ではなく「拘束時間」に基づく公平性 … スコア = (当月拘束時間 + 今回拘束時間) / 当月勤務可能日数
//   6. 割当結果を公平性管理シートへ反映             … computeFairness() / sheets 連携

const { addDays, monthOf, monthDates, timeToMinutes } = require('../dates');

/** 清掃の拘束時間としてカウントするステータス */
const LOAD_STATUSES = new Set(['assigned', 'draft', 'completed']);

/** 施設 1 回あたりの拘束時間（清掃時間 + 移動時間） */
function restraintHours(property) {
  return round2((property.cleaningHours || 0) + (property.travelHours || 0));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function staffById(db, id) {
  return db.staff.find((s) => s.id === id);
}

function propertyById(db, id) {
  return db.properties.find((p) => p.id === id);
}

/** 指定スタッフがその日に持っている有効な清掃 */
function jobsOn(db, staffId, date, excludeCleaningId) {
  return db.cleanings.filter(
    (c) => c.staffId === staffId && c.date === date && c.id !== excludeCleaningId && LOAD_STATUSES.has(c.status)
  );
}

function availableDays(staff, month) {
  const off = new Set((staff.unavailable || []).filter((d) => d.startsWith(month)));
  return monthDates(month).length - off.size;
}

/** 月次の拘束時間・件数（excludeCleaningId は再割当時に自分自身を除外するため） */
function monthLoad(db, staffId, month, excludeCleaningId) {
  let hours = 0;
  let count = 0;
  for (const c of db.cleanings) {
    if (c.staffId !== staffId || c.id === excludeCleaningId) continue;
    if (!LOAD_STATUSES.has(c.status) || monthOf(c.date) !== month) continue;
    hours += c.hours;
    count += 1;
  }
  return { hours: round2(hours), count };
}

/** 2 件目を同日に入れられるか（チェックアウト〜チェックイン間に収まるか） */
function canDoubleUp(db, existing, cleaning) {
  if (existing.length !== 1) return false;
  const other = existing[0];
  const prop = propertyById(db, cleaning.propertyId);
  const otherProp = propertyById(db, other.propertyId);
  const windowStart = Math.min(timeToMinutes(prop.checkoutTime), timeToMinutes(otherProp.checkoutTime));
  const windowEnd = Math.min(timeToMinutes(prop.checkinTime), timeToMinutes(otherProp.checkinTime));
  const needed = (cleaning.hours + other.hours + 0.5) * 60; // 30 分のバッファ
  return needed <= windowEnd - windowStart;
}

/**
 * 全スタッフを評価し、適格性・除外理由・スコアを返す。
 * @returns {Array<{staffId,name,eligible,reasons,exception,hours,count,availableDays,projected,consecutive,score}>}
 */
function evaluateCandidates(db, cleaning, opts = {}) {
  const { allowDouble = false } = opts;
  const month = monthOf(cleaning.date);
  const results = [];

  for (const s of db.staff) {
    const reasons = [];
    let exception = false;
    if (!s.active) reasons.push('休止中');
    if ((s.unavailable || []).includes(cleaning.date)) reasons.push('勤務不可日');
    if (!(s.properties || []).includes(cleaning.propertyId)) reasons.push('対応不可施設');

    const sameDay = jobsOn(db, s.id, cleaning.date, cleaning.id);
    if (sameDay.length > 0) {
      if (allowDouble && reasons.length === 0 && canDoubleUp(db, sameDay, cleaning)) {
        exception = true;
      } else {
        reasons.push('同日に他施設の清掃あり');
      }
    }

    const load = monthLoad(db, s.id, month, cleaning.id);
    const days = availableDays(s, month);
    const consecutive =
      jobsOn(db, s.id, addDays(cleaning.date, -1), cleaning.id).length > 0 ||
      jobsOn(db, s.id, addDays(cleaning.date, 1), cleaning.id).length > 0;

    const projected = round2((load.hours + cleaning.hours) / Math.max(days, 1));
    // 連勤は軽いペナルティ、同日 2 件目（例外）は重いペナルティ
    const score = round2(projected + (consecutive ? 0.05 : 0) + (exception ? 10 : 0));

    results.push({
      staffId: s.id,
      name: s.name,
      eligible: reasons.length === 0,
      reasons,
      exception,
      hours: load.hours,
      count: load.count,
      availableDays: days,
      projected,
      consecutive,
      score,
    });
  }

  results.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (a.score !== b.score) return a.score - b.score;
    if (a.hours !== b.hours) return a.hours - b.hours;
    return a.staffId.localeCompare(b.staffId);
  });
  return results;
}

/**
 * 最適なスタッフを 1 名選ぶ。原則ルールで候補が居なければ、同日 2 件目（時間的に可能な場合のみ）を例外として許容。
 * @returns {{ staffId: string|null, exception: boolean, ranking: Array }}
 */
function pickStaff(db, cleaning) {
  let ranking = evaluateCandidates(db, cleaning);
  let best = ranking.find((r) => r.eligible);
  if (best) return { staffId: best.staffId, exception: false, ranking };

  ranking = evaluateCandidates(db, cleaning, { allowDouble: true });
  best = ranking.find((r) => r.eligible);
  if (best) return { staffId: best.staffId, exception: true, ranking };

  return { staffId: null, exception: false, ranking };
}

/** 緊急募集の対象者（原則ルールを満たす全員。居なければ例外対象者） */
function urgentCandidates(db, cleaning) {
  let ranking = evaluateCandidates(db, cleaning).filter((r) => r.eligible);
  if (ranking.length === 0) {
    ranking = evaluateCandidates(db, cleaning, { allowDouble: true }).filter((r) => r.eligible);
  }
  return ranking;
}

/**
 * 公平性管理シート（月次）
 *   期待拘束時間 = 当月総拘束時間 × (本人の勤務可能日数 / 全員の勤務可能日数合計)
 *   公平比       = 実拘束時間 / 期待拘束時間（1.00 が完全に公平）
 */
function computeFairness(db, month) {
  const active = db.staff.filter((s) => s.active);
  const rows = active.map((s) => {
    const load = monthLoad(db, s.id, month);
    return {
      staffId: s.id,
      name: s.name,
      availableDays: availableDays(s, month),
      count: load.count,
      hours: load.hours,
    };
  });
  const totalHours = round2(rows.reduce((a, r) => a + r.hours, 0));
  const totalDays = rows.reduce((a, r) => a + r.availableDays, 0) || 1;
  for (const r of rows) {
    r.expectedHours = round2((totalHours * r.availableDays) / totalDays);
    r.ratio = r.expectedHours > 0 ? round2(r.hours / r.expectedHours) : r.hours > 0 ? 9.99 : 1;
    r.share = totalHours > 0 ? round2((r.hours / totalHours) * 100) : 0;
    r.diffHours = round2(r.hours - r.expectedHours);
  }
  const meanAbsDev = rows.length ? rows.reduce((a, r) => a + Math.abs(r.ratio - 1), 0) / rows.length : 0;
  const score = Math.max(0, Math.round((1 - meanAbsDev) * 100));
  const totalCount = rows.reduce((a, r) => a + r.count, 0);
  return { month, rows, totalHours, totalCount, score };
}

module.exports = {
  LOAD_STATUSES,
  restraintHours,
  evaluateCandidates,
  pickStaff,
  urgentCandidates,
  computeFairness,
  monthLoad,
  availableDays,
  jobsOn,
  staffById,
  propertyById,
  round2,
};
