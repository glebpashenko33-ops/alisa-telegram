// =====================================================================
// CONVERSATION ENGINE — общий "мозг" Алины
// =====================================================================
// Используется и avito-bot (диалоги в Avito), и telegram-bot (диалоги
// с клиентами через Telegram Business). Каждый сервис создаёт свой
// экземпляр через createConversationEngine() — состояние (dialogs,
// очереди, бизнес-подключение Telegram) не делится между процессами.
// =====================================================================

const db = require('../db');
const {
  STAFF, STAFF_FULLNAME, SERVICES, SERVICE_PRICES, COMPLEX_CONFIG, LATE_BOOKING_FROM,
} = require('./constants');
const { nowMoscow, todayMoscow, fmtDate, computeSendWindow } = require('./time');
const {
  createBooking, createComplexBooking, findClient, appendClientNote, saveComplaintNote,
} = require('./yclients');
const { sendTelegram } = require('./telegramApi');
const { restoreHistoryFromAvito, getChatItemId, buildAdPriorityContext } = require('./avitoApi');
const { sendClientMessage } = require('./clientMessaging');
const { getActivePrompt } = require('./prompt');
const { buildScheduleContext, getServiceId, getStaffId } = require('./scheduleContext');
const { buildFollowupMessage, buildBookingConfirmMessage, buildComplaintRequestMessage } = require('./messages');
const {
  extractPhone, normalizePhone, findPhoneInHistory, detectComplexFromReply,
  isBookingConfirmation, isEscalation, extractBookingData, parseBookingFromReply,
} = require('./bookingExtract');

// Длительность одиночных услуг в минутах (для расчёта времени окончания сеанса)
const SINGLE_SERVICE_DURATION_MIN = {
  [SERVICES.MASSAGE_30]:      30,
  [SERVICES.MASSAGE_60]:      60,
  [SERVICES.MASSAGE_90]:      90,
  [SERVICES.MASSAGE_LATE_60]: 60,
  [SERVICES.MASSAGE_LATE_90]: 90,
  [SERVICES.NEURO_MASSAGE]:   60,
  [SERVICES.MANUAL]:          30,
  [SERVICES.VIP_60]:          60,
};

function createConversationEngine({ anthropic }) {
  // =====================================================================
  // DIALOG MANAGER
  // =====================================================================
  // Хранит историю диалогов и метаданные отдельно — никаких магических полей.
  // Каждый чат: { messages, lastUpdated, lastBookingKey, lastBookingSuccess }

  const dialogs = {};
  const MAX_HISTORY = 20;

  function getDialog(chatId) {
    if (!dialogs[chatId]) {
      dialogs[chatId] = { messages: [], lastUpdated: Date.now(), lastBookingKey: null, lastBookingSuccess: false };
    }
    return dialogs[chatId];
  }

  function addMessage(chatId, role, content) {
    const d = getDialog(chatId);
    d.messages.push({ role, content });
    if (d.messages.length > MAX_HISTORY) {
      d.messages = d.messages.slice(-MAX_HISTORY);
    }
    d.lastUpdated = Date.now();
  }

  function getMessages(chatId) {
    return (dialogs[chatId]?.messages || []).filter(m => m.role && m.content);
  }

  function clearDialog(chatId) {
    delete dialogs[chatId];
  }

  // Очистка старых диалогов раз в час
  setInterval(() => {
    const cutoff = 24 * 60 * 60 * 1000;
    for (const chatId in dialogs) {
      if (Date.now() - dialogs[chatId].lastUpdated > cutoff) {
        delete dialogs[chatId];
      }
    }
  }, 60 * 60 * 1000);

  // --- Напоминания через 3ч и 24ч ---

  async function generateReminder(chatId, reminderType) {
    try {
      const history = getMessages(chatId);
      if (!history.length) return null;

      const historyText = history.slice(-6)
        .map(m => `${m.role === 'user' ? 'Клиент' : 'Алина'}: ${m.content}`)
        .join('\n');

      const prompt = reminderType === 1
        ? `Ты — Алина, администратор центра восстановления "Боли.Нет". Клиент написал, но не ответил уже несколько часов. Напиши ему одно короткое напоминание (1-2 предложения). Используй его имя если знаешь. Упомяни тему с которой он обращался. Тон — тёплый, ненавязчивый. Без эмодзи. Женский род.

Пример стиля: "Александр, подскажите — остались вопросы или что-то смущает? Готова помочь с выбором."

История диалога:
${historyText}`
        : `Ты — Алина, администратор центра восстановления "Боли.Нет". Клиент написал, но не записался уже сутки. Напиши ему одно короткое напоминание (1-2 предложения). Используй его имя если знаешь. Упомяни что есть свободные окна. Тон — тёплый, без давления. Без эмодзи. Женский род.

Пример стиля: "Александр, на этой неделе ещё есть свободные окна. Если решите записаться — напишите, всё устроим быстро."

История диалога:
${historyText}`;

      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        messages: [{ role: 'user', content: prompt }],
      });
      return response.content[0].text.trim();
    } catch (e) {
      console.error('generateReminder error:', e.message);
      return reminderType === 1
        ? 'Подскажите — остались вопросы или что-то смущает? Готова помочь с выбором.'
        : 'На этой неделе ещё есть свободные окна. Если решите записаться — напишите, всё устроим быстро.';
    }
  }

  // Напоминания храним в БД, чтобы они переживали перезапуск сервера (Railway
  // часто передеплоит). 1-е — через 3 часа (добиваем клиента), 2-е — через
  // сутки (последняя попытка). Если клиент за это время ответил или запись
  // уже создана — напоминание не отправляется.
  // Только для Telegram — на Avito Алина не пишет первой никогда (кроме запроса отзыва).
  async function scheduleReminders(chatId) {
    await cancelReminders(chatId);
    if (!process.env.DATABASE_URL) return;
    if (!String(chatId).startsWith('tg_')) return;

    const d = dialogs[chatId];
    if (!d || !d.messages.length) return;
    const lastMsg = d.messages[d.messages.length - 1];
    if (lastMsg.role !== 'assistant') return;
    if (d.lastBookingSuccess) return; // не напоминаем если запись успешно создана

    const now = Date.now();
    await db.scheduleReminder(chatId, 1, new Date(now + 3 * 60 * 60 * 1000).toISOString(), lastMsg.content);
    await db.scheduleReminder(chatId, 2, new Date(now + 24 * 60 * 60 * 1000).toISOString(), lastMsg.content);
  }

  async function cancelReminders(chatId) {
    if (!process.env.DATABASE_URL) return;
    await db.cancelReminders(chatId);
  }

  // =====================================================================
  // BOOKING ENGINE — followups / touch chain helpers
  // =====================================================================

  // Планирует сообщение клиенту через 1 час после окончания сеанса.
  // Только для Avito — для Telegram вместо этого используется scheduleReviewRequest
  async function scheduleFollowup(chatId, name, date, time, durationMin) {
    if (!process.env.DATABASE_URL) return;
    if (String(chatId).startsWith('tg_')) return;
    try {
      const startUtc = new Date(`${date}T${time}:00+03:00`);
      const sendAt = new Date(startUtc.getTime() + (durationMin + 60) * 60 * 1000);
      await db.addFollowup(chatId, sendAt.toISOString(), buildFollowupMessage(name));
      console.log(`Follow-up scheduled for chat ${chatId} at ${sendAt.toISOString()}`);
    } catch (e) {
      console.error('scheduleFollowup error:', e.message);
    }
  }

  // Планирует проверку через 1 час после сеанса: пришёл ли клиент, и если да —
  // раз в несколько визитов (1й, 5й, 9й...) шлём запрос на отзыв в Telegram
  async function scheduleReviewRequest(chatId, phone, recordId, date, time, durationMin) {
    if (!process.env.DATABASE_URL) return;
    if (!String(chatId).startsWith('tg_') || !recordId) return;
    try {
      const startUtc = new Date(`${date}T${time}:00+03:00`);
      const dueAt = new Date(startUtc.getTime() + (durationMin + 60) * 60 * 1000);
      await db.addReviewFollowup(chatId, phone, String(recordId), date, dueAt.toISOString());
      console.log(`Review followup scheduled for chat ${chatId} at ${dueAt.toISOString()}`);
    } catch (e) {
      console.error('scheduleReviewRequest error:', e.message);
    }
  }

  // Планирует приглашение в телеграм-канал за 30 минут до визита,
  // с той же периодичностью, что и запрос отзыва (1й, 5й, 9й... визит)
  async function scheduleSocialFollowup(chatId, phone, recordId, date, time) {
    if (!process.env.DATABASE_URL) return;
    if (!String(chatId).startsWith('tg_') || !recordId) return;
    try {
      const startUtc = new Date(`${date}T${time}:00+03:00`);
      const dueAt = new Date(startUtc.getTime() - 30 * 60 * 1000);
      await db.addSocialFollowup(chatId, phone, String(recordId), date, dueAt.toISOString());
      console.log(`Social followup scheduled for chat ${chatId} at ${dueAt.toISOString()}`);
    } catch (e) {
      console.error('scheduleSocialFollowup error:', e.message);
    }
  }

  // =====================================================================
  // Telegram Business — id подключения и владельца
  // =====================================================================
  // Используются чтобы отправлять сообщения от имени личного аккаунта
  // и отличать ручные ответы владельца. Только для telegram-bot.

  let tgBusinessConnectionId = null;
  let tgBusinessOwnerId = null;

  function setBusinessConnection(connectionId, ownerId) {
    tgBusinessConnectionId = connectionId;
    if (ownerId !== undefined) tgBusinessOwnerId = ownerId;
  }

  function getBusinessConnectionId() {
    return tgBusinessConnectionId;
  }

  function getBusinessOwnerId() {
    return tgBusinessOwnerId;
  }

  // =====================================================================
  // Перехват диалога владельцем (ручной ответ — Алина молчит 4 часа)
  // =====================================================================
  // chatId → timestamp перехвата. Если есть БД — храним в human_taken_chats
  // (общая таблица), иначе — локально в памяти.
  const humanTakenChatsLocal = new Map();

  async function setHumanTaken(chatId) {
    if (process.env.DATABASE_URL) {
      await db.setHumanTaken(chatId);
    } else {
      humanTakenChatsLocal.set(chatId, Date.now());
    }
  }

  async function getHumanTakenAt(chatId) {
    if (process.env.DATABASE_URL) {
      const takenAt = await db.getHumanTaken(chatId);
      return takenAt ? new Date(takenAt).getTime() : null;
    }
    return humanTakenChatsLocal.get(chatId) || null;
  }

  async function clearHumanTakenLocalOrDb(chatId) {
    if (process.env.DATABASE_URL) {
      await db.clearHumanTaken(chatId);
    } else {
      humanTakenChatsLocal.delete(chatId);
    }
  }

  // Тексты которые бот сам только что отправил — чтобы не принять эхо за ручной ответ
  const botSentTexts = new Set();
  function registerBotSentText(text) {
    botSentTexts.add(text);
    setTimeout(() => botSentTexts.delete(text), 30000);
  }

  // =====================================================================
  // Главная функция бронирования. Возвращает результат или причину пропуска.
  // =====================================================================
  async function tryCreateBooking(chatId, reply, userMessage) {
    const dialog = getDialog(chatId);

    // Триггер: Алина сказала "Записала" в ответе
    if (!isBookingConfirmation(reply)) {
      return { skipped: 'no_confirmation' };
    }

    // Проверка наличия телефона в истории
    const allMessages = getMessages(chatId);
    const phoneFromHistory = findPhoneInHistory(allMessages);
    const phoneFromCurrent = extractPhone(userMessage);
    const phone = phoneFromCurrent || phoneFromHistory;

    if (!phone) {
      console.log('Алина сказала "Записала", но телефона в истории нет');
      await sendTelegram(
        `⚠️ <b>Алина пообещала запись, но телефона нет</b>\n\nЧат: <code>${chatId}</code>\n❗ Проверь диалог вручную.`
      );
      return { skipped: 'no_phone' };
    }

    // Извлекаем данные через Haiku
    let data = await extractBookingData(anthropic, allMessages);
    console.log('Booking data (Haiku):', JSON.stringify(data));

    // Дополняем из регексп-парсера если что-то пустое
    const fromReply = parseBookingFromReply(reply, todayMoscow());
    if (fromReply) {
      if (!data) data = {};
      data.name = data.name || fromReply.name;
      data.date = data.date || fromReply.date;
      data.time = data.time || fromReply.time;
      data.service = data.service || fromReply.service;
    }
    console.log('Booking data (merged):', JSON.stringify(data));

    // Проверка обязательных полей
    const missing = [];
    if (!data?.name) missing.push('имя');
    if (!phone) missing.push('телефон');
    if (!data?.date) missing.push('дата');
    if (!data?.time) missing.push('время');

    if (missing.length) {
      await sendTelegram(
        `⚠️ <b>АЛИНА СКАЗАЛА "ЗАПИСАЛА", НО ЗАПИСЬ НЕ СОЗДАНА</b>\n\n` +
        `Не хватает: ${missing.join(', ')}\n\n` +
        `👤 ${data?.name || '—'}\n📞 ${phone || '—'}\n📅 ${data?.date || '—'} в ${data?.time || '—'}\n💆 ${data?.service || '—'}\n` +
        `${data?.problem ? `🤕 ${data.problem}\n` : ''}\n❗ Создай запись вручную в YCLIENTS`
      );
      return { skipped: 'missing_data', missing };
    }

    // Определяем тип записи — ОДИН источник правды
    const complexType = detectComplexFromReply(reply) || data.complex_type;
    const isComplex = !!complexType;

    console.log(`Booking decision: isComplex=${isComplex}, complexType=${complexType}`);

    // Защита от дубликата ТОЛЬКО для тех же данных (имя+дата+время).
    // Если данные изменились — пробуем заново, даже если в этом диалоге уже была запись.
    const bookingKey = `${data.name}|${data.date}|${data.time}|${isComplex ? complexType : data.service}`;
    if (dialog.lastBookingKey === bookingKey && dialog.lastBookingSuccess) {
      console.log('Same booking already successfully created, skipping duplicate:', bookingKey);
      return { skipped: 'duplicate', key: bookingKey };
    }
    dialog.lastBookingKey = bookingKey;

    const existingClient = await findClient(phone);
    const clientStatus = existingClient?.visits > 0
      ? `♻️ Повторный (визитов: ${existingClient.visits})`
      : '🆕 Новый клиент';
    const dateFormatted = fmtDate(data.date);

    // --- Комплекс ---
    if (isComplex) {
      console.log(`Creating COMPLEX: ${complexType}, ${data.name}, ${data.date} ${data.time}`);
      const result = await createComplexBooking({
        name: data.name, phone, date: data.date, time: data.time,
        complexType,
      });

      if (result.success) {
        dialog.lastBookingSuccess = true;
        await cancelReminders(chatId);
        await saveComplaintNote(phone, result.complexLabel || complexType, String(chatId).startsWith('tg_') ? 'Telegram' : 'Авито', data.problem);
        if (String(chatId).startsWith('tg_')) {
          await db.setClientChannel(normalizePhone(phone), chatId);
          const masters = [];
          if (result.manualPart) masters.push(STAFF_FULLNAME[STAFF.ALEXANDER] || 'Цой Александр Игоревич');
          if (result.massagePart) masters.push(STAFF_FULLNAME[result.massagePart.staffId] || 'Массажист');
          const startTime = result.manualPart?.time || result.massagePart?.time || data.time;
          const confirmMsg = buildBookingConfirmMessage(
            data.name, data.date, startTime,
            result.complexLabel || complexType,
            masters.join(', ')
          );
          await sendClientMessage(chatId, confirmMsg, { getDialog, businessConnectionId: tgBusinessConnectionId, onSent: registerBotSentText });
          addMessage(chatId, 'assistant', confirmMsg);

          if (process.env.DATABASE_URL) {
            if (result.manualPart?.result?.recordId) {
              await db.addTrackedRecord(result.manualPart.result.recordId, chatId, data.date, result.manualPart.time);
            }
            if (result.massagePart?.result?.recordId) {
              await db.addTrackedRecord(result.massagePart.result.recordId, chatId, data.date, result.massagePart.time);
            }
          }
        } else if (!data.problem) {
          // Avito: жалоба не указана — спрашиваем для врача и записываем ответ в примечание о клиенте
          const askMsg = buildComplaintRequestMessage();
          await sendClientMessage(chatId, askMsg, { getDialog, businessConnectionId: tgBusinessConnectionId, onSent: registerBotSentText });
          addMessage(chatId, 'assistant', askMsg);
          dialog.pendingComplaintRecord = { phone, label: result.complexLabel || complexType };
        }
      }

      let tgMsg = `${result.success ? '✅' : '⚠️'} <b>КОМПЛЕКС ${result.success ? 'СОЗДАН' : 'СОЗДАН ЧАСТИЧНО'}</b>\n\n` +
        `👤 <b>${data.name}</b> — ${clientStatus}\n📞 ${phone}\n🤕 ${data.problem || 'не указана'}\n📅 ${dateFormatted}\n💎 ${result.complexLabel || complexType} — ${result.complexPrice || '?'} ₽\n\n`;

      if (result.manualPart) {
        const ok1 = result.manualPart.result.success;
        tgMsg += `${ok1 ? '✅' : '❌'} Часть 1: Мануальная в ${result.manualPart.time} — Цой Александр Игоревич\n`;
      }
      if (result.massagePart) {
        const ok2 = result.massagePart.result.success;
        const mName = STAFF_FULLNAME[result.massagePart.staffId] || 'Массажист';
        tgMsg += `${ok2 ? '✅' : '❌'} Часть 2: Массаж в ${result.massagePart.time} — ${mName}\n`;
      }
      if (!result.success) {
        tgMsg += `\n❗ Проверь записи в YCLIENTS вручную`;
      }
      await sendTelegram(tgMsg);

      if (result.success) {
        const durationMin = COMPLEX_CONFIG[complexType]?.durationMin || 90;
        await scheduleFollowup(chatId, data.name, data.date, data.time, durationMin);
        const recordId = result.massagePart?.result?.recordId || result.manualPart?.result?.recordId;
        await scheduleReviewRequest(chatId, phone, recordId, data.date, data.time, durationMin);
        const firstTime = [result.manualPart?.time, result.massagePart?.time].filter(Boolean).sort()[0] || data.time;
        await scheduleSocialFollowup(chatId, phone, recordId, data.date, firstTime);
      }

      return { success: result.success, type: 'complex', result };
    }

    // --- Одиночная услуга ---
    let serviceId = getServiceId(data.service, data.duration);
    let staffId = getStaffId(data.specialist, serviceId);

    // Поздняя запись (с 20:00) — массаж только у Никиты, по повышенной цене
    if (data.time >= LATE_BOOKING_FROM && (serviceId === SERVICES.MASSAGE_60 || serviceId === SERVICES.MASSAGE_90)) {
      serviceId = serviceId === SERVICES.MASSAGE_90 ? SERVICES.MASSAGE_LATE_90 : SERVICES.MASSAGE_LATE_60;
      staffId = STAFF.NIKITA;
    }
    const staffFullName = STAFF_FULLNAME[staffId] || 'Специалист';

    console.log(`Creating SINGLE: ${data.name}, ${phone}, ${data.date} ${data.time}, service=${serviceId}, staff=${staffId}`);

    const sourceLabel = String(chatId).startsWith('tg_') ? 'Telegram' : 'Авито';
    const result = await createBooking({
      name: data.name, phone, date: data.date, time: data.time,
      serviceId, staffId,
      comment: sourceLabel,
    });

    // Слот занят — сообщаем клиенту и предлагаем альтернативы
    if (result.slotTaken) {
      const altTimes = (result.availableSlots || []).slice(0, 5).join(', ');
      const sorryMsg = altTimes
        ? `К сожалению, время ${data.time} только что заняли. Ближайшие свободные: ${altTimes}. Какое подойдёт?`
        : `К сожалению, время ${data.time} только что заняли. Передам администратору — он подберёт удобное время.`;
      await sendClientMessage(chatId, sorryMsg, { getDialog, businessConnectionId: tgBusinessConnectionId, onSent: registerBotSentText });
      addMessage(chatId, 'assistant', sorryMsg);

      await sendTelegram(
        `⚠️ <b>СЛОТ ЗАНЯТ</b>\n\n👤 ${data.name}\n📞 ${phone}\n📅 ${dateFormatted} в ${data.time} — уже занято\n💡 Альтернативы: ${altTimes || 'нет'}`
      );
      return { success: false, type: 'slot_taken' };
    }

    if (result.success) {
      dialog.lastBookingSuccess = true;
      await cancelReminders(chatId);
      await saveComplaintNote(phone, data.service || 'услуга', sourceLabel, data.problem);
      if (String(chatId).startsWith('tg_')) {
        await db.setClientChannel(normalizePhone(phone), chatId);
        const confirmMsg = buildBookingConfirmMessage(
          data.name, data.date, data.time,
          data.service || 'процедура',
          staffFullName
        );
        await sendClientMessage(chatId, confirmMsg, { getDialog, businessConnectionId: tgBusinessConnectionId, onSent: registerBotSentText });
        addMessage(chatId, 'assistant', confirmMsg);

        if (process.env.DATABASE_URL && result.recordId) {
          await db.addTrackedRecord(result.recordId, chatId, data.date, data.time);
        }
      } else if (!data.problem) {
        // Avito: жалоба не указана — спрашиваем для врача и записываем ответ в примечание о клиенте
        const askMsg = buildComplaintRequestMessage();
        await sendClientMessage(chatId, askMsg, { getDialog, businessConnectionId: tgBusinessConnectionId, onSent: registerBotSentText });
        addMessage(chatId, 'assistant', askMsg);
        dialog.pendingComplaintRecord = { phone, label: data.service || 'услуга' };
      }
    }

    const isLate = serviceId === SERVICES.MASSAGE_LATE_60 || serviceId === SERVICES.MASSAGE_LATE_90;

    let tgMsg = `${result.success ? '✅' : '❌'} <b>ЗАПИСЬ ${result.success ? 'СОЗДАНА' : 'НЕ СОЗДАНА В YCLIENTS'}</b>\n\n` +
      `👤 <b>${data.name}</b> — ${clientStatus}\n📞 ${phone}\n🤕 ${data.problem || 'не указана'}\n` +
      `📅 ${dateFormatted} в ${data.time}\n💆 ${data.service || 'услуга не определена'}${data.duration ? ` (${data.duration} мин)` : ''}` +
      `${isLate ? ` 🌙 ПОЗДНЯЯ ЗАПИСЬ — ${SERVICE_PRICES[serviceId]} ₽` : ''}\n` +
      `👨‍⚕️ Специалист: ${staffFullName}\n`;

    if (!result.success) {
      tgMsg += `\n❗ Проверь вручную в YCLIENTS`;
    }
    await sendTelegram(tgMsg);

    if (result.success) {
      const durationMin = parseInt(data.duration) || SINGLE_SERVICE_DURATION_MIN[serviceId] || 60;
      await scheduleFollowup(chatId, data.name, data.date, data.time, durationMin);
      await scheduleReviewRequest(chatId, phone, result.recordId, data.date, data.time, durationMin);
      await scheduleSocialFollowup(chatId, phone, result.recordId, data.date, data.time);
    }

    return { success: result.success, type: 'single', result };
  }

  // =====================================================================
  // MESSAGE HANDLER
  // =====================================================================

  // Защита от двойного ответа: если чат уже в обработке — копим сообщения и склеиваем
  const processingChats = new Set();
  const pendingMessages = {};
  // Таймеры "debounce": если клиент пишет несколько сообщений подряд, ждём паузу
  // и отвечаем один раз на все сразу, а не на каждое сообщение отдельно
  const pendingTimers = {};
  const MESSAGE_DEBOUNCE_MS = 8000;

  // Очередь обработки сообщений: если чат уже занят — копим сообщения и
  // обрабатываем их одним батчем после освобождения.
  async function enqueueMessage(chatId, userMessage) {
    // Копим сообщение и сбрасываем таймер — если клиент пишет несколько сообщений
    // подряд, отвечаем один раз на все, после паузы MESSAGE_DEBOUNCE_MS
    pendingMessages[chatId] = pendingMessages[chatId]
      ? pendingMessages[chatId] + '\n' + userMessage
      : userMessage;

    if (processingChats.has(chatId)) {
      console.log(`Chat ${chatId} busy, queued: "${userMessage}"`);
      return;
    }

    if (pendingTimers[chatId]) clearTimeout(pendingTimers[chatId]);
    pendingTimers[chatId] = setTimeout(() => {
      flushChat(chatId).catch(e => console.error('flushChat error:', e));
    }, MESSAGE_DEBOUNCE_MS);
  }

  async function flushChat(chatId) {
    delete pendingTimers[chatId];
    if (processingChats.has(chatId)) return;

    const fullMessage = pendingMessages[chatId];
    if (!fullMessage) return;
    delete pendingMessages[chatId];

    processingChats.add(chatId);
    try {
      await processMessageInner(chatId, fullMessage);
    } finally {
      processingChats.delete(chatId);
      // Если во время обработки пришли новые сообщения — отвечаем на них после паузы
      if (pendingMessages[chatId]) {
        if (pendingTimers[chatId]) clearTimeout(pendingTimers[chatId]);
        pendingTimers[chatId] = setTimeout(() => {
          flushChat(chatId).catch(e => console.error('flushChat error:', e));
        }, MESSAGE_DEBOUNCE_MS);
      }
    }
  }

  async function processMessageInner(chatId, userMessage) {
    const isAvito = !String(chatId).startsWith('tg_');

    let avitoHistoryCount = null;
    if (isAvito && (!dialogs[chatId] || !dialogs[chatId].messages.length)) {
      avitoHistoryCount = await restoreHistoryFromAvito(chatId, getDialog);
    }

    // Игнорируем эхо собственного сообщения
    const history = getMessages(chatId);
    if (history.length > 0) {
      const lastMsg = history[history.length - 1];
      if (lastMsg.role === 'assistant' && lastMsg.content === userMessage) {
        console.log('Skipping echo of own message');
        return;
      }
    }

    // Новый диалог — клиент написал впервые.
    // Для Avito история всегда содержит хотя бы текущее сообщение (Avito уже сохранил
    // его на своей стороне до webhook'а), поэтому проверяем по количеству сообщений в чате.
    const isNewDialog = isAvito ? avitoHistoryCount !== null && avitoHistoryCount <= 1 : history.length === 0;
    if (isNewDialog) {
      const channelLabel = isAvito ? 'Avito' : 'Telegram';
      await sendTelegram(
        `💬 <b>Новый диалог (${channelLabel})</b>\n\nЧат: <code>${chatId}</code>\n«${userMessage.substring(0, 200)}»`
      );
    }

    addMessage(chatId, 'user', userMessage);
    await cancelReminders(chatId);

    // Определяем по какому объявлению пишет клиент (кэшируем на чат, только для Avito)
    const dialog = getDialog(chatId);

    // Если до этого спросили про жалобу для врача — записываем ответ в примечание о клиенте
    if (dialog.pendingComplaintRecord) {
      const { phone, label } = dialog.pendingComplaintRecord;
      dialog.pendingComplaintRecord = null;
      const client = await findClient(phone);
      if (client) {
        const note = `Жалоба клиента (${label}, Авито): ${userMessage}`;
        await appendClientNote(client.id, client.comment, note);
        console.log(`Updated client ${client.id} note with complaint`);
      }
    }

    if (isAvito && dialog.itemId === undefined) {
      dialog.itemId = await getChatItemId(chatId);
    }
    const adContext = isAvito ? buildAdPriorityContext(dialog.itemId) : '';

    // Собираем контекст расписания и активный промпт, зовём Sonnet
    const [slotsContext, activePrompt] = await Promise.all([
      buildScheduleContext(),
      getActivePrompt(),
    ]);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: activePrompt + slotsContext + adContext,
      messages: getMessages(chatId),
    });

    const reply = response.content[0].text.trim();
    console.log('Reply:', reply);

    // Алина решила, что отвечать не нужно (благодарность/прощание, диалог уже завершён)
    if (reply === '[БЕЗ_ОТВЕТА]') {
      console.log(`Chat ${chatId}: ответ не требуется, диалог завершён`);
      await cancelReminders(chatId);
      return;
    }

    addMessage(chatId, 'assistant', reply);
    await sendClientMessage(chatId, reply, { getDialog, businessConnectionId: tgBusinessConnectionId, onSent: registerBotSentText });
    await scheduleReminders(chatId);

    // Алина передала вопрос администратору — уведомляем владельца
    if (isEscalation(reply)) {
      await sendTelegram(
        `🆘 <b>Алина передала диалог администратору</b>\n\nЧат: <code>${chatId}</code>\nСообщение клиента: ${userMessage}`
      );
    }

    // --- Попытка создать запись ---
    // Триггер: Алина сказала "Записала" в ответе. Всё остальное — внутри tryCreateBooking.
    if (isBookingConfirmation(reply) || extractPhone(userMessage)) {
      try {
        const result = await tryCreateBooking(chatId, reply, userMessage);
        console.log('Booking attempt result:', JSON.stringify(result));
      } catch (e) {
        console.error('tryCreateBooking error:', e.message);
        await sendTelegram(`❌ <b>Не удалось создать запись</b>\n\nЧат: <code>${chatId}</code>\n❗ Проверь диалог и YCLIENTS вручную.`);
      }
    }
  }

  return {
    dialogs,
    getDialog, addMessage, getMessages, clearDialog,
    enqueueMessage, processMessageInner,
    setHumanTaken, getHumanTakenAt, clearHumanTakenLocalOrDb,
    botSentTexts, registerBotSentText,
    generateReminder, scheduleReminders, cancelReminders,
    scheduleFollowup, scheduleReviewRequest, scheduleSocialFollowup,
    tryCreateBooking,
    setBusinessConnection, getBusinessConnectionId, getBusinessOwnerId,
  };
}

module.exports = { createConversationEngine };
