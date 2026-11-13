'use strict';
const { emptyState } = require('../src/db');

/** テスト用の小さな DB（シードとは独立） */
function fixture() {
  const db = emptyState();
  db.settings = { urgentThresholdDays: 1, responseWindowMinutes: 60, allowDoubleFallback: true };
  db.properties = [
    { id: 'p1', name: '葉山 シーサイドヴィラ', area: '葉山', cleaningHours: 3, travelHours: 0.5, checkoutTime: '10:00', checkinTime: '16:00', airhostListingId: 'L1', capacity: 8 },
    { id: 'p2', name: '鎌倉 フォレストハウス', area: '鎌倉', cleaningHours: 2, travelHours: 0.5, checkoutTime: '10:00', checkinTime: '16:00', airhostListingId: 'L2', capacity: 6 },
  ];
  db.staff = [
    { id: 'a', name: '佐藤 美咲', properties: ['p1', 'p2'], active: true, unavailable: [], lineUserId: 'demo_a' },
    { id: 'b', name: '鈴木 健太', properties: ['p1'], active: true, unavailable: ['2026-12-13'], lineUserId: 'demo_b' },
    { id: 'c', name: '高橋 由美子', properties: ['p2'], active: true, unavailable: [], lineUserId: 'demo_c' },
  ];
  db.publishedMonths = ['2026-12'];
  return db;
}

const T = (iso) => new Date(iso).getTime();

module.exports = { fixture, T };
