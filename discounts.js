// =====================================================================
// shared/discounts.js — скидочные окна (массаж 60/90 и комплекс "Стандарт")
// =====================================================================

const db = require('../db');
const { STAFF, SERVICES, DISCOUNT_MASSAGE_PRICES, DISCOUNT_COMPLEX_PRICE, DISCOUNT_TEMPLATES } = require('./constants');
const { todayMoscow, fmtDate } = require('./time');
const { getMassageSlots, getFreeSlots } = require('./yclients');
const { sendTelegram, sendTelegramWithId } = require('./telegramApi');

// На вечернюю запись (с 20:00 до 00:00) скидки не даём
function filterDaytimeSlots(slots) {
  return slots.filter(t => parseInt(t.split(':')[0], 10) < 20);
}

function buildDiscountMassagePost(template, time, duration) {
  const { full, discounted } = DISCOUNT_MASSAGE_PRICES[duration];
  if (template === 'A') {
    return `🕐 Сегодня в ${time} — окно на массаж со скидкой 20%\n` +
      `Слот освободился, отдаём дешевле чем обычно — лишь бы не пустовало.\n` +
      `${duration} мин / спина и шея — ${discounted} вместо ${full} ₽\n` +
      `Успеете сегодня — пишите прямо сюда, запишем за минуту. @boli_net_chat`;
  }
  if (template === 'B') {
    return `Доброе утро. У нас сегодня в ${time} есть окно — и мы отдаём его со скидкой.\n` +
      `Массаж ${duration} мин — ${discounted} ₽ вместо ${full} ₽.\n` +
      `Если давно собирались — вот повод. Пишите, запишем.`;
  }
  return `${time} сегодня — свободно.\n` +
    `Массаж ${duration} мин / спина и шея за ${discounted} ₽ — на ${full - discounted} рублей дешевле обычного.\n` +
    `Таких окон мало, следующее неизвестно когда. Пишите — Алина запишет сразу.`;
}

function buildDiscountComplexPost(template, time) {
  const { full, discounted } = DISCOUNT_COMPLEX_PRICE;
  if (template === 'A') {
    return `🕐 Сегодня в ${time} — комплекс со скидкой 20%\n` +
      `Стандарт: массаж + мануальная терапия + иглоукалывание/физиотерапия — всё за один сеанс.\n` +
      `${discounted} ₽ вместо ${full} ₽ — слот освободился, отдаём дешевле чем пустовать.\n` +
      `Пишите сюда — Алина запишет сразу.`;
  }
  if (template === 'B') {
    return `Доброе утро. В ${time} сегодня открылось окно на комплексный сеанс.\n` +
      `Стандарт — массаж, мануальная терапия и иглоукалывание/физио за один визит.\n` +
      `Обычно ${full} ₽, сегодня ${discounted} ₽.\n` +
      `Если давно собирались — удобный момент. Пишите.`;
  }
  return `${time} сегодня — есть окно.\n` +
    `Комплекс Стандарт: массаж + мануалка + иглоукалывание — ${discounted} ₽ вместо ${full} ₽.\n` +
    `Таких окон мало. Пишите — запишем за минуту.`;
}

// Утром проверяем расписание — если у массажистов или у Александра (под "Стандарт")
// есть пустой слот сегодня, постим скидочное окно (ротация шаблонов А→Б→В)
async function postDiscountWindow() {
  try {
    const today = todayMoscow();

    const massage60 = await getMassageSlots(today, SERVICES.MASSAGE_60);
    const massage90 = await getMassageSlots(today, SERVICES.MASSAGE_90);
    const slots60 = filterDaytimeSlots(massage60.slots);
    const slots90 = filterDaytimeSlots(massage90.slots);

    let postType, time, staffId, serviceId, duration;

    if (slots60.length) {
      postType = 'massage';
      duration = 60;
      time = slots60[0];
      staffId = massage60.nikita.includes(time) ? STAFF.NIKITA : STAFF.PAVEL;
      serviceId = SERVICES.MASSAGE_60;
    } else if (slots90.length) {
      postType = 'massage';
      duration = 90;
      time = slots90[0];
      staffId = massage90.nikita.includes(time) ? STAFF.NIKITA : STAFF.PAVEL;
      serviceId = SERVICES.MASSAGE_90;
    } else {
      const alexSlots = filterDaytimeSlots(await getFreeSlots(today, STAFF.ALEXANDER, SERVICES.STANDARD));
      if (!alexSlots.length) {
        console.log('No free slots for discount post today');
        return;
      }
      postType = 'complex';
      time = alexSlots[0];
      staffId = STAFF.ALEXANDER;
      serviceId = SERVICES.STANDARD;
    }

    const idxRaw = await db.getSetting('discount_post_template_index');
    const idx = idxRaw ? parseInt(idxRaw) % 3 : 0;
    const template = DISCOUNT_TEMPLATES[idx];

    const text = postType === 'massage'
      ? buildDiscountMassagePost(template, time, duration)
      : buildDiscountComplexPost(template, time);

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

    await db.setSetting('discount_post_template_index', String((idx + 1) % 3));
    await db.addDiscountPost(today, postType, staffId, serviceId, time, channelChatId, channelMsgId);
    console.log(`Discount post (${postType}${duration ? ' ' + duration : ''}, template ${template}) sent for ${time}`);
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
  buildDiscountMassagePost,
  buildDiscountComplexPost,
  postDiscountWindow,
  postDailySlots,
};
