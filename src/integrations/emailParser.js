'use strict';
// 予約通知メールのパーサ（API 連携が難しい場合の代替手段）
//
// Gmail で受信した AirHost / OTA の予約通知メールを Google Apps Script（gas/airhostMailForwarder.gs）が
// /api/webhooks/email へ転送 → 本パーサで「新規 / 変更 / キャンセル」と予約項目を抽出する。
// ラベル表記ゆれ（全角・半角・英語）に対応。実際のメール文面に合わせて LABELS を追加するだけで拡張可能。

const LABELS = {
  reservationCode: ['予約番号', '予約ID', '予約コード', '確認コード', 'Reservation ID', 'Reservation code', 'Confirmation code'],
  propertyName: ['物件名', '施設名', 'リスティング名', 'リスティング', '部屋名', 'Listing', 'Property'],
  guestName: ['ゲスト名', '宿泊者名', '代表者名', '予約者名', 'ゲスト', 'お名前', 'Guest name', 'Guest'],
  checkIn: ['チェックイン日', 'チェックイン', '到着日', 'Check-in', 'Check in', 'Arrival'],
  checkOut: ['チェックアウト日', 'チェックアウト', '出発日', 'Check-out', 'Check out', 'Departure'],
  guests: ['宿泊人数', 'ゲスト数', '人数', 'Guests', 'Number of guests'],
  channel: ['予約経路', '予約サイト', '予約チャネル', 'チャネル', 'OTA', 'Channel', 'Source'],
  bookedAt: ['予約日時', '受付日時', '予約受付日時', 'Booked at', 'Booking date'],
};

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function field(text, labels) {
  // 長いラベルから先に試す（「チェックイン日」を「チェックイン」より優先）
  const sorted = [...labels].sort((a, b) => b.length - a.length);
  for (const label of sorted) {
    const re = new RegExp(`^[\\s・■●◆\\-*]*${escapeRe(label)}\\s*[:：]\\s*(.+)$`, 'im');
    const m = text.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

/** '2026/12/12', '2026-12-12', '2026年12月12日', '12月12日'（年は推定）に対応 */
function parseDate(s, fallbackYear) {
  if (!s) return null;
  let m = s.match(/(\d{4})\s*[/\-年.]\s*(\d{1,2})\s*[/\-月.]\s*(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/(\d{1,2})\s*[/月]\s*(\d{1,2})/);
  if (m && fallbackYear) return `${fallbackYear}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

function parseTime(s) {
  if (!s) return null;
  const m = s.match(/(\d{1,2})\s*[:時]\s*(\d{2})?/);
  if (!m) return null;
  return `${m[1].padStart(2, '0')}:${(m[2] || '00').padStart(2, '0')}`;
}

function detectType(text) {
  if (/キャンセル|取り?消し|cancel/i.test(text)) return 'cancelled';
  if (/変更|修正|modif|change|updated/i.test(text)) return 'updated';
  if (/新規予約|予約確定|予約が(入り|確定)|ご予約(を)?(受け付け|ありがとう)|new reservation|booking confirmed|confirmed/i.test(text)) {
    return 'created';
  }
  return null;
}

/**
 * @param {{subject?:string, body?:string}} mail
 * @param {{year?:number}} [opts]
 */
function parseReservationEmail(mail, opts = {}) {
  const subject = String(mail.subject || '').normalize('NFKC');
  const body = String(mail.body || '').normalize('NFKC');
  const text = `${subject}\n${body}`;
  const year = opts.year || new Date().getFullYear();

  const result = {
    type: detectType(subject) || detectType(body),
    reservationCode: field(text, LABELS.reservationCode),
    propertyName: field(text, LABELS.propertyName),
    guestName: field(text, LABELS.guestName),
    checkIn: parseDate(field(text, LABELS.checkIn), year),
    checkOut: parseDate(field(text, LABELS.checkOut), year),
    guests: null,
    channel: field(text, LABELS.channel),
    bookedAt: null,
  };

  // 「宿泊期間：2026/12/12 〜 2026/12/13」形式
  if (!result.checkIn || !result.checkOut) {
    const period = field(text, ['宿泊期間', '宿泊日', '滞在期間', 'Dates', 'Stay']);
    if (period) {
      const parts = period.split(/〜|~|～|-(?=\s*\d{4})|から|to/);
      if (parts.length >= 2) {
        result.checkIn = result.checkIn || parseDate(parts[0], year);
        result.checkOut = result.checkOut || parseDate(parts[1], year);
      }
    }
  }

  const g = field(text, LABELS.guests);
  if (g) {
    const m = g.match(/\d+/);
    if (m) result.guests = Number(m[0]);
  }

  const booked = field(text, LABELS.bookedAt);
  if (booked) {
    const d = parseDate(booked, year);
    const t = parseTime(booked.replace(/^\d{4}\s*[/\-年.]\s*\d{1,2}\s*[/\-月.]\s*\d{1,2}日?/, ''));
    if (d) result.bookedAt = { date: d, time: t || '00:00' };
  }

  if (result.guestName) result.guestName = result.guestName.replace(/\s*様$/, '').trim();
  if (result.reservationCode) result.reservationCode = result.reservationCode.split(/\s/)[0];

  const required = result.type === 'cancelled' ? ['reservationCode'] : ['reservationCode', 'propertyName', 'checkIn', 'checkOut'];
  result.missing = required.filter((k) => !result[k]);
  result.ok = Boolean(result.type) && result.missing.length === 0;
  return result;
}

module.exports = { parseReservationEmail, parseDate, LABELS };
