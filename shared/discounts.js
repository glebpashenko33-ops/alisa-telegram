// =====================================================================
// shared/discounts.js — скидочные окна (массаж 60/90 и комплекс "Стандарт")
// =====================================================================

const db = require('../db');
const { STAFF, SERVICES, DISCOUNT_MASSAGE_PRICES, DISCOUNT_COMPLEX_PRICE } = require('./constants');
const { todayMoscow, fmtDate } = require('./time');
const { getMassageSlots, getFreeSlots } = require('./yclients');
const { sendTelegram, sendTelegramWithId } = require('./telegramApi');

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

// Утром проверяем расписание — берём свободные окна у Никиты/Павла на массаж
// 60 и 90 минут (дневные, без ночной записи) и выдаём 1-2 окна со скидкой 20%.
// Раз в пару дней дополнительно добавляем окно на комплекс "Стандарт" у Александра.
async function postDiscountWindow() {
  try {
    const today = todayMoscow();

    const massage60 = await getMassageSlots(today, SERVICES.MASSAGE_60);
    const massage90 = await getMassageSlots(today, SERVICES.MASSAGE_90);
    const slots60 = filterDaytimeSlots(massage60.slots);
    const slots90 = filterDaytimeSlots(massage90.slots);
    const massageTimes = [...new Set([...slots60, ...slots90])].sort();

    const windows = massageTimes.slice(0, 2).map(time => {
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

// --- Автопостинг свободных окон в канал в 9:00 МСК ---
async function postDailySlots() {
  try {
    const today = todayMoscow();
    const tomorrow = new Date(Date.now() + 86400000 + 3 * 60 * 60 * 1000).toISOString().split('T')[0];

    const [todayMassage, tomorrowMassage] = await Promise.all([
      getMassageSlots(today),
      getMassageSlots(tomorrow),
    ]);

    if (!todayMassage.slots.length && !tomorrowMassage.slots.length) {
      console.log('No massage slots to post today');
      return;
    }

    let msg = `💆‍♂️ <b>Свободные окна массажа</b>\n\n`;
    if (todayMassage.slots.length) {
      msg += `<b>Сегодня (${fmtDate(today)}):</b>\n${todayMassage.slots.join('  |  ')}\n\n`;
    }
    if (tomorrowMassage.slots.length) {
      msg += `<b>Завтра (${fmtDate(tomorrow)}):</b>\n${tomorrowMassage.slots.join('  |  ')}\n\n`;
    }
    msg += `📍 Краснодар, ул. Гаврилова 115, 2 этаж\n📞 +7 995 266-20-00\n💬 Записаться — написать в личку на Авито`;

    const saleChatId = process.env.TELEGRAM_SALE_CHAT_ID;
    if (saleChatId) {
      await sendTelegram(msg, saleChatId);
      console.log('Daily slots posted to @boli_net_sale');
    } else {
      console.log('TELEGRAM_SALE_CHAT_ID не задан, постинг пропущен');
    }
  } catch (e) {
    console.error('postDailySlots error:', e.message);
  }
}

module.exports = {
  filterDaytimeSlots,
  buildDiscountPost,
  postDiscountWindow,
  postDailySlots,
};
