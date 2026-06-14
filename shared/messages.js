// =====================================================================
// shared/messages.js — шаблоны сообщений клиентам
// =====================================================================

const { pick } = require('./time');

// Ссылка на отзыв об исполнителе на Авито
const REVIEW_LINK = 'https://www.avito.ru/user/review?fid=2_liUKdqGfTQkFfM7eu5D3GejowHx4ZBZ87DElF8B0nlyL6RdaaYzvyPSWRjp4ZyNE';

function buildFollowupMessage(name) {
  return `${name ? name + ', ' : ''}надеемся, сеанс прошёл хорошо! Если что-то не так — напишите нам, разберёмся.\n\n` +
    `Пожалуйста, проверьте свои вещи после сеанса.\n\n` +
    `Будем очень благодарны за отзыв: ${REVIEW_LINK}`;
}

// Запрос отзыва (Telegram-канал) — три площадки
function buildReviewMessage() {
  return `Здравствуйте!\n` +
    `Если у вас будет пару минут, оставьте, пожалуйста, отзыв 🙏\n\n` +
    `Это помогает нам расти и даёт возможность большему количеству людей разобраться со своей болью.\n\n` +
    `Яндекс: https://clck.ru/3F9tut\n` +
    `2ГИС: https://clck.ru/3GasUf\n` +
    `Авито: https://clck.ru/3FDdpd`;
}

// Приглашение в телеграм-канал перед визитом
const SOCIAL_CHANNEL_LINK = 'https://t.me/bolineeet';

function buildSocialMessage() {
  return `Спасибо, что выбрали нас. Рады, что вы записались.\n` +
    `Пока ждёте визит — заглядывайте в наш телеграм-канал. Там мы коротко рассказываем, что и почему болит, и как тело подаёт сигналы. Возможно, что-то отзовётся.\n` +
    `${SOCIAL_CHANNEL_LINK}\n` +
    `До встречи!`;
}

function buildTouch1Message(name) {
  return `${name ? name + ', ' : ''}добрый день. Как после сеанса — всё в порядке?`;
}

function buildTouch2Message(name) {
  return `${name ? name + ', ' : ''}добрый день. Месяц после визита — как самочувствие? ` +
    `Если что-то беспокоит — запишитесь на контрольный осмотр, бесплатно. ` +
    `Если всё хорошо, но хочется поддержать результат — есть массаж или физиотерапия. Подберём под ваш запрос.`;
}

function buildTouch3Message() {
  return `Добрый день. Если тело снова напоминает о себе — мы здесь.`;
}

const FILIAL_NAME = 'Боли.Нет (Краснодар, ул. Гаврилова 115)';

// Напоминание за день до визита (шаблон + случайные вариации формулировок)
function buildDayBeforeMessage(name, services, startTime) {
  const cond = pick('Если планы не изменились', 'Если всё удобно');
  const farewell = pick('До встречи', 'Хорошего дня');
  return `Здравствуйте, ${name}!\n\n` +
    `Напоминаю: вы записаны на ${services} завтра в ${startTime}. ${cond}, подтвердите, пожалуйста, визит сообщением «+».\n\n` +
    `Будем ждать вас в ${FILIAL_NAME}. ${farewell}`;
}

// Утреннее напоминание тем, кто не подтвердил визит вечером
function buildMorningReminderMessage() {
  return pick(
    '☕ Доброе утро, подскажите, Вы подойдете сегодня?',
    '☀️ Доброе утро! Скажите пожалуйста, Вы подойдете сегодня?'
  );
}

// Ответ клиенту после подтверждения "+"
function buildConfirmThanksMessage(startTime) {
  return pick(
    `Спасибо за подтверждение! Будем ждать вас завтра в ${startTime} 🌿`,
    `Отлично, записали как подтверждённую! До встречи завтра в ${startTime} 🌿`,
    `Спасибо! Завтра в ${startTime} ждём вас, будет приятный сеанс 🌿`
  );
}

// Подтверждение записи сразу после её создания (Telegram)
function buildBookingConfirmMessage(name, date, startTime, services, master) {
  const dayMonth = new Date(date + 'T12:00:00+03:00').toLocaleDateString('ru-RU', {
    day: 'numeric', month: 'long', timeZone: 'Europe/Moscow',
  });
  const dayOfWeek = new Date(date + 'T12:00:00+03:00').toLocaleDateString('ru-RU', {
    weekday: 'long', timeZone: 'Europe/Moscow',
  });
  return `Здравствуйте ${name}!🙌🏼\n` +
    `---------------------\n` +
    `✍ Вы записались в центр восстановления "Боли.Нет", на ${dayMonth} (${dayOfWeek}) в ${startTime}.\n` +
    `---------------------\n` +
    `✨ Услуга: ${services}\n` +
    `👤 Сотрудник: ${master}\n` +
    `---------------------\n` +
    `📍 По адресу: г. Краснодар, ул. Гаврилова 115, 2 этаж.\n` +
    `---------------------\n` +
    `Если нужно отменить или перенести запись — просто напишите нам здесь, поможем 🙌`;
}

// Доп. вопрос про жалобу для врача — отправляется после записи в Avito-чате
function buildComplaintRequestMessage() {
  return pick(
    'Если вам не сложно, напишите в двух словах, что вас беспокоит и как давно — чтобы доктор знал заранее 🙏',
    'И ещё: расскажите, пожалуйста, в двух словах, что беспокоит и как давно — передам доктору, чтобы был готов 🙏'
  );
}

// Уведомление об отмене записи (CRM)
function buildCancelMessage(date, startTime) {
  const dayMonth = new Date(date + 'T12:00:00+03:00').toLocaleDateString('ru-RU', {
    day: 'numeric', month: 'long', timeZone: 'Europe/Moscow',
  });
  return pick(
    `😔 Ваша запись на ${dayMonth} в ${startTime} отменена`,
    `Мы отменили запись на ${dayMonth} в ${startTime} 😔`
  );
}

module.exports = {
  REVIEW_LINK,
  buildFollowupMessage,
  buildReviewMessage,
  SOCIAL_CHANNEL_LINK,
  buildSocialMessage,
  buildTouch1Message,
  buildTouch2Message,
  buildTouch3Message,
  FILIAL_NAME,
  buildDayBeforeMessage,
  buildMorningReminderMessage,
  buildConfirmThanksMessage,
  buildBookingConfirmMessage,
  buildComplaintRequestMessage,
  buildCancelMessage,
};
