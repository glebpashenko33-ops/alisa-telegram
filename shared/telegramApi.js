// =====================================================================
// shared/telegramApi.js — Telegram (админ/уведомления) + Whisper
// =====================================================================

async function sendTelegram(message, chatId) {
  const tgChatId = chatId || process.env.TELEGRAM_CHAT_ID;
  if (!process.env.TELEGRAM_BOT_TOKEN || !tgChatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tgChatId, text: message, parse_mode: 'HTML' }),
    });
  } catch (e) {
    console.error('Telegram error:', e.message);
  }
}

// Отправка с возвратом message_id — нужно, чтобы потом можно было удалить пост
async function sendTelegramWithId(message, chatId) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !chatId) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
    });
    const data = await r.json();
    if (!data.ok) {
      console.error(`Telegram sendMessage to ${chatId} failed: ${data.error_code} ${data.description}`);
      return null;
    }
    return data.result?.message_id || null;
  } catch (e) {
    console.error('Telegram error:', e.message);
    return null;
  }
}

async function deleteTelegramMessage(chatId, messageId) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !chatId || !messageId) return;
  try {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
  } catch (e) {
    console.error('Telegram delete error:', e.message);
  }
}

// --- Голосовые команды (Whisper) ---
async function downloadTelegramFile(fileId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const infoR = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  const info = await infoR.json();
  if (!info.ok) throw new Error('getFile failed: ' + JSON.stringify(info));
  const filePath = info.result.file_path;
  const fileR = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!fileR.ok) throw new Error('File download failed');
  return { buffer: Buffer.from(await fileR.arrayBuffer()), filePath };
}

async function transcribeVoice(fileId) {
  const { buffer, filePath } = await downloadTelegramFile(fileId);
  const ext = filePath.split('.').pop() || 'ogg';
  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
  const filename = `voice.${ext}`;

  const header = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: audio/ogg\r\n\r\n`
  );
  const modelPart = Buffer.from(
    `\r\n--${boundary}\r\n` +
    `Content-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="language"\r\n\r\nru\r\n` +
    `--${boundary}--\r\n`
  );

  const body = Buffer.concat([header, buffer, modelPart]);
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  if (!r.ok) throw new Error('Whisper API error: ' + await r.text());
  const data = await r.json();
  return data.text || '';
}

module.exports = {
  sendTelegram,
  sendTelegramWithId,
  deleteTelegramMessage,
  downloadTelegramFile,
  transcribeVoice,
};
