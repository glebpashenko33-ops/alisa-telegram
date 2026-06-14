// =====================================================================
// shared/avitoApi.js — Avito API: отправка сообщений, восстановление истории
// =====================================================================

const { AD_STAFF_PRIORITY, STAFF, STAFF_FULLNAME } = require('./constants');

async function getAvitoToken() {
  const r = await fetch('https://api.avito.ru/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.AVITO_CLIENT_ID,
      client_secret: process.env.AVITO_CLIENT_SECRET,
    }),
  });
  const data = await r.json();
  if (!data.access_token) throw new Error('No token: ' + JSON.stringify(data));
  return data.access_token;
}

// Имитация задержки печати (ускорено в 2 раза)
function getTypingDelay(text) {
  const len = text.length;
  if (len <= 80) return 1000;
  if (len >= 200) return 1750;
  return 1000 + Math.round((len - 80) / 120 * 750);
}

// onSent(text) — необязательный коллбэк, вызывается перед отправкой,
// чтобы вызывающий код мог запомнить текст (botSentTexts) и не спутать
// эхо бота с ручным ответом владельца.
async function sendAvitoMessage(chatId, text, onSent) {
  const delay = getTypingDelay(text);
  console.log(`Typing delay: ${delay}ms for ${text.length} chars`);
  await new Promise(resolve => setTimeout(resolve, delay));

  if (onSent) onSent(text);

  const token = await getAvitoToken();
  const userId = process.env.AVITO_USER_ID;
  const r = await fetch(
    `https://api.avito.ru/messenger/v1/accounts/${userId}/chats/${chatId}/messages`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { text }, type: 'text' }),
    }
  );
  if (!r.ok) {
    console.error('Send error:', await r.text());
  } else {
    console.log('Sent OK');
  }
}

// Восстановление истории после перезапуска сервера
async function restoreHistoryFromAvito(chatId, getDialog) {
  try {
    const token = await getAvitoToken();
    const userId = process.env.AVITO_USER_ID;
    const r = await fetch(
      `https://api.avito.ru/messenger/v3/accounts/${userId}/chats/${chatId}/messages?limit=20`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    if (!r.ok) return null;
    const data = await r.json();
    if (!data.messages?.length) return 0;

    const msgs = [...data.messages].reverse(); // старые первые
    const d = getDialog(chatId);
    d.messages = [];

    for (const msg of msgs) {
      if (!msg.content?.text) continue;
      const isOur = String(msg.author_id) === String(userId);
      d.messages.push({ role: isOur ? 'assistant' : 'user', content: msg.content.text });
    }
    d.lastUpdated = Date.now();
    console.log(`Restored ${d.messages.length} messages for chat ${chatId}`);
    return data.messages.length;
  } catch (e) {
    console.error('restoreHistoryFromAvito error:', e.message);
    return null;
  }
}

// Узнаём, по какому объявлению пишет клиент (item_id из контекста чата)
async function getChatItemId(chatId) {
  try {
    const token = await getAvitoToken();
    const userId = process.env.AVITO_USER_ID;
    const r = await fetch(
      `https://api.avito.ru/messenger/v2/accounts/${userId}/chats/${chatId}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    if (!r.ok) return null;
    const data = await r.json();
    return data.context?.value?.id || null;
  } catch (e) {
    console.error('getChatItemId error:', e.message);
    return null;
  }
}

// Доп. инструкция в системный промпт, если клиент пишет по объявлению
// конкретного массажиста — приоритет на него, второй мастер только как
// альтернатива, если у первого нет слотов на нужное клиенту время.
function buildAdPriorityContext(itemId) {
  const priorityStaff = AD_STAFF_PRIORITY[itemId];
  if (!priorityStaff) return '';

  const priorityName = STAFF_FULLNAME[priorityStaff].split(' ')[1]; // имя
  const altStaff = priorityStaff === STAFF.NIKITA ? STAFF.PAVEL : STAFF.NIKITA;
  const altName = STAFF_FULLNAME[altStaff].split(' ')[1];

  return `\n\nВАЖНО: клиент пишет по объявлению массажиста ${priorityName}.
- На массаж в первую очередь предлагай и записывай к ${priorityName}, не упоминай ${altName} по умолчанию.
- Только если клиент называет конкретный день/время и у ${priorityName} на это время нет свободных слотов (а у ${altName} есть) — предложи ${altName} как альтернативу, объяснив что ${priorityName} в это время занят.`;
}

module.exports = {
  getAvitoToken,
  getTypingDelay,
  sendAvitoMessage,
  restoreHistoryFromAvito,
  getChatItemId,
  buildAdPriorityContext,
};
