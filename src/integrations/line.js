'use strict';
// LINE 通知アダプタ
//
// ・LINE_CHANNEL_ACCESS_TOKEN 未設定時は「モック送信」として DB に記録のみ（画面の LINE プレビューで確認可能）
// ・設定時は Messaging API の push で実送信（宛先に実 userId / groupId がある場合のみ）
// ・緊急募集ではグループへ textV2（メンション）＋ 個別に「対応できます / できません」ボタン（postback）を送る
//   スタッフがボタンを押すと /api/webhooks/line に postback が届き、先着で担当確定する

const crypto = require('crypto');
const { nextId } = require('../db');

const API = 'https://api.line.me/v2/bot/message/push';

function config() {
  return {
    token: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
    secret: process.env.LINE_CHANNEL_SECRET || '',
    groupId: process.env.LINE_STAFF_GROUP_ID || '',
    adminIds: (process.env.LINE_ADMIN_USER_IDS || '').split(',').filter(Boolean),
    baseUrl:
      process.env.PUBLIC_BASE_URL ||
      (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '') ||
      'http://localhost:3000',
  };
}

function isLive() {
  return Boolean(config().token);
}

function isRealLineId(id) {
  return typeof id === 'string' && /^[UCR][0-9a-f]{32}$/.test(id);
}

/**
 * 通知を記録（＋必要なら実送信）
 * @param {object} db
 * @param {{to:{type:'staff'|'group'|'admins', staffId?:string}, category:string, title:string, text:string,
 *          mentions?:string[], actions?:Array<{label:string, kind:'accept'|'decline'|'link', token?:string, url?:string}>,
 *          refs?:object}} msg
 */
function send(db, msg, now = Date.now()) {
  const rec = {
    id: nextId(db, 'ln'),
    at: new Date(now).toISOString(),
    to: msg.to,
    category: msg.category,
    title: msg.title,
    text: msg.text,
    mentions: msg.mentions || [],
    actions: msg.actions || [],
    refs: msg.refs || {},
    mode: 'mock',
    status: 'delivered',
  };

  const payload = buildPayload(db, rec);
  if (isLive() && payload && !db.meta.seeding) {
    rec.mode = 'live';
    rec.status = 'queued';
    dispatch(rec, payload);
  }

  db.notifications.unshift(rec);
  if (db.notifications.length > 2000) db.notifications.length = 2000;
  return rec;
}

/** Messaging API 用のペイロードを組み立てる（宛先 ID が無ければ null = モック扱い） */
function buildPayload(db, rec) {
  const cfg = config();
  let to = null;
  if (rec.to.type === 'staff') {
    const s = db.staff.find((x) => x.id === rec.to.staffId);
    to = s && isRealLineId(s.lineUserId) ? s.lineUserId : null;
  } else if (rec.to.type === 'group') {
    to = cfg.groupId || null;
  } else if (rec.to.type === 'admins') {
    to = cfg.adminIds[0] || null; // 複数管理者は multicast で拡張可
  }
  if (!to) return null;

  const messages = [];
  const mentionees = rec.mentions
    .map((id) => db.staff.find((s) => s.id === id))
    .filter((s) => s && isRealLineId(s.lineUserId));

  if (rec.to.type === 'group' && mentionees.length > 0) {
    // textV2: {key} をメンションに置換
    const substitution = {};
    const tags = mentionees.map((s, i) => {
      substitution[`m${i}`] = { type: 'mention', mentionee: { type: 'user', userId: s.lineUserId } };
      return `{m${i}}`;
    });
    messages.push({ type: 'textV2', text: `${tags.join(' ')}\n${rec.title}\n${rec.text}`.slice(0, 5000), substitution });
  } else {
    messages.push({ type: 'text', text: `${rec.title}\n${rec.text}`.slice(0, 5000) });
  }

  const buttons = rec.actions.slice(0, 4).map((a) => {
    if (a.kind === 'link') return { type: 'uri', label: a.label.slice(0, 20), uri: a.url };
    return {
      type: 'postback',
      label: a.label.slice(0, 20),
      data: `action=urgent&answer=${a.kind}&token=${a.token}`,
      displayText: a.kind === 'accept' ? '対応できます' : '今回は対応できません',
    };
  });
  if (buttons.length > 0) {
    messages.push({
      type: 'template',
      altText: rec.title.slice(0, 400),
      template: { type: 'buttons', text: '対応可否を選択してください', actions: buttons },
    });
  }
  return { to, messages };
}

function dispatch(rec, payload) {
  const { token } = config();
  setImmediate(async () => {
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      rec.status = res.ok ? 'sent' : 'failed';
      if (!res.ok) rec.error = `${res.status} ${await res.text()}`.slice(0, 300);
    } catch (e) {
      rec.status = 'failed';
      rec.error = String(e.message || e).slice(0, 300);
    }
    try {
      require('../db').save();
    } catch {
      /* noop */
    }
  });
}

/** Webhook 署名検証（x-line-signature） */
function verifySignature(rawBody, signature) {
  const { secret } = config();
  if (!secret) return true; // デモ・開発時は検証をスキップ
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function respondUrl(token) {
  return `${config().baseUrl}/r/${token}`;
}

module.exports = { send, isLive, verifySignature, respondUrl, buildPayload, config };
