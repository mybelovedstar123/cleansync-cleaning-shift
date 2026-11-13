'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const wf = require('../src/services/workflow');
const { fixture, T } = require('./helpers');

const NOW = T('2026-11-20T03:00:00Z');

function book(db, over = {}, now = NOW) {
  return wf.createReservation(db, { propertyId: 'p1', guestName: '山口 翔太', guests: 4, checkIn: '2026-12-08', checkOut: '2026-12-10', ...over }, { now, source: 'airhost_api' });
}

test('通常の新規予約：自動割当 → AirHost 登録 → LINE 通知 → シート反映', () => {
  const db = fixture();
  const out = book(db);
  assert.equal(out.result.outcome, 'assigned');
  assert.equal(out.cleaning.date, '2026-12-10');
  assert.equal(out.cleaning.hours, 3.5);
  assert.equal(out.cleaning.status, 'assigned');
  assert.equal(db.airhostSync[0].action, 'assign');
  assert.equal(db.notifications[0].to.staffId, out.cleaning.staffId);
  assert.equal(db.notifications[0].category, 'assign');
  assert.equal(db.sheetSync.length, 1);
});

test('募集要項の例：12/12 23時に1泊予約 → 12/13 清掃は緊急募集、先着1名で確定', () => {
  const db = fixture();
  const bookedAt = T('2026-12-12T14:00:00Z'); // JST 23:00
  const out = book(db, { checkIn: '2026-12-12', checkOut: '2026-12-13', bookedAt: new Date(bookedAt).toISOString() }, bookedAt);
  assert.equal(out.result.outcome, 'recruiting');
  const req = db.urgentRequests[0];
  // b は 12/13 勤務不可、c は p1 対応不可 → a のみ
  assert.deepEqual(req.candidates.map((c) => c.staffId), ['a']);
  assert.ok(db.notifications.some((n) => n.to.type === 'group' && n.category === 'urgent'));
  const personal = db.notifications.find((n) => n.to.staffId === 'a' && n.category === 'urgent');
  assert.equal(personal.actions.length, 3);

  const r1 = wf.respondUrgent(db, req.candidates[0].token, 'accept', { now: bookedAt + 5 * 60000 });
  assert.equal(r1.result, 'filled');
  assert.equal(out.cleaning.staffId, 'a');
  assert.equal(out.cleaning.mode, 'urgent');
  assert.equal(db.airhostSync[0].action, 'assign');
  // 2 回目の回答は確定済み扱い
  const r2 = wf.respondUrgent(db, req.candidates[0].token, 'accept', { now: bookedAt + 6 * 60000 });
  assert.equal(r2.result, 'filled');
});

test('緊急募集：2人目の承諾は「決定済み」になる', () => {
  const db = fixture();
  db.staff.find((s) => s.id === 'b').unavailable = [];
  const now = T('2026-12-12T14:00:00Z');
  book(db, { checkIn: '2026-12-12', checkOut: '2026-12-13' }, now);
  const req = db.urgentRequests[0];
  assert.equal(req.candidates.length, 2);
  assert.equal(wf.respondUrgent(db, req.candidates[1].token, 'accept', { now }).result, 'filled');
  const second = wf.respondUrgent(db, req.candidates[0].token, 'accept', { now });
  assert.equal(second.result, 'already_filled');
  assert.equal(second.filledByName, db.staff.find((s) => s.id === req.candidates[1].staffId).name);
});

test('緊急募集：全員辞退・期限切れで管理者へエスカレーション', () => {
  const db = fixture();
  const now = T('2026-12-12T14:00:00Z');
  book(db, { checkIn: '2026-12-12', checkOut: '2026-12-13' }, now);
  const req = db.urgentRequests[0];
  wf.respondUrgent(db, req.candidates[0].token, 'decline', { now });
  assert.equal(req.status, 'escalated');
  assert.ok(db.notifications.some((n) => n.to.type === 'admins'));

  const db2 = fixture();
  book(db2, { checkIn: '2026-12-12', checkOut: '2026-12-13' }, now);
  assert.equal(wf.checkTimeouts(db2, now + 2 * 3600000), 1);
  assert.equal(db2.urgentRequests[0].status, 'escalated');
});

test('キャンセル：清掃取消・担当者へ通知・AirHost 登録解除', () => {
  const db = fixture();
  const out = book(db);
  const staffId = out.cleaning.staffId;
  wf.cancelReservation(db, out.reservation.code, { now: NOW + 1000 });
  assert.equal(out.cleaning.status, 'cancelled');
  assert.equal(out.cleaning.staffId, null);
  assert.equal(db.airhostSync[0].action, 'unassign');
  assert.equal(db.notifications[0].to.staffId, staffId);
  assert.equal(db.notifications[0].category, 'cancel');
});

test('予約変更：担当者が新日程でも対応可能なら担当維持', () => {
  const db = fixture();
  const out = book(db);
  const staffId = out.cleaning.staffId;
  const res = wf.updateReservation(db, out.reservation.id, { checkOut: '2026-12-11' }, { now: NOW + 1000 });
  assert.equal(res.result.outcome, 'kept');
  assert.equal(out.cleaning.staffId, staffId);
  assert.equal(out.cleaning.date, '2026-12-11');
  assert.equal(db.notifications[0].category, 'change');
});

test('予約変更：担当者が新日程に勤務不可なら解除して再割当', () => {
  const db = fixture();
  db.staff.find((s) => s.id === 'a').unavailable = ['2026-12-10'];
  const out = book(db); // a は 12/10 不可 → b
  assert.equal(out.cleaning.staffId, 'b');
  const res = wf.updateReservation(db, out.reservation.id, { checkOut: '2026-12-13' }, { now: NOW + 1000 }); // b は 12/13 不可
  assert.equal(res.result.outcome, 'assigned');
  assert.equal(out.cleaning.staffId, 'a');
  assert.ok(db.notifications.some((n) => n.to.staffId === 'b' && n.category === 'cancel'));
});

test('重複予約はエラー', () => {
  const db = fixture();
  book(db);
  assert.throws(() => book(db, { checkIn: '2026-12-09', checkOut: '2026-12-11' }), /重複/);
});

test('月次シフト未確定の月は「作成待ち」→ 作成・確定で一括割当', () => {
  const db = fixture();
  const out = book(db, { checkIn: '2027-01-08', checkOut: '2027-01-10' });
  assert.equal(out.result.outcome, 'awaiting_monthly');
  const g = wf.generateMonth(db, '2027-01', { now: NOW });
  assert.equal(g.assigned, 1);
  assert.equal(out.cleaning.status, 'draft');
  const p = wf.publishMonth(db, '2027-01', { now: NOW });
  assert.equal(p.published, 1);
  assert.equal(out.cleaning.status, 'assigned');
  assert.ok(db.publishedMonths.includes('2027-01'));
  assert.ok(db.notifications.some((n) => n.category === 'monthly'));
});

test('確定シフト後に勤務不可日を提出すると衝突として検出（自動では外さない）', () => {
  const db = fixture();
  const out = book(db);
  const staffId = out.cleaning.staffId;
  const r = wf.submitUnavailability(db, staffId, '2026-12', ['2026-12-10'], { now: NOW });
  assert.equal(r.conflicts.length, 1);
  assert.equal(out.cleaning.staffId, staffId);
  assert.equal(wf.conflicts(db).length, 1);
});
