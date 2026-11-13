'use strict';
// 公平性管理シート連携
//   ・CSV エクスポート（Excel / スプレッドシートへそのまま取込可能）
//   ・GOOGLE_SHEETS_WEBHOOK_URL を設定すると、Google Apps Script（gas/fairnessSheet.gs）経由で
//     スプレッドシートの「YYYY-MM」シートを自動更新する

const { nextId } = require('../db');
const { computeFairness } = require('../engine/assign');

function toCsv(fairness) {
  const header = ['スタッフID', '氏名', '勤務可能日数', '清掃件数', '拘束時間(h)', '期待拘束時間(h)', '差分(h)', '公平比', '割当率(%)'];
  const lines = [header];
  for (const r of fairness.rows) {
    lines.push([r.staffId, r.name, r.availableDays, r.count, r.hours, r.expectedHours, r.diffHours, r.ratio, r.share]);
  }
  lines.push([]);
  lines.push(['合計', '', '', fairness.totalCount, fairness.totalHours, '', '', '', '100']);
  lines.push(['公平性スコア', fairness.score]);
  return '﻿' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n');
}

function csvCell(v) {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 当月シートへ反映（割当発生のたびに呼ばれる） */
function sync(db, month, reason, now = Date.now()) {
  const fairness = computeFairness(db, month);
  const url = db.meta.seeding ? '' : process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  const rec = {
    id: nextId(db, 'sh'),
    at: new Date(now).toISOString(),
    month,
    reason,
    mode: url ? 'live' : 'mock',
    status: url ? 'queued' : 'success',
    score: fairness.score,
  };
  if (url) {
    setImmediate(async () => {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ month, rows: fairness.rows, totalHours: fairness.totalHours, score: fairness.score }),
        });
        rec.status = res.ok ? 'success' : 'failed';
      } catch (e) {
        rec.status = 'failed';
        rec.error = String(e.message || e).slice(0, 200);
      }
    });
  }
  db.sheetSync.unshift(rec);
  if (db.sheetSync.length > 500) db.sheetSync.length = 500;
  return rec;
}

module.exports = { toCsv, sync };
