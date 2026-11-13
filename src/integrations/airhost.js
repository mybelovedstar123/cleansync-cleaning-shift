'use strict';
// AirHost 清掃カレンダー連携アダプタ
//
// 連携方式（AIRHOST_MODE）
//   mock : 既定。登録内容を同期ログとして DB に保存（デモ用）
//   api  : AirHost 側で清掃タスク API が提供・契約できる場合に利用（AIRHOST_API_BASE / AIRHOST_API_KEY）
//   rpa  : API が無い場合の代替。同期ジョブをキューに積み、scripts/airhost-rpa-worker.js（Playwright）が
//          AirHost 管理画面の清掃カレンダーへ担当者を登録する
//
// どの方式でもサービス層からは register() だけを呼べばよいように抽象化している。

const { nextId } = require('../db');

function mode() {
  return (process.env.AIRHOST_MODE || 'mock').toLowerCase();
}

/**
 * 清掃カレンダーへの担当登録 / 変更 / 解除
 * @param {'assign'|'unassign'|'update'} action
 */
function register(db, cleaning, action, now = Date.now()) {
  const property = db.properties.find((p) => p.id === cleaning.propertyId);
  const staff = cleaning.staffId ? db.staff.find((s) => s.id === cleaning.staffId) : null;
  const m = db.meta.seeding ? 'mock' : mode();

  const job = {
    id: nextId(db, 'ah'),
    at: new Date(now).toISOString(),
    mode: m,
    action,
    cleaningId: cleaning.id,
    reservationId: cleaning.reservationId,
    airhostListingId: property ? property.airhostListingId : null,
    propertyName: property ? property.name : '',
    date: cleaning.date,
    startTime: cleaning.startTime,
    staffName: action === 'unassign' ? cleaning.prevStaffName || '' : staff ? staff.name : '',
    status: m === 'mock' ? 'success' : 'queued',
  };

  if (m === 'api' && !db.meta.seeding) {
    dispatchApi(job);
  }

  db.airhostSync.unshift(job);
  if (db.airhostSync.length > 2000) db.airhostSync.length = 2000;

  cleaning.airhost = {
    synced: job.status === 'success',
    status: job.status,
    lastAction: action,
    syncedAt: job.at,
  };
  return job;
}

/** API 方式（エンドポイントは AirHost との契約内容に合わせて調整が必要） */
function dispatchApi(job) {
  const base = process.env.AIRHOST_API_BASE;
  const key = process.env.AIRHOST_API_KEY;
  if (!base || !key) {
    job.status = 'failed';
    job.error = 'AIRHOST_API_BASE / AIRHOST_API_KEY が未設定です';
    return;
  }
  setImmediate(async () => {
    try {
      const res = await fetch(`${base.replace(/\/$/, '')}/cleaning_tasks`, {
        method: job.action === 'unassign' ? 'DELETE' : 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          listing_id: job.airhostListingId,
          reservation_id: job.reservationId,
          date: job.date,
          start_time: job.startTime,
          cleaner_name: job.staffName,
        }),
      });
      job.status = res.ok ? 'success' : 'failed';
      if (!res.ok) job.error = `${res.status}`;
    } catch (e) {
      job.status = 'failed';
      job.error = String(e.message || e).slice(0, 300);
    }
    try {
      require('../db').save();
    } catch {
      /* noop */
    }
  });
}

/** RPA ワーカーが処理待ちジョブを取得・完了報告するためのヘルパー */
function pendingJobs(db) {
  return db.airhostSync.filter((j) => j.status === 'queued').reverse();
}

function completeJob(db, jobId, ok, error) {
  const job = db.airhostSync.find((j) => j.id === jobId);
  if (!job) return null;
  job.status = ok ? 'success' : 'failed';
  if (error) job.error = String(error).slice(0, 300);
  const c = db.cleanings.find((x) => x.id === job.cleaningId);
  if (c && c.airhost) {
    c.airhost.synced = ok;
    c.airhost.status = job.status;
  }
  return job;
}

module.exports = { register, mode, pendingJobs, completeJob };
