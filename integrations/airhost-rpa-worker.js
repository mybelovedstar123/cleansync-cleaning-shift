'use strict';
/**
 * AirHost 清掃カレンダー登録 RPA ワーカー（テンプレート）
 *
 * AirHost 側に清掃タスク登録 API が無い場合の代替手段。
 * サーバーを AIRHOST_MODE=rpa で起動すると、割当・解除のたびに登録ジョブがキューに積まれ、
 * このワーカーが Playwright で AirHost 管理画面を操作して担当者を登録する。
 *
 *   npm i playwright && npx playwright install chromium
 *   CLEANSYNC_URL=http://localhost:3000 AIRHOST_WORKER_SECRET=... \
 *   AIRHOST_LOGIN_URL=... AIRHOST_CLEANING_URL_TEMPLATE=... AIRHOST_LOGIN_ID=... AIRHOST_PASSWORD=... \
 *   node integrations/airhost-rpa-worker.js
 *
 * ※ 画面のセレクタ（SELECTORS）は AirHost の実画面を確認して確定させる必要があります（下記は仮置き）。
 *   本番導入時は画面変更の検知（失敗時に管理者へ通知）とスクリーンショット保存を併用します。
 */

const BASE = process.env.CLEANSYNC_URL || 'http://localhost:3000';
const SECRET = process.env.AIRHOST_WORKER_SECRET || '';
const INTERVAL_MS = 30_000;

// TODO: AirHost の実画面に合わせて確定する（URL は環境変数で指定。{listingId} {date} を置換）
const SELECTORS = {
  loginUrl: process.env.AIRHOST_LOGIN_URL || '',
  loginId: 'input[type="email"]',
  password: 'input[type="password"]',
  submit: 'button[type="submit"]',
  cleaningCalendarUrl: (listingId, date) =>
    (process.env.AIRHOST_CLEANING_URL_TEMPLATE || '').replace('{listingId}', encodeURIComponent(listingId)).replace('{date}', date),
  taskCell: (date) => `[data-date="${date}"]`,
  assigneeSelect: 'select[name="cleaner"]',
  save: 'button:has-text("保存")',
};

async function api(path, init = {}) {
  const res = await fetch(BASE + path, { ...init, headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': SECRET, ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

async function processJob(page, job) {
  await page.goto(SELECTORS.cleaningCalendarUrl(job.airhostListingId, job.date));
  await page.click(SELECTORS.taskCell(job.date));
  if (job.action === 'unassign') {
    await page.selectOption(SELECTORS.assigneeSelect, '');
  } else {
    await page.selectOption(SELECTORS.assigneeSelect, { label: job.staffName });
  }
  await page.click(SELECTORS.save);
  await page.waitForLoadState('networkidle');
}

async function main() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.error('playwright が見つかりません: npm i playwright && npx playwright install chromium');
    process.exit(1);
  }
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(SELECTORS.loginUrl);
  await page.fill(SELECTORS.loginId, process.env.AIRHOST_LOGIN_ID || '');
  await page.fill(SELECTORS.password, process.env.AIRHOST_PASSWORD || '');
  await page.click(SELECTORS.submit);
  await page.waitForLoadState('networkidle');

  for (;;) {
    try {
      const jobs = await api('/api/airhost/jobs/pending');
      for (const job of jobs) {
        try {
          await processJob(page, job);
          await api(`/api/airhost/jobs/${job.id}/complete`, { method: 'POST', body: JSON.stringify({ ok: true }) });
          console.log('done', job.id, job.action, job.propertyName, job.date, job.staffName);
        } catch (e) {
          await page.screenshot({ path: `rpa-error-${job.id}.png` }).catch(() => {});
          await api(`/api/airhost/jobs/${job.id}/complete`, { method: 'POST', body: JSON.stringify({ ok: false, error: String(e.message || e) }) });
          console.error('failed', job.id, e.message);
        }
      }
    } catch (e) {
      console.error('poll failed', e.message);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main();
