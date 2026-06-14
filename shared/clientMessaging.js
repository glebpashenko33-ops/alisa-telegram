// =====================================================================
// shared/clientMessaging.js — универсальная отправка ответа клиенту
// (Avito или Telegram Business), выбор канала по chatId
// =====================================================================

const { getTypingDelay, sendAvitoMessage } = require('./avitoApi');

// Отправка сообщения клиенту в Telegram (chatId формата "tg_<id>") —
// от имени личного аккаунта через Telegram Business.
//
// getDialog(chatId) — функция получения диалога (для businessConnectionId)
// businessConnectionId — глобальный fallback id подключения (из webhook'а)
// onSent(text) — коллбэк, вызывается перед отправкой (для botSentTexts)
async function sendClientTelegramMessage(chatId, text, { getDialog, businessConnectionId, onSent } = {}) {
  const delay = getTypingDelay(text);
  await new Promise(resolve => setTimeout(resolve, delay));

  const token = process.env.CLIENT_TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const tgId = chatId.slice('tg_'.length);
  const dialog = getDialog ? getDialog(chatId) : null;
  const connId = dialog?.businessConnectionId || businessConnectionId;

  if (onSent) onSent(text);

  try {
    const body = { chat_id: tgId, text };
    if (connId) body.business_connection_id = connId;
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) console.error('Client TG send error:', await r.text());
  } catch (e) {
    console.error('Client TG send error:', e.message);
  }
}

// Универсальная отправка ответа клиенту — выбирает канал по chatId
async function sendClientMessage(chatId, text, opts = {}) {
  if (String(chatId).startsWith('tg_')) {
    await sendClientTelegramMessage(chatId, text, opts);
  } else {
    await sendAvitoMessage(chatId, text, opts.onSent);
  }
}

module.exports = {
  sendClientTelegramMessage,
  sendClientMessage,
};
