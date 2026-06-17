// =====================================================================
// shared/discounts.js — скидочные окна (массаж 60/90 и комплекс "Стандарт")
// =====================================================================

const db = require('../db');
const { STAFF, SERVICES, DISCOUNT_MASSAGE_PRICES, DISCOUNT_COMPLEX_PRICE } = require('./constants');
const { todayMoscow, fmtDate } = require('./time');
const { getMassageSlots, getFreeSlots, getRecordsForPeriod } = require('./yclients');
const { sendTelegramWithId } = require('./telegramApi');

// На вечернюю запись (с 20:00 до 00:00) скидки не даём
function filterDaytimeSlots(slots) {
  return slots.filter(t => parseInt(t.split(':')[0], 10) < 20);
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const STAFF_FIRSTNAME = {
  [STAFF.NIKITA]: 'Никита',
  [STAFF.PAVEL]: 'Павел',
  [STAFF.ALEXANDER]: 'Александр',
};

// Текст скидочного поста: 1-2 окна на массаж (60 и 90 мин со скидкой 20%)
// с указанием мастера, и опционально окно на комплекс "Стандарт" (тоже -20%)
function buildDiscountPost(date, windows, complexWindow) {
  const { full: full60, discounted: disc60 } = DISCOUNT_MASSAGE_PRICES[60];
  const { full: full90, discounted: disc90 } = DISCOUNT_MASSAGE_PRICES[90];

  const lines = windows.map(w => `${w.time} — ${w.staffName}`);
  if (complexWindow) lines.push(`${complexWindow.time} — ${complexWindow.staffName}`);

  let text = `🗓️ ${capitalize(fmtDate(date))}\n\n${lines.join('\n')}\n\n`;
  if (windows.length) {
    text += `— Массаж 60 минут — ${disc60}₽\nвместо ${full60}₽\n`;
    text += `— Массаж 90 минут – ${disc90}₽\nвместо ${full90}₽\n`;
  }
  if (complexWindow) {
    const { full: fullC, discounted: discC } = DISCOUNT_COMPLEX_PRICE;
    text += `— Комплекс Стандарт – ${discC}₽\nвместо ${fullC}₽\n`;
  }
  text += `\n💆 Кол-во мест строго ограничено.\n\n`;
  text += `👉 Пишите в личку @boli_net_chat , чтобы занять окно.`;
  return text;
}

const MAX_TABLES = 2; // Физических кушеток в кабинете

// Загружаем все записи дня и возвращаем список { startMin, durationMin } по каждой.
// durationMin берём из r.duration (минуты), если не задано — используем 60 мин как минимум.
async function loadDayRecords(date) {
  const records = await getRecordsForPeriod(date, date);
  const result = [];
  for (const r of records) {
    if (r.deleted || !r.datetime) continue;
    const time = r.datetime.substring(11, 16);
    const [h, m] = time.split(':').map(Number);
    const startMin = h * 60 + m;
    const durationMin = (r.duration && r.duration > 0) ? r.duration : 60;
    result.push({ startMin, durationMin, staffId: r.staff_id });
  }
  return result;
}

// Считает, сколько сессий идёт параллельно в момент slotMin.
function countConcurrentAt(slotMin, dayRecords) {
  return dayRecords.filter(r => r.startMin <= slotMin && r.startMin + r.durationMin > slotMin).length;
}

// Возвращает true если у мастера есть следующая запись менее чем через minGap минут
// после slotTime ("HH:MM") — значит, слот слишком короткий для реального приёма.
function slotConflicts(slotTime, staffId, dayRecords, minGap = 60) {
  const [h, m] = slotTime.split(':').map(Number);
  const slotMin = h * 60 + m;
  // Следующая запись этого мастера начинается раньше, чем закончится сеанс
  return dayRecords.some(r => r.staffId === staffId && r.startMin > slotMin && r.startMin < slotMin + minGap);
}

// Утром проверяем расписание — берём свободные окна у Никиты/Павла на массаж
// 60 и 90 минут (дневные, без ночной записи) и выдаём 1-2 окна со скидкой 20%.
// Раз в пару дней дополнительно добавляем окно на комплекс "Стандарт" у Александра.
async function postDiscountWindow(date) {
  try {
    const today = date || todayMoscow();

    const [massage60, massage90, dayRecords] = await Promise.all([
      getMassageSlots(today, SERVICES.MASSAGE_60),
      getMassageSlots(today, SERVICES.MASSAGE_90),
      loadDayRecords(today),
    ]);

    const slots60 = filterDaytimeSlots(massage60.slots);
    const slots90 = filterDaytimeSlots(massage90.slots);
    const massageTimes = [...new Set([...slots60, ...slots90])].sort();

    // Двойной фильтр:
    // 1. До следующей записи этого мастера должно быть ≥ 60 мин (влезает сеанс)
    // 2. В момент слота уже занято меньше MAX_TABLES кушеток (физическое ограничение)
    const validTimes = massageTimes.filter(time => {
      const staffId = (massage60.nikita.includes(time) || massage90.nikita.includes(time))
        ? STAFF.NIKITA : STAFF.PAVEL;
      if (slotConflicts(time, staffId, dayRecords, 60)) return false;
      const [h, m] = time.split(':').map(Number);
      if (countConcurrentAt(h * 60 + m, dayRecords) >= MAX_TABLES) return false;
      return true;
    });

    const windows = validTimes.slice(0, 2).map(time => {
      const staffId = (massage60.nikita.includes(time) || massage90.nikita.includes(time))
        ? STAFF.NIKITA : STAFF.PAVEL;
      return { time, staffName: STAFF_FIRSTNAME[staffId] };
    });

    let complexWindow = null;
    if (windows.length < 2) {
      const dayOfMonth = new Date(today + 'T12:00:00+03:00').getUTCDate();
      if (dayOfMonth % 2 === 0) {
        const alexSlots = filterDaytimeSlots(await getFreeSlots(today, STAFF.ALEXANDER, SERVICES.STANDARD));
        if (alexSlots.length) {
          complexWindow = { time: alexSlots[0], staffName: STAFF_FIRSTNAME[STAFF.ALEXANDER] };
        }
      }
    }

    if (!windows.length && !complexWindow) {
      console.log('No free slots for discount post today');
      return;
    }

    const text = buildDiscountPost(today, windows, complexWindow);

    const channelChatId = process.env.TELEGRAM_SALE_CHAT_ID;
    if (!channelChatId) {
      console.error('TELEGRAM_SALE_CHAT_ID не задан — пост не отправлен');
      return;
    }

    const channelMsgId = await sendTelegramWithId(text, channelChatId);
    if (!channelMsgId) {
      console.error('postDiscountWindow: не удалось отправить пост в канал — проверьте права бота в канале');
      return;
    }

    const allTimes = [...windows.map(w => w.time), ...(complexWindow ? [complexWindow.time] : [])];
    await db.addDiscountPost(today, 'daily', null, null, allTimes.join(','), channelChatId, channelMsgId);
    console.log(`Discount post sent for ${allTimes.join(', ')}${complexWindow ? ' (+ комплекс)' : ''}`);
  } catch (e) {
    console.error('postDiscountWindow error:', e.message);
  }
}

module.exports = {
  filterDaytimeSlots,
  buildDiscountPost,
  postDiscountWindow,
};
