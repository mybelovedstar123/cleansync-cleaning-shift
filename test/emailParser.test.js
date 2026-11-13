'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseReservationEmail } = require('../src/integrations/emailParser');

test('新規予約メール（■ラベル形式）', () => {
  const r = parseReservationEmail({
    subject: '【AirHost】新規予約が確定しました（逗子 プールヴィラ）',
    body: '■ 予約番号: HM26112233\n■ 物件名: 逗子 プールヴィラ\n■ ゲスト名: 大野 湊 様\n■ チェックイン: 2026/12/11\n■ チェックアウト: 2026/12/12\n■ 宿泊人数: 5名\n■ 予約経路: Booking.com\n■ 予約日時: 2026/11/13 14:05',
  });
  assert.equal(r.ok, true);
  assert.equal(r.type, 'created');
  assert.equal(r.reservationCode, 'HM26112233');
  assert.equal(r.guestName, '大野 湊');
  assert.equal(r.checkIn, '2026-12-11');
  assert.equal(r.checkOut, '2026-12-12');
  assert.equal(r.guests, 5);
  assert.deepEqual(r.bookedAt, { date: '2026-11-13', time: '14:05' });
});

test('全角コロン・全角数字・年月日表記', () => {
  const r = parseReservationEmail({
    subject: '予約内容の変更のお知らせ',
    body: '予約番号：ＨＭ１２３４５\n施設名：鎌倉 フォレストハウス\n宿泊者名：森田 結衣\nチェックイン日：２０２６年１２月３日\nチェックアウト日：２０２６年１２月５日\n人数：３名',
  });
  assert.equal(r.type, 'updated');
  assert.equal(r.reservationCode, 'HM12345');
  assert.equal(r.checkIn, '2026-12-03');
  assert.equal(r.checkOut, '2026-12-05');
  assert.equal(r.guests, 3);
  assert.equal(r.ok, true);
});

test('「予約内容が変更されました」も変更として判定', () => {
  const r = parseReservationEmail({ subject: '【AirHost】予約内容が変更されました', body: '予約番号：HM1\n物件名：逗子 プールヴィラ\nチェックイン：2026/12/10\nチェックアウト：2026/12/11' });
  assert.equal(r.type, 'updated');
  assert.equal(r.ok, true);
});

test('宿泊期間 形式とキャンセル判定', () => {
  const r = parseReservationEmail({
    subject: 'Reservation cancelled',
    body: 'Reservation ID: HM999\nListing: 熱海 オーシャンテラス\n宿泊期間：2026/12/20 〜 2026/12/22',
  });
  assert.equal(r.type, 'cancelled');
  assert.equal(r.checkIn, '2026-12-20');
  assert.equal(r.checkOut, '2026-12-22');
  assert.equal(r.ok, true);
});

test('必須項目が足りないと ok=false', () => {
  const r = parseReservationEmail({ subject: '新規予約', body: '物件名: 葉山 シーサイドヴィラ' });
  assert.equal(r.ok, false);
  assert.ok(r.missing.includes('reservationCode'));
});
