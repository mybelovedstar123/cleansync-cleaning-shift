'use strict';
// 業務イベントログ（ダッシュボードのタイムライン表示・監査用）

const { nextId } = require('./db');

/**
 * @param {object} db
 * @param {{type:string, level?:'info'|'success'|'warning'|'danger', message:string, refs?:object}} ev
 * @param {number} [now]
 */
function logEvent(db, ev, now = Date.now()) {
  const rec = {
    id: nextId(db, 'ev'),
    at: new Date(now).toISOString(),
    level: ev.level || 'info',
    type: ev.type,
    message: ev.message,
    refs: ev.refs || {},
  };
  db.events.unshift(rec);
  if (db.events.length > 1000) db.events.length = 1000;
  return rec;
}

module.exports = { logEvent };
