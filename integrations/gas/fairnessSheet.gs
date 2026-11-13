/**
 * 公平性管理シート 受信用 Web アプリ（Google Apps Script）
 *
 * 設置手順
 *  1. 公平性管理用のスプレッドシートで「拡張機能 → Apps Script」を開き貼り付け
 *  2. 「デプロイ → 新しいデプロイ → ウェブアプリ」（実行ユーザー: 自分 / アクセス: 全員）
 *  3. 発行された URL をサーバーの GOOGLE_SHEETS_WEBHOOK_URL に設定
 *
 * 割当・変更・キャンセルのたびに「YYYY-MM」シートが最新状態に上書きされる。
 */
function doPost(e) {
  const data = JSON.parse(e.postData.contents);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(data.month) || ss.insertSheet(data.month);
  sheet.clearContents();

  const header = ['スタッフID', '氏名', '勤務可能日数', '清掃件数', '拘束時間(h)', '期待拘束時間(h)', '差分(h)', '公平比', '割当率(%)'];
  const rows = data.rows.map(function (r) {
    return [r.staffId, r.name, r.availableDays, r.count, r.hours, r.expectedHours, r.diffHours, r.ratio, r.share];
  });
  sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  if (rows.length) sheet.getRange(2, 1, rows.length, header.length).setValues(rows);
  const foot = rows.length + 3;
  sheet.getRange(foot, 1, 2, 2).setValues([
    ['総拘束時間(h)', data.totalHours],
    ['公平性スコア', data.score],
  ]);
  sheet.getRange(foot + 2, 1).setValue('最終更新: ' + new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }));

  return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
}
