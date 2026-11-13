'use strict';
// シンプルな JSON ファイルストア（単一プロセス前提）。
// 本番では PostgreSQL / Firestore 等に置き換え可能なよう、アクセスはこのモジュール経由に限定する。

const fs = require('fs');
const path = require('path');

const FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'db.json');

let state = null;

function emptyState() {
  return {
    meta: { seq: 1, createdAt: new Date().toISOString(), version: 1 },
    settings: {},
    admins: [],
    properties: [],
    staff: [],
    reservations: [],
    cleanings: [],
    urgentRequests: [],
    notifications: [],
    airhostSync: [],
    sheetSync: [],
    events: [],
    publishedMonths: [],
    draftMonths: [],
    submissions: {}, // { 'YYYY-MM': { staffId: submittedAtIso } }
  };
}

function nextId(db, prefix) {
  const n = db.meta.seq++;
  return `${prefix}_${String(n).padStart(5, '0')}`;
}

function load() {
  if (state) return state;
  if (fs.existsSync(FILE)) {
    state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } else {
    state = require('./seed').buildSeed();
    save();
  }
  return state;
}

function save() {
  if (!state) return;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, FILE);
}

function reset() {
  state = require('./seed').buildSeed();
  save();
  return state;
}

module.exports = { load, save, reset, nextId, emptyState, FILE };
