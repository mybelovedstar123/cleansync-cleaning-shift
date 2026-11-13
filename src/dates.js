'use strict';
// 日付ユーティリティ（すべて日本時間 JST 基準、日付は 'YYYY-MM-DD' 文字列で扱う）

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function nowMs() {
  return Date.now();
}

/** 任意のタイムスタンプ（ms または ISO 文字列）を JST の 'YYYY-MM-DD' に変換 */
function jstDate(ts = nowMs()) {
  const ms = typeof ts === 'number' ? ts : new Date(ts).getTime();
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** JST の 'YYYY-MM-DDTHH:mm' 表記 */
function jstDateTime(ts = nowMs()) {
  const ms = typeof ts === 'number' ? ts : new Date(ts).getTime();
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 16);
}

/** JST の日付 + 時刻（'HH:mm'）から UTC ISO 文字列を作る */
function jstToIso(date, time = '00:00') {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - JST_OFFSET_MS).toISOString();
}

function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** b - a（日数） */
function diffDays(a, b) {
  const pa = Date.UTC(...a.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  const pb = Date.UTC(...b.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  return Math.round((pb - pa) / 86400000);
}

function monthOf(date) {
  return date.slice(0, 7);
}

function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function monthDates(month) {
  const n = daysInMonth(month);
  const out = [];
  for (let i = 1; i <= n; i++) out.push(`${month}-${String(i).padStart(2, '0')}`);
  return out;
}

/** 'HH:mm' + 時間（小数可）→ 'HH:mm' */
function addHoursToTime(time, hours) {
  const [hh, mm] = time.split(':').map(Number);
  const total = hh * 60 + mm + Math.round(hours * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function timeToMinutes(time) {
  const [hh, mm] = time.split(':').map(Number);
  return hh * 60 + mm;
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
function weekday(date) {
  const [y, m, d] = date.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** '12月13日(日)' 形式 */
function formatJa(date) {
  const [, m, d] = date.split('-').map(Number);
  return `${m}月${d}日(${weekday(date)})`;
}

module.exports = {
  nowMs,
  jstDate,
  jstDateTime,
  jstToIso,
  addDays,
  diffDays,
  monthOf,
  addMonths,
  daysInMonth,
  monthDates,
  addHoursToTime,
  timeToMinutes,
  weekday,
  formatJa,
};
