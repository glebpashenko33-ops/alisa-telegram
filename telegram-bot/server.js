// =====================================================================
// АЛИНА — Бизнес-ассистент владельца (Telegram), telegram-bot
// =====================================================================
// Админский бот: команды владельца в Telegram (аналитика, расписание,
// управление промптом, пауза/старт), голосовые команды (Whisper),
// демо-голоса (OpenAI TTS), а также плановые отчёты и автопостинг
// скидочных окон в канал.
// =====================================================================

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db');

const { STAFF, STAFF_FULLNAME, SERVICES } = require('../shared/constants');
const { nowMoscow, todayMoscow, fmtDate, addDaysISO, pick, computeSendWindow } = require('../shared/time');
const {
  getFreeSlots, getMassageSlots, findClient, setRecordAttendance, getRecordsForPeriod,
} = require('../shared/yclients');
const { sendTelegram, deleteTelegramMessage, transcribeVoice } = require('../shared/telegramApi');
const { getActivePrompt, SYSTEM_PROMPT } = require('../shared/prompt');
const {
  buildDayAnalytics, buildMonthAnalytics, buildWeekAnalytics, countNextWeekStats,
  formatDayReport, formatMonthReport, formatWeekReport, formatDayCloseReport,
} = require('../shared/analytics');
const { postDiscountWindow, postDailySlots } = require('../shared/discounts');
const { normalizePhone } = require('../shared/bookingExtract');
const {
  buildReviewMessage, buildSocialMessage,
  buildTouch1Message, buildTouch2Message, buildTouch3Message,
  buildDayBeforeMessage, buildMorningReminderMessage, buildConfirmThanksMessage,
  buildCancelMessage, buildBookingConfirmMessage, buildAdminEscalationMessage,
} = require('../shared/messages');
const { sendClientMessage } = require('../shared/clientMessaging');
const { createConversationEngine } = require('../shared/conversationEngine');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const engine = createConversationEngine({ anthropic });
const {
  getDialog, addMessage, getMessages, clearDialog, dialogs,
  enqueueMessage, generateReminder,
  setHumanTaken, getHumanTakenAt, clearHumanTakenLocalOrDb,
  botSentTexts, registerBotSentText,
  setBusinessConnection, getBusinessConnectionId, getBusinessOwnerId,
} = engine;

// =====================================================================
// Telegram-команды от владельца
// =====================================================================
async function handleTelegramCommand(text, fromChatId) {
  const t = text.trim().toLowerCase();

  if (t === '/статистика' || t === '/stat') {
    // ПРИМЕЧАНИЕ: после разделения на сервисы "Алина" (диалоги с клиентами)
    // работает в отдельном процессе (avito-bot), поэтому здесь нет доступа
    // к in-memory объекту dialogs. Показываем то, что доступно тут.
    await sendTelegram(
      `📊 <b>Статистика Алины</b>\n\n` +
      `⏱ Время сервера: ${nowMoscow().toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК\n\n` +
      `<i>Статистика по активным диалогам ведётся в сервисе avito-bot и здесь недоступна.</i>\n\n` +
      `Команды:\n/статистика — эта сводка\n/записи — слоты на сегодня\n/пауза — приостановить Алину\n/старт — возобновить`,
      fromChatId
    );
    return;
  }

  if (t === '/записи' || t === '/slots') {
    const today = todayMoscow();
    try {
      const [alex, massage] = await Promise.all([
        getFreeSlots(today, STAFF.ALEXANDER),
        getMassageSlots(today),
      ]);
      await sendTelegram(
        `📅 <b>Свободные слоты на сегодня (${fmtDate(today)})</b>\n\n` +
        `👨‍⚕️ <b>Александр:</b> ${alex.length ? alex.join(', ') : 'нет мест'}\n` +
        `💆 <b>Массажисты:</b> ${massage.slots.length ? massage.slots.join(', ') : 'нет мест'}`,
        fromChatId
      );
    } catch (e) {
      await sendTelegram('Ошибка получения слотов: ' + e.message, fromChatId);
    }
    return;
  }

  if (t === '/пауза' || t === '/pause' || t === '/stop') {
    await db.setSetting('alina_paused_avito', 'true');
    await db.setSetting('alina_paused_telegram', 'true');
    await sendTelegram('⏸ Алина на паузе везде (Avito и Telegram). Сообщения не обрабатываются.\nОтправь /старт чтобы возобновить.', fromChatId);
    return;
  }

  if (t === '/старт' || t === '/start') {
    await db.setSetting('alina_paused_avito', '');
    await db.setSetting('alina_paused_telegram', '');
    await sendTelegram('▶️ Алина снова работает везде (Avito и Telegram)!', fromChatId);
    return;
  }

  if (t === '/стоп_авито' || t === '/пауза_авито') {
    await db.setSetting('alina_paused_avito', 'true');
    await sendTelegram('⏸ Алина на паузе в Avito. Telegram-чаты клиентов работают как обычно.\nОтправь /старт_авито чтобы возобновить.', fromChatId);
    return;
  }

  if (t === '/старт_авито') {
    await db.setSetting('alina_paused_avito', '');
    await sendTelegram('▶️ Алина снова отвечает в Avito!', fromChatId);
    return;
  }

  if (t === '/стоп_телеграм' || t === '/пауза_телеграм') {
    await db.setSetting('alina_paused_telegram', 'true');
    await sendTelegram('⏸ Алина на паузе в Telegram-чатах клиентов. Avito работает как обычно.\nОтправь /старт_телеграм чтобы возобновить.', fromChatId);
    return;
  }

  if (t === '/старт_телеграм') {
    await db.setSetting('alina_paused_telegram', '');
    await sendTelegram('▶️ Алина снова отвечает в Telegram-чатах клиентов!', fromChatId);
    return;
  }

  if (t.startsWith('/день') || t.startsWith('/day')) {
    await sendTelegram('⏳ Загружаю данные из YCLIENTS...', fromChatId);
    try {
      const parts = text.trim().split(/\s+/);
      let date = todayMoscow();
      if (parts[1] && /^\d{4}-\d{2}-\d{2}$/.test(parts[1])) {
        date = parts[1];
      } else if (parts[1] === 'вчера') {
        const d = nowMoscow();
        d.setDate(d.getDate() - 1);
        date = d.toISOString().split('T')[0];
      }
      const analytics = await buildDayAnalytics(date);
      await sendTelegram(formatDayReport(analytics), fromChatId);
    } catch (e) {
      await sendTelegram('❌ Ошибка: ' + e.message, fromChatId);
    }
    return;
  }

  if (t.startsWith('/месяц') || t.startsWith('/month')) {
    await sendTelegram('⏳ Загружаю данные за месяц...', fromChatId);
    try {
      const now = nowMoscow();
      let year = now.getFullYear();
      let month = now.getMonth() + 1;
      const parts = text.trim().split(/\s+/);
      if (parts[1]) { const m = parseInt(parts[1]); if (m >= 1 && m <= 12) month = m; }
      if (parts[2]) { const y = parseInt(parts[2]); if (y > 2020) year = y; }
      const analytics = await buildMonthAnalytics(year, month);
      await sendTelegram(formatMonthReport(analytics), fromChatId);
    } catch (e) {
      await sendTelegram('❌ Ошибка: ' + e.message, fromChatId);
    }
    return;
  }

  if (t === '/помощь' || t === '/help') {
    await sendTelegram(
      `🤖 <b>Бизнес-ассистент Алины</b>\n\n` +
      `<b>Аналитика:</b>\n/день — сводка за сегодня\n/день вчера — сводка за вчера\n/день 2025-05-28 — конкретная дата\n/месяц — текущий месяц\n/месяц 4 — апрель этого года\n/месяц 4 2025 — апрель 2025\n\n` +
      `<b>Расписание:</b>\n/записи — свободные слоты сегодня\n/статистика — диалоги Алины\n\n` +
      `<b>Управление:</b>\n/пауза — остановить Алину везде\n/старт — возобновить везде\n/стоп_авито, /старт_авито — только Avito\n/стоп_телеграм, /старт_телеграм — только Telegram-чаты клиентов\n/отдать_алине — список перехваченных диалогов\n/отдать_алине <id> — вернуть диалог Алине досрочно\n\n` +
      `<b>Промпт:</b>\n/промпт — показать текущий промпт\n/промпт_заменить — заменить промпт\n/промпт_история — последние 5 версий\n/промпт_откатить N — откатить на версию N\n/промпт_сброс — сбросить на дефолтный из кода\n\n` +
      `<b>Настройки:</b>\n/настройки — все ключи в БД`,
      fromChatId
    );
    return;
  }

  // =====================================================================
  // Управление промптом через Telegram
  // =====================================================================

  if (t === '/промпт') {
    try {
      const prompt = await getActivePrompt();
      const preview = prompt.substring(0, 500);
      const hasMore = prompt.length > 500;
      await sendTelegram(
        `📝 <b>Текущий промпт Алины</b> (${prompt.length} символов)\n\n` +
        `<pre>${preview.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>` +
        (hasMore ? `\n\n<i>...ещё ${prompt.length - 500} символов. Отправь /промпт_полный чтобы получить весь текст.</i>` : ''),
        fromChatId
      );
    } catch (e) {
      await sendTelegram('❌ Ошибка: ' + e.message, fromChatId);
    }
    return;
  }

  if (t === '/промпт_полный') {
    try {
      const prompt = await getActivePrompt();
      // Telegram ограничивает сообщение до 4096 символов — режем на части
      const chunkSize = 3800;
      for (let i = 0; i < prompt.length; i += chunkSize) {
        const chunk = prompt.substring(i, i + chunkSize);
        await sendTelegram(
          `<pre>${chunk.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`,
          fromChatId
        );
      }
    } catch (e) {
      await sendTelegram('❌ Ошибка: ' + e.message, fromChatId);
    }
    return;
  }

  if (t === '/промпт_заменить') {
    // Устанавливаем флаг ожидания нового промпта от этого чата
    await db.setSetting(`awaiting_prompt_${fromChatId}`, '1');
    await sendTelegram(
      `✏️ <b>Режим замены промпта</b>\n\nОтправь новый текст промпта следующим сообщением.\n\n` +
      `⚠️ Текущий промпт будет сохранён в истории — его можно восстановить через /промпт_история\n\n` +
      `Для отмены отправь /отмена`,
      fromChatId
    );
    return;
  }

  if (t === '/отмена') {
    await db.setSetting(`awaiting_prompt_${fromChatId}`, '0');
    await sendTelegram('✅ Отменено.', fromChatId);
    return;
  }

  if (t.startsWith('/отдать_алине')) {
    const parts = text.trim().split(/\s+/);
    const targetChat = parts[1];
    if (!targetChat) {
      // ПРИМЕЧАНИЕ: после разделения на сервисы "перехваченные" чаты хранятся
      // в таблице human_taken_chats (БД) без отдельной функции построения
      // полного списка — показываем упрощённую подсказку.
      await sendTelegram(
        `Список перехваченных диалогов недоступен в этом сервисе.\n\n` +
        `Отправь /отдать_алине <chat_id> чтобы вернуть конкретный диалог Алине.`,
        fromChatId
      );
      return;
    }
    if (process.env.DATABASE_URL) {
      await db.clearHumanTaken(targetChat);
    }
    await sendTelegram(`✅ Диалог <code>${targetChat}</code> возвращён Алине.`, fromChatId);
    return;
  }

  if (t === '/промпт_история') {
    try {
      const history = await db.getPromptHistory();
      if (!history.length) {
        await sendTelegram('История промптов пуста.', fromChatId);
        return;
      }
      let msg = `🕘 <b>Последние версии промпта:</b>\n\n`;
      for (const row of history) {
        const date = new Date(row.created_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
        const preview = row.preview.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, ' ');
        msg += `<b>v${row.id}</b> — ${date}\n<i>${preview}...</i>\n\n`;
      }
      msg += `Для отката: /промпт_откатить N`;
      await sendTelegram(msg, fromChatId);
    } catch (e) {
      await sendTelegram('❌ Ошибка: ' + e.message, fromChatId);
    }
    return;
  }

  if (t.startsWith('/промпт_откатить')) {
    const parts = text.trim().split(/\s+/);
    const versionId = parseInt(parts[1]);
    if (!versionId) {
      await sendTelegram('Укажи номер версии: /промпт_откатить 3', fromChatId);
      return;
    }
    try {
      const result = await db.rollbackPrompt(versionId);
      if (result.ok) {
        await sendTelegram(`✅ Промпт откачен на версию ${versionId}. Алина применит его в течение 30 секунд.`, fromChatId);
      } else {
        await sendTelegram(`❌ Не удалось откатить: ${result.error}`, fromChatId);
      }
    } catch (e) {
      await sendTelegram('❌ Ошибка: ' + e.message, fromChatId);
    }
    return;
  }

  if (t === '/промпт_сброс') {
    try {
      const ok = await db.setPrompt(SYSTEM_PROMPT);
      if (ok) {
        await sendTelegram(
          `✅ Промпт сброшен на дефолтный из кода. Алина применит его в течение 30 секунд.\n\nДля отката: /промпт_история`,
          fromChatId
        );
      } else {
        await sendTelegram('❌ Не удалось сохранить промпт в БД.', fromChatId);
      }
    } catch (e) {
      await sendTelegram('❌ Ошибка: ' + e.message, fromChatId);
    }
    return;
  }

  if (t === '/настройки') {
    try {
      const settings = await db.getAllSettings();
      // Фильтруем служебные ключи ожидания промпта
      const visible = settings.filter(s => !s.key.startsWith('awaiting_prompt_'));
      if (!visible.length) {
        await sendTelegram('В БД нет настроек.', fromChatId);
        return;
      }
      let msg = `⚙️ <b>Настройки в БД:</b>\n\n`;
      for (const row of visible) {
        const date = new Date(row.updated_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
        const val = row.value.length > 80 ? row.value.substring(0, 80) + '...' : row.value;
        msg += `<b>${row.key}</b>\n${val}\n<i>обновлено: ${date}</i>\n\n`;
      }
      await sendTelegram(msg, fromChatId);
    } catch (e) {
      await sendTelegram('❌ Ошибка: ' + e.message, fromChatId);
    }
    return;
  }

  // Перехватываем сообщение если владелец находится в режиме ввода нового промпта
  const awaitingPrompt = await db.getSetting(`awaiting_prompt_${fromChatId}`);
  if (awaitingPrompt === '1' && text.trim().length > 50) {
    try {
      await db.setSetting(`awaiting_prompt_${fromChatId}`, '0');
      const ok = await db.setPrompt(text.trim());
      if (ok) {
        await sendTelegram(
          `✅ <b>Промпт обновлён!</b>\n\nАлина применит новый промпт в течение 30 секунд (кэш).\n\nДля отката: /промпт_история`,
          fromChatId
        );
      } else {
        await sendTelegram('❌ Не удалось сохранить промпт в БД. Проверь подключение к PostgreSQL.', fromChatId);
      }
    } catch (e) {
      await sendTelegram('❌ Ошибка при сохранении промпта: ' + e.message, fromChatId);
    }
    return;
  }
}

// Главный обработчик свободного диалога владельца (голос или текст).
// Определяет намерение и либо выполняет команду, либо редактирует промпт,
// либо просто отвечает как ассистент.
async function handleOwnerMessage(text, fromChatId) {
  const today = todayMoscow();
  const now = nowMoscow();
  const currentPrompt = await getActivePrompt();

  // Просим Claude определить намерение и сразу сформировать результат
  const intentResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    system: `Ты — внутренний ассистент владельца центра восстановления "Боли.Нет".
Тебе пишет владелец бизнеса через Telegram (голосом или текстом).
Сегодня: ${today}. Текущий месяц: ${now.getMonth() + 1}, год: ${now.getFullYear()}.

У тебя есть два инструмента:
1. Выполнить системную команду (аналитика, расписание, пауза)
2. Изменить промпт Алины (AI-администратора на Авито)
3. Просто ответить на вопрос

ТЕКУЩИЙ ПРОМПТ АЛИНЫ (для контекста при изменениях):
${currentPrompt.substring(0, 3000)}${currentPrompt.length > 3000 ? '\n...(промпт обрезан для контекста)' : ''}

Верни ответ строго в формате JSON (без markdown, без \`\`\`):
{
  "intent": "command" | "edit_prompt" | "answer",
  "command": "/день" | "/день вчера" | "/день YYYY-MM-DD" | "/месяц" | "/месяц N" | "/месяц N YYYY" | "/записи" | "/статистика" | "/пауза" | "/старт" | "/стоп_авито" | "/старт_авито" | "/стоп_телеграм" | "/старт_телеграм" | "/помощь" — ТОЛЬКО если intent=command,
  "new_prompt": "полный новый текст промпта" — ТОЛЬКО если intent=edit_prompt,
  "edit_description": "что именно изменил в промпте, 1-2 предложения" — ТОЛЬКО если intent=edit_prompt,
  "answer": "текст ответа владельцу" — ТОЛЬКО если intent=answer
}

Правила для edit_prompt:
- Возвращай ПОЛНЫЙ промпт с внесёнными изменениями, не только изменённый кусок
- Если просят поменять цену — найди в промпте эту строку и замени число
- Если просят изменить поведение/характер — найди нужный раздел и отредактируй
- Если просят добавить правило — добавь в подходящий раздел
- Сохраняй структуру и стиль промпта`,
    messages: [{ role: 'user', content: text }],
  });

  let parsed;
  try {
    let raw = intentResponse.content[0].text.trim();
    // Убираем markdown-блоки если Claude всё же добавил
    raw = raw.replace(/```json|```/g, '').trim();
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error('handleOwnerMessage: не удалось распарсить JSON:', intentResponse.content[0].text);
    // Если не распарсилось — отвечаем текстом как есть
    await sendTelegram(intentResponse.content[0].text, fromChatId);
    return;
  }

  console.log('Owner intent:', parsed.intent, parsed.command || parsed.edit_description || '');

  if (parsed.intent === 'command' && parsed.command) {
    await handleTelegramCommand(parsed.command, fromChatId);
    return;
  }

  if (parsed.intent === 'edit_prompt' && parsed.new_prompt) {
    const ok = await db.setPrompt(parsed.new_prompt.trim());
    if (ok) {
      await sendTelegram(
        `✅ <b>Промпт обновлён</b>\n\n${parsed.edit_description || 'Изменения применены.'}\n\n` +
        `Алина применит новый промпт в течение 30 секунд.\n` +
        `Для отката: /промпт_история`,
        fromChatId
      );
    } else {
      await sendTelegram('❌ Не удалось сохранить промпт. Проверь подключение к PostgreSQL.', fromChatId);
    }
    return;
  }

  if (parsed.intent === 'answer' && parsed.answer) {
    await sendTelegram(parsed.answer, fromChatId);
    return;
  }

  // Запасной вариант если структура ответа неожиданная
  await sendTelegram('Не понял запрос. Попробуй переформулировать или используй /помощь', fromChatId);
}

// =====================================================================
// EXPRESS ROUTES
// =====================================================================

app.get('/', (req, res) => {
  res.json({ status: 'Алина (telegram-bot) работает', time: nowMoscow().toISOString(), timezone: 'GMT+3' });
});

app.post('/telegram-webhook', async (req, res) => {
  res.json({ ok: true });
  try {
    const { message } = req.body;
    if (!message) return;
    const fromChatId = String(message.chat.id);
    if (fromChatId !== String(process.env.TELEGRAM_CHAT_ID)) return;

    // Текстовые сообщения: слэш-команды идут напрямую, свободный текст — через AI
    if (message.text) {
      const txt = message.text.trim();
      if (txt.startsWith('/')) {
        await handleTelegramCommand(txt, fromChatId);
      } else {
        await handleOwnerMessage(txt, fromChatId);
      }
      return;
    }

    // Голосовые сообщения: Whisper → свободный диалог через AI
    if (message.voice) {
      await sendTelegram('🎙 Слушаю...', fromChatId);
      try {
        const transcript = await transcribeVoice(message.voice.file_id);
        console.log('Voice transcript:', transcript);
        if (!transcript) {
          await sendTelegram('Не удалось распознать. Попробуй ещё раз или напиши текстом.', fromChatId);
          return;
        }
        await sendTelegram(`🗣 <i>${transcript}</i>`, fromChatId);
        await handleOwnerMessage(transcript, fromChatId);
      } catch (e) {
        console.error('Voice error:', e.message);
        if (e.message.includes('OPENAI_API_KEY') || e.message.includes('Whisper')) {
          await sendTelegram(
            '❌ Для голосовых команд нужен OpenAI API ключ.\n\nДобавь в Railway: <code>OPENAI_API_KEY = sk-...</code>',
            fromChatId
          );
        } else {
          await sendTelegram('❌ Ошибка: ' + e.message, fromChatId);
        }
      }
    }
  } catch (e) {
    console.error('TG webhook error:', e.message);
  }
});

app.get('/setup-webhook', async (req, res) => {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return res.status(400).json({ error: 'TELEGRAM_BOT_TOKEN не задан' });
    const webhookUrl = `https://${req.get('host')}/telegram-webhook`;
    const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl }),
    });
    const data = await r.json();
    res.json({ success: r.ok, webhook_url: webhookUrl, response: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/client-telegram-webhook', async (req, res) => {
  res.json({ ok: true });
  try {
    const paused = (await db.getSetting('alina_paused_telegram')) === 'true';
    if (paused) {
      console.log('Алина на паузе (Telegram Business)');
      return;
    }

    const update = req.body;

    // Подключение/обновление Telegram Business — запоминаем id подключения и владельца
    if (update.business_connection) {
      const conn = update.business_connection;
      setBusinessConnection(conn.id, conn.user?.id);
      console.log(`Telegram Business connection: id=${conn.id}, owner=${conn.user?.id}, enabled=${conn.is_enabled}`);
      return;
    }

    const msg = update.business_message;
    if (!msg?.text || !msg.chat?.id) return;

    const chatId = 'tg_' + msg.chat.id;
    if (msg.business_connection_id) setBusinessConnection(msg.business_connection_id);

    // Сообщение от самого владельца (написал клиенту вручную с телефона)
    const businessOwnerId = getBusinessOwnerId();
    if (businessOwnerId && String(msg.from?.id) === String(businessOwnerId)) {
      if (botSentTexts.has(msg.text)) {
        console.log('Skipping bot echo (Telegram Business)');
        return;
      }
      await setHumanTaken(chatId);
      console.log(`Chat ${chatId} taken over by human via Telegram (4h pause)`);
      await sendTelegram(
        `👤 <b>Диалог перехвачен (Telegram)</b>\n\nЧат: <code>${chatId}</code>\nАлина молчит 4 часа.\n\nОтправь /отдать_алине ${chatId} чтобы вернуть раньше.`
      );
      return;
    }

    // Диалог перехвачен владельцем — Алина молчит
    const takenAt = await getHumanTakenAt(chatId);
    if (takenAt) {
      if (Date.now() - takenAt < 4 * 60 * 60 * 1000) {
        console.log(`Chat ${chatId} is human-taken, skipping`);
        return;
      }
      await clearHumanTakenLocalOrDb(chatId);
    }

    const dialog = getDialog(chatId);
    if (msg.business_connection_id) dialog.businessConnectionId = msg.business_connection_id;

    // Подтверждение визита по напоминанию за день/утром ("+")
    if (msg.text.trim() === '+') {
      const pending = await db.getPendingConfirmation(chatId);
      if (pending) {
        await db.markVisitConfirmed(pending.id);
        if (pending.record_hash) {
          await setRecordAttendance(pending.record_id, pending.record_hash, 2);
        }
        addMessage(chatId, 'user', msg.text);
        const thanks = buildConfirmThanksMessage(pending.start_time);
        await sendClientMessage(chatId, thanks, { getDialog, businessConnectionId: getBusinessConnectionId(), onSent: registerBotSentText });
        addMessage(chatId, 'assistant', thanks);
        return;
      }
    }

    await enqueueMessage(chatId, msg.text);
  } catch (e) {
    console.error('Client TG webhook error:', e.message);
  }
});

app.get('/setup-client-telegram-webhook', async (req, res) => {
  try {
    const token = process.env.CLIENT_TELEGRAM_BOT_TOKEN;
    if (!token) return res.status(400).json({ error: 'CLIENT_TELEGRAM_BOT_TOKEN не задан' });
    const webhookUrl = `https://${req.get('host')}/client-telegram-webhook`;
    const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ['business_connection', 'business_message', 'edited_business_message'],
      }),
    });
    const data = await r.json();
    res.json({ success: r.ok, webhook_url: webhookUrl, response: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/test-telegram', async (req, res) => {
  await sendTelegram('✅ Telegram уведомления работают! Алина готова.');
  res.json({ ok: true, info: 'Проверь Telegram' });
});

app.get('/test-post-slots', async (req, res) => {
  await postDailySlots();
  res.json({ ok: true, info: 'Проверь Telegram канал' });
});

// Тест скидочного окна: /test-discount-post или /test-discount-post?date=tomorrow
app.get('/test-discount-post', async (req, res) => {
  const date = req.query.date === 'tomorrow' ? addDaysISO(todayMoscow(), 1) : todayMoscow();
  await postDiscountWindow(date);
  res.json({ ok: true, date, info: 'Проверь Telegram канал (TELEGRAM_SALE_CHAT_ID)' });
});

// Генерация и отдача демо-голоса Алины (OpenAI TTS)
const VOICE_DEMO_TEXT = 'Здравствуйте, Андрей! Это центр восстановления Боли.Нет. Напоминаю, у вас запись завтра в четырнадцать ноль-ноль, мануальная терапия у Цоя Александра Игоревича. Подтверждаете?';
const voiceDemoState = { nova: false, shimmer: false, alloy: false };
const voiceDemoGenerating = { nova: false, shimmer: false, alloy: false };

async function generateVoiceDemo(voice) {
  if (voiceDemoGenerating[voice]) return;
  voiceDemoGenerating[voice] = true;
  try {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'tts-1-hd', input: VOICE_DEMO_TEXT, voice, response_format: 'mp3' }),
    });
    if (!response.ok) throw new Error(`TTS error: ${response.status} ${await response.text()}`);
    const fs = require('fs');
    fs.writeFileSync(`/tmp/reminder_${voice}.mp3`, Buffer.from(await response.arrayBuffer()));
    voiceDemoState[voice] = true;
    console.log(`[voice-demo] MP3 generated: /tmp/reminder_${voice}.mp3`);
  } catch (e) {
    console.error(`[voice-demo][${voice}] Generate error:`, e.message);
  } finally {
    voiceDemoGenerating[voice] = false;
  }
}

function makeVoiceDemoHandler(voice) {
  return async (req, res) => {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({ error: 'OPENAI_API_KEY не задан в Railway' });
    }
    const fs = require('fs');
    const path = `/tmp/reminder_${voice}.mp3`;
    if (!voiceDemoState[voice]) {
      generateVoiceDemo(voice).catch(e => console.error(`[voice-demo][${voice}]`, e.message));
      return res.status(202).json({ status: 'generating', message: 'Генерирую MP3, повтори запрос через 10 секунд' });
    }
    if (!fs.existsSync(path)) {
      voiceDemoState[voice] = false;
      return res.status(404).json({ error: 'Файл не найден, повтори запрос' });
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `inline; filename="alina_${voice}.mp3"`);
    fs.createReadStream(path).pipe(res);
  };
}

app.get('/voice-demo', makeVoiceDemoHandler('nova'));
app.get('/voice-demo-shimmer', makeVoiceDemoHandler('shimmer'));
app.get('/voice-demo-alloy', makeVoiceDemoHandler('alloy'));

// Yandex-style demo через OpenAI TTS shimmer с паузами через пунктуацию
// (Yandex SpeechKit требует IAM-токен; Silero несовместим с Node.js)
const VOICE_YANDEX_TEXT = 'Здравствуйте, Мария... Это салон красоты Люкс. Напоминаю, у вас запись завтра в четырнадцать ноль-ноль... на маникюр. Подтверждаете?';
let voiceYandexReady = false;
let voiceYandexGenerating = false;

app.get('/voice-yandex', async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: 'OPENAI_API_KEY не задан в Railway' });
  }
  const fs = require('fs');
  const path = '/tmp/voice_yandex.mp3';

  if (!voiceYandexReady) {
    if (!voiceYandexGenerating) {
      voiceYandexGenerating = true;
      (async () => {
        try {
          const response = await fetch('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ model: 'tts-1-hd', input: VOICE_YANDEX_TEXT, voice: 'shimmer', response_format: 'mp3' }),
          });
          if (!response.ok) throw new Error(`TTS error: ${response.status} ${await response.text()}`);
          fs.writeFileSync(path, Buffer.from(await response.arrayBuffer()));
          voiceYandexReady = true;
          console.log('[voice-yandex] MP3 generated');
        } catch (e) {
          console.error('[voice-yandex] Generate error:', e.message);
        } finally {
          voiceYandexGenerating = false;
        }
      })();
    }
    return res.status(202).json({ status: 'generating', message: 'Генерирую MP3, повтори запрос через 10 секунд' });
  }

  if (!fs.existsSync(path)) {
    voiceYandexReady = false;
    return res.status(404).json({ error: 'Файл не найден, повтори запрос' });
  }
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Disposition', 'inline; filename="voice_yandex_style.mp3"');
  fs.createReadStream(path).pipe(res);
});

app.listen(PORT, async () => {
  console.log(`Listening on ${PORT} — GMT+3 mode (telegram-bot)`);
  // Инициализируем БД — если DATABASE_URL не задан, работаем без неё
  if (process.env.DATABASE_URL) {
    await db.initDb();
  } else {
    console.warn('[db] DATABASE_URL не задан — работаем без PostgreSQL');
  }

  // Раз в 5 минут проверяем "умные напоминания" для замолчавших клиентов
  if (process.env.DATABASE_URL) {
    setInterval(async () => {
      try {
        const due = await db.getDueReminders();
        for (const r of due) {
          // На Avito Алина не пишет первой — пропускаем старые записи, если остались
          if (!String(r.chat_id).startsWith('tg_')) {
            await db.markReminderSent(r.id);
            continue;
          }
          const d = dialogs[r.chat_id];

          // Если клиент уже ответил или диалог сдвинулся — напоминание неактуально
          const lastMsg = d?.messages?.[d.messages.length - 1];
          if (!d || !lastMsg || lastMsg.content !== r.snapshot || d.lastBookingSuccess) {
            await db.markReminderSent(r.id);
            continue;
          }

          const text = await generateReminder(r.chat_id, r.reminder_type);
          await sendClientMessage(r.chat_id, text, { getDialog, businessConnectionId: getBusinessConnectionId(), onSent: registerBotSentText });
          addMessage(r.chat_id, 'assistant', text);
          await db.markReminderSent(r.id);
          console.log(`Reminder (type ${r.reminder_type}) sent to chat ${r.chat_id}`);
        }
      } catch (e) {
        console.error('reminders dispatch error:', e.message);
      }
    }, 5 * 60 * 1000);
  }

  // Каждый день в 19:00 (МСК) — напоминания о визите завтра, с подтверждением "+"
  if (process.env.DATABASE_URL) {
    setInterval(async () => {
      try {
        const now = nowMoscow();
        if (now.getUTCHours() !== 19) return;

        const today = todayMoscow();
        const lastRun = await db.getSetting('day_before_reminder_last_run');
        if (lastRun === today) return;
        await db.setSetting('day_before_reminder_last_run', today);

        const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const records = await getRecordsForPeriod(tomorrow, tomorrow);

        for (const r of records) {
          if (r.deleted) continue;
          const phone = normalizePhone(r.client?.phone);
          if (!phone) continue;
          const chatId = await db.getClientChannel(phone);
          if (!chatId || !String(chatId).startsWith('tg_')) continue;
          if (await db.hasVisitConfirmation(String(r.id))) continue;

          const startTime = r.datetime ? r.datetime.substring(11, 16) : '';
          const services = (r.services || []).map(s => s.title).join(', ') || 'процедуру';
          const name = r.client?.name || 'Уважаемый клиент';

          const text = buildDayBeforeMessage(name, services, startTime);
          await sendClientMessage(chatId, text, { getDialog, businessConnectionId: getBusinessConnectionId(), onSent: registerBotSentText });
          addMessage(chatId, 'assistant', text);
          await db.addVisitConfirmation(String(r.id), r.record_hash, phone, chatId, tomorrow, startTime);
          console.log(`Day-before reminder sent to chat ${chatId} for record ${r.id}`);
        }
      } catch (e) {
        console.error('day-before reminder dispatch error:', e.message);
      }
    }, 5 * 60 * 1000);
  }

  // Каждый день в 09:25 (МСК) — тем, у кого запись сегодня и кто не подтвердил вечером
  if (process.env.DATABASE_URL) {
    setInterval(async () => {
      try {
        const now = nowMoscow();
        if (now.getUTCHours() !== 9 || now.getUTCMinutes() < 25) return;

        const today = todayMoscow();
        const lastRun = await db.getSetting('morning_reminder_last_run');
        if (lastRun === today) return;
        await db.setSetting('morning_reminder_last_run', today);

        const records = await getRecordsForPeriod(today, today);

        for (const r of records) {
          if (r.deleted) continue;
          const phone = normalizePhone(r.client?.phone);
          if (!phone) continue;
          const chatId = await db.getClientChannel(phone);
          if (!chatId || !String(chatId).startsWith('tg_')) continue;

          const existing = await db.getVisitConfirmationByRecord(String(r.id));
          if (existing && (existing.confirmed || existing.morning_sent)) continue;

          const startTime = r.datetime ? r.datetime.substring(11, 16) : '';

          const text = buildMorningReminderMessage();
          await sendClientMessage(chatId, text, { getDialog, businessConnectionId: getBusinessConnectionId(), onSent: registerBotSentText });
          addMessage(chatId, 'assistant', text);

          if (existing) {
            await db.markMorningSent(existing.id);
          } else {
            await db.addVisitConfirmation(String(r.id), r.record_hash, phone, chatId, today, startTime, true);
          }
          console.log(`Morning reminder sent to chat ${chatId} for record ${r.id}`);
        }
      } catch (e) {
        console.error('morning reminder dispatch error:', e.message);
      }
    }, 5 * 60 * 1000);
  }

  // Раз в 5 минут — оповещение о новой записи, созданной напрямую в CRM
  // (записи, созданные через диалог с Алисой, уже подтверждены и
  // отслеживаются через tracked_records, поэтому повторно не уведомляем)
  if (process.env.DATABASE_URL) {
    setInterval(async () => {
      try {
        if (await db.getSetting('crm_notifications_enabled') !== 'true') return;

        const today = todayMoscow();
        const until = addDaysISO(today, 14);
        const records = await getRecordsForPeriod(today, until);

        for (const r of records) {
          if (r.deleted) continue;
          const phone = normalizePhone(r.client?.phone);
          if (!phone) continue;
          const chatId = await db.getClientChannel(phone);
          if (!chatId || !String(chatId).startsWith('tg_')) continue;
          if (await db.hasTrackedRecord(r.id)) continue;

          const date = r.datetime ? r.datetime.substring(0, 10) : today;
          const startTime = r.datetime ? r.datetime.substring(11, 16) : '';
          const services = (r.services || []).map(s => s.title).join(', ') || 'процедура';
          const name = r.client?.name || 'Уважаемый клиент';
          const master = STAFF_FULLNAME[r.staff_id] || 'специалист';

          const text = buildBookingConfirmMessage(name, date, startTime, services, master);
          await sendClientMessage(chatId, text, { getDialog, businessConnectionId: getBusinessConnectionId(), onSent: registerBotSentText });
          addMessage(chatId, 'assistant', text);
          await db.addTrackedRecord(r.id, chatId, date, startTime);
          console.log(`New CRM booking notification sent to chat ${chatId} for record ${r.id}`);
        }
      } catch (e) {
        console.error('new booking notification dispatch error:', e.message);
      }
    }, 5 * 60 * 1000);
  }

  // Раз в 5 минут — эскалация администратору: если клиент не подтвердил
  // визит на сегодня ни вечером, ни утром, просим прозвонить
  if (process.env.DATABASE_URL && process.env.TELEGRAM_CHAT_ID) {
    setInterval(async () => {
      try {
        if (await db.getSetting('crm_notifications_enabled') !== 'true') return;

        const due = await db.getDueEscalations();
        for (const v of due) {
          const client = await findClient(v.phone);
          const name = client?.name || '';
          const text = buildAdminEscalationMessage(name, v.phone, v.start_time);
          await sendTelegram(text, process.env.TELEGRAM_CHAT_ID);
          await db.markEscalationNotified(v.id);
          console.log(`Escalation sent to admin for record ${v.record_id}`);
        }
      } catch (e) {
        console.error('escalation dispatch error:', e.message);
      }
    }, 5 * 60 * 1000);
  }

  // Раз в 5 минут — запросы отзыва (Telegram): только если клиент дошёл,
  // и не на каждый визит, а с периодичностью (1й, 5й, 9й...)
  if (process.env.DATABASE_URL) {
    setInterval(async () => {
      try {
        const due = await db.getDueReviewFollowups();
        for (const f of due) {
          try {
            const records = await getRecordsForPeriod(f.visit_date, f.visit_date);
            const record = records.find(r => String(r.id) === String(f.record_id));
            const attended = record && (record.attendance === 1 || record.visit_attendance === 1 || record.status === 7);

            if (attended) {
              const client = await findClient(f.phone);
              const visits = client?.visits || 0;
              if ((visits - 1) % 4 === 0) {
                const text = buildReviewMessage();
                await sendClientMessage(f.chat_id, text, { getDialog, businessConnectionId: getBusinessConnectionId(), onSent: registerBotSentText });
                addMessage(f.chat_id, 'assistant', text);
                console.log(`Review request sent to chat ${f.chat_id} (visit #${visits})`);
              }

              // Запускаем/перезапускаем цепочку касаний после визита (день 4-5 / 30 / 90)
              const touchDueAt = computeSendWindow(addDaysISO(f.visit_date, pick(4, 5)), true);
              await db.upsertTouchChain(f.chat_id, f.phone, client?.name, f.visit_date, touchDueAt);
            }
          } finally {
            await db.markReviewFollowupSent(f.id);
          }
        }
      } catch (e) {
        console.error('review followups dispatch error:', e.message);
      }
    }, 5 * 60 * 1000);
  }

  // Раз в 5 минут — за 30 минут до визита приглашаем в телеграм-канал
  // (с той же периодичностью, что и запрос отзыва: 1й, 5й, 9й... визит)
  if (process.env.DATABASE_URL) {
    setInterval(async () => {
      try {
        const due = await db.getDueSocialFollowups();
        for (const f of due) {
          try {
            const client = await findClient(f.phone);
            const visits = client?.visits || 0;
            if (visits % 4 === 0) {
              const text = buildSocialMessage();
              await sendClientMessage(f.chat_id, text, { getDialog, businessConnectionId: getBusinessConnectionId(), onSent: registerBotSentText });
              addMessage(f.chat_id, 'assistant', text);
              console.log(`Social followup sent to chat ${f.chat_id} (visit #${visits + 1})`);
            }
          } finally {
            await db.markSocialFollowupSent(f.id);
          }
        }
      } catch (e) {
        console.error('social followups dispatch error:', e.message);
      }
    }, 5 * 60 * 1000);
  }

  // Раз в 5 минут — цепочка касаний после визита (день 3-5 / 30 / 90).
  // Останавливается мгновенно, если клиент уже записался снова.
  if (process.env.DATABASE_URL) {
    setInterval(async () => {
      try {
        const due = await db.getDueTouchChains();
        for (const t of due) {
          // Стоп-триггер: клиент уже записался повторно
          if (await db.hasFutureTrackedRecord(t.chat_id, t.last_visit_date.toISOString().split('T')[0])) {
            await db.stopTouchChain(t.chat_id);
            continue;
          }

          let text, nextStep, nextDueAt;
          if (t.next_step === 1) {
            text = buildTouch1Message(t.name);
            nextStep = 2;
            nextDueAt = computeSendWindow(addDaysISO(t.last_visit_date.toISOString().split('T')[0], 30), true);
          } else if (t.next_step === 2) {
            text = buildTouch2Message(t.name);
            nextStep = 3;
            nextDueAt = computeSendWindow(addDaysISO(t.last_visit_date.toISOString().split('T')[0], 90), false);
          } else {
            text = buildTouch3Message();
            nextStep = 4;
            nextDueAt = new Date().toISOString();
          }

          await sendClientMessage(t.chat_id, text, { getDialog, businessConnectionId: getBusinessConnectionId(), onSent: registerBotSentText });
          addMessage(t.chat_id, 'assistant', text);
          await db.markTouchSent(t.id, nextStep, nextDueAt);
          console.log(`Touch chain step ${t.next_step} sent to chat ${t.chat_id}`);
        }
      } catch (e) {
        console.error('touch chain dispatch error:', e.message);
      }
    }, 5 * 60 * 1000);
  }

  // Раз в 5 минут — проверяем, не удалили ли запись в CRM, и если да — уведомляем клиента
  if (process.env.DATABASE_URL) {
    setInterval(async () => {
      try {
        const tracked = await db.getActiveTrackedRecords();
        if (!tracked.length) return;

        const byDate = {};
        for (const t of tracked) {
          const date = t.visit_date.toISOString().split('T')[0];
          (byDate[date] = byDate[date] || []).push(t);
        }

        for (const [date, items] of Object.entries(byDate)) {
          const records = await getRecordsForPeriod(date, date);
          const byId = new Map(records.map(r => [String(r.id), r]));
          for (const t of items) {
            const record = byId.get(String(t.record_id));
            const isDeleted = !record || record.deleted === true;
            if (!isDeleted) continue;
            const text = buildCancelMessage(date, t.start_time);
            await sendClientMessage(t.chat_id, text, { getDialog, businessConnectionId: getBusinessConnectionId(), onSent: registerBotSentText });
            addMessage(t.chat_id, 'assistant', text);
            await db.markCancelNotified(t.record_id);
            console.log(`Cancellation notice sent to chat ${t.chat_id} for record ${t.record_id}`);
          }
        }
      } catch (e) {
        console.error('cancellation dispatch error:', e.message);
      }
    }, 5 * 60 * 1000);
  }

  // Каждый день в 19:30 МСК — отчёт о закрытии дня (касса, нал/безнал, ЗП массажистов)
  if (process.env.DATABASE_URL) {
    setInterval(async () => {
      try {
        const now = nowMoscow();
        if (now.getUTCHours() !== 19 || now.getUTCMinutes() < 30) return;
        const today = todayMoscow();
        const lastRun = await db.getSetting('daily_close_report_last_run');
        if (lastRun === today) return;
        await db.setSetting('daily_close_report_last_run', today);

        const analytics = await buildDayAnalytics(today);
        await sendTelegram(formatDayCloseReport(analytics));
      } catch (e) {
        console.error('daily close report dispatch error:', e.message);
      }
    }, 5 * 60 * 1000);
  }

  // Каждый понедельник в 9:00 МСК — итоги прошедшей недели + план на следующую
  if (process.env.DATABASE_URL) {
    setInterval(async () => {
      try {
        const now = nowMoscow();
        if (now.getUTCDay() !== 1 || now.getUTCHours() !== 9) return;
        const today = todayMoscow();
        const lastRun = await db.getSetting('weekly_report_last_run');
        if (lastRun === today) return;
        await db.setSetting('weekly_report_last_run', today);

        const prevWeekFrom = addDaysISO(today, -7);
        const prevWeekTo = addDaysISO(today, -1);
        const nextWeekFrom = today;
        const nextWeekTo = addDaysISO(today, 6);

        const [week, next] = await Promise.all([
          buildWeekAnalytics(prevWeekFrom, prevWeekTo),
          countNextWeekStats(nextWeekFrom, nextWeekTo),
        ]);
        await sendTelegram(formatWeekReport(week, next));
      } catch (e) {
        console.error('weekly report dispatch error:', e.message);
      }
    }, 5 * 60 * 1000);
  }

  // 1-го числа каждого месяца в 9:00 МСК — отчёт за прошедший месяц
  if (process.env.DATABASE_URL) {
    setInterval(async () => {
      try {
        const now = nowMoscow();
        if (now.getUTCDate() !== 1 || now.getUTCHours() !== 9) return;
        const today = todayMoscow();
        const lastRun = await db.getSetting('monthly_report_last_run');
        if (lastRun === today) return;
        await db.setSetting('monthly_report_last_run', today);

        let year = now.getUTCFullYear();
        let month = now.getUTCMonth() + 1; // текущий месяц (1-12)
        month -= 1;
        if (month === 0) { month = 12; year -= 1; }

        const analytics = await buildMonthAnalytics(year, month);
        await sendTelegram(formatMonthReport(analytics));
      } catch (e) {
        console.error('monthly report dispatch error:', e.message);
      }
    }, 5 * 60 * 1000);
  }

  // Каждый день в 9:00 МСК — пост о скидочном окне (массаж/комплекс), если есть пустой слот
  if (process.env.DATABASE_URL) {
    setInterval(async () => {
      try {
        const now = nowMoscow();
        if (now.getUTCHours() !== 9) return;
        const today = todayMoscow();
        const lastRun = await db.getSetting('discount_post_last_run');
        if (lastRun === today) return;
        await db.setSetting('discount_post_last_run', today);
        await postDiscountWindow();
      } catch (e) {
        console.error('discount post dispatch error:', e.message);
      }
    }, 5 * 60 * 1000);
  }

  // Каждый день в 9:00 МСК — пост со свободными окнами массажа в продающий канал
  let lastSlotsPostDay = null;
  setInterval(async () => {
    const now = nowMoscow();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    const day = now.toISOString().split('T')[0];
    if (hour === 9 && minute === 0 && day !== lastSlotsPostDay) {
      lastSlotsPostDay = day;
      await postDailySlots();
    }
  }, 60 * 1000);

  // Каждые 5 минут — проверка, не заняли ли слот, под который вышел скидочный пост.
  // Если заняли — удаляем пост (стоп-триггер).
  if (process.env.DATABASE_URL) {
    setInterval(async () => {
      try {
        const today = todayMoscow();
        const posts = await db.getActiveDiscountPosts(today);
        for (const p of posts) {
          let stillFree;
          if (p.post_type === 'daily') {
            const [massage60, massage90] = await Promise.all([
              getMassageSlots(today, SERVICES.MASSAGE_60),
              getMassageSlots(today, SERVICES.MASSAGE_90),
            ]);
            const allTimes = new Set([...massage60.slots, ...massage90.slots]);
            stillFree = p.slot_time.split(',').some(t => allTimes.has(t));
          } else if (p.post_type === 'massage') {
            const massage = await getMassageSlots(today, Number(p.service_id));
            stillFree = massage.slots.includes(p.slot_time);
          } else {
            const slots = await getFreeSlots(today, Number(p.staff_id), Number(p.service_id));
            stillFree = slots.includes(p.slot_time);
          }
          if (!stillFree) {
            if (p.channel_chat_id && p.channel_message_id) {
              await deleteTelegramMessage(p.channel_chat_id, p.channel_message_id);
            }
            await db.markDiscountPostRemoved(p.id);
            console.log(`Discount post ${p.id} removed — slot ${p.slot_time} booked`);
          }
        }
      } catch (e) {
        console.error('discount post removal check error:', e.message);
      }
    }, 5 * 60 * 1000);
  }
});
