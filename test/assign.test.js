'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../src/engine/assign');
const { fixture } = require('./helpers');

function cleaning(db, over = {}) {
  const c = { id: `c${db.cleanings.length + 1}`, propertyId: 'p1', date: '2026-12-10', startTime: '10:00', endTime: '13:30', hours: 3.5, status: 'pending', staffId: null, ...over };
  db.cleanings.push(c);
  return c;
}

test('勤務不可日・対応不可施設のスタッフは除外される', () => {
  const db = fixture();
  const c = cleaning(db, { date: '2026-12-13' });
  const ev = engine.evaluateCandidates(db, c);
  const byId = Object.fromEntries(ev.map((e) => [e.staffId, e]));
  assert.equal(byId.a.eligible, true);
  assert.deepEqual(byId.b.reasons, ['勤務不可日']);
  assert.deepEqual(byId.c.reasons, ['対応不可施設']);
});

test('1人1日1施設：同日に別の清掃があるスタッフは候補外', () => {
  const db = fixture();
  cleaning(db, { propertyId: 'p2', staffId: 'a', status: 'assigned', hours: 2.5 });
  const c = cleaning(db, { propertyId: 'p1' });
  const pick = engine.pickStaff(db, c);
  assert.equal(pick.staffId, 'b');
  assert.equal(pick.exception, false);
});

test('拘束時間 ÷ 勤務可能日数 が小さいスタッフを優先（件数ではなく時間）', () => {
  const db = fixture();
  // a: 1件だが長時間 / b: 2件だが短時間
  cleaning(db, { date: '2026-12-01', staffId: 'a', status: 'assigned', hours: 8 });
  cleaning(db, { date: '2026-12-02', staffId: 'b', status: 'assigned', hours: 1 });
  cleaning(db, { date: '2026-12-03', staffId: 'b', status: 'assigned', hours: 1 });
  const c = cleaning(db, { date: '2026-12-20' });
  assert.equal(engine.pickStaff(db, c).staffId, 'b');
});

test('候補ゼロ時のみ、時間的に可能なら同日2件目を例外として許容', () => {
  const db = fixture();
  db.staff = db.staff.filter((s) => s.id === 'a');
  // 清掃枠 10:00〜16:00 = 6h ≧ 2h + 3.5h + バッファ 0.5h
  cleaning(db, { propertyId: 'p2', staffId: 'a', status: 'assigned', hours: 2 });
  const c = cleaning(db, { propertyId: 'p1', hours: 3.5 });
  const pick = engine.pickStaff(db, c);
  assert.equal(pick.staffId, 'a');
  assert.equal(pick.exception, true);
});

test('同日2件目でも清掃枠に収まらなければ割り当てない', () => {
  const db = fixture();
  db.staff = db.staff.filter((s) => s.id === 'a');
  cleaning(db, { propertyId: 'p2', staffId: 'a', status: 'assigned', hours: 4 });
  const c = cleaning(db, { propertyId: 'p1', hours: 3.5 });
  assert.equal(engine.pickStaff(db, c).staffId, null);
});

test('公平性：期待拘束時間は勤務可能日数で按分され、合計は総拘束時間に一致', () => {
  const db = fixture();
  cleaning(db, { date: '2026-12-01', staffId: 'a', status: 'assigned', hours: 6 });
  cleaning(db, { date: '2026-12-02', staffId: 'c', status: 'assigned', hours: 4 });
  const f = engine.computeFairness(db, '2026-12');
  assert.equal(f.totalHours, 10);
  const sumExp = f.rows.reduce((a, r) => a + r.expectedHours, 0);
  assert.ok(Math.abs(sumExp - 10) < 0.05);
  const b = f.rows.find((r) => r.staffId === 'b');
  const a = f.rows.find((r) => r.staffId === 'a');
  assert.ok(b.expectedHours < a.expectedHours, '不可日がある b の期待値は小さい');
  assert.ok(f.score >= 0 && f.score <= 100);
});
