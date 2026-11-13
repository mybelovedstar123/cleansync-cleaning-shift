/**
 * AirHost 予約通知メール → CleanSync 転送スクリプト（Google Apps Script）
 *
 * 設置手順
 *  1. 予約通知メールを受信している Gmail アカウントで https://script.google.com を開き、新規プロジェクトに貼り付け
 *  2. ENDPOINT / SECRET / QUERY を環境に合わせて変更（SECRET はサーバーの EMAIL_WEBHOOK_SECRET と同じ値）
 *  3. トリガーで forwardAirhostMails を「時間主導型・1分ごと」に設定
 *
 * ・メッセージ単位で処理済み ID を記録するため、同じスレッドに届いた変更・キャンセルメールも取りこぼさない
 * ・解析に失敗したメールはサーバー側で管理者へ LINE 通知される
 */
const ENDPOINT = 'https://YOUR-DOMAIN/api/webhooks/email';
const SECRET = 'CHANGE_ME';
// 実際の送信元アドレス・件名に合わせて調整してください
const QUERY = 'newer_than:2d (from:airhost OR subject:予約)';
const PROCESSED_KEY = 'cleansync_processed_ids';

function forwardAirhostMails() {
  const props = PropertiesService.getScriptProperties();
  const processed = new Set(JSON.parse(props.getProperty(PROCESSED_KEY) || '[]'));
  const threads = GmailApp.search(QUERY, 0, 50);

  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (msg) {
      const id = msg.getId();
      if (processed.has(id)) return;
      const res = UrlFetchApp.fetch(ENDPOINT, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'X-Webhook-Secret': SECRET },
        payload: JSON.stringify({ subject: msg.getSubject(), body: msg.getPlainBody(), messageId: id, receivedAt: msg.getDate().toISOString() }),
        muteHttpExceptions: true,
      });
      const code = res.getResponseCode();
      // 2xx（取込成功）と 4xx（解析不可・重複＝再送しても同じ）は処理済みにする。5xx は次回再試行
      if (code < 500) processed.add(id);
      console.log(code + ' ' + msg.getSubject());
    });
  });

  props.setProperty(PROCESSED_KEY, JSON.stringify(Array.from(processed).slice(-800)));
}
