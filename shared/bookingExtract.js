// =====================================================================
// shared/bookingExtract.js — извлечение данных бронирования из диалога
// =====================================================================

const { todayMoscow } = require('./time');

// Извлечение телефона из произвольного текста
function extractPhone(text) {
  const m = text.match(/(\+7|8|7)[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}/);
  if (!m) return null;
  return m[0].replace(/[\s\-\(\)]/g, '').replace(/^8/, '7').replace(/^\+/, '');
}

// Нормализация телефона для сопоставления записей YCLIENTS с client_channels —
// последние 10 цифр, без кода страны/префикса
function normalizePhone(phone) {
  return (phone || '').replace(/\D/g, '').slice(-10);
}

// Поиск телефона во ВСЕЙ истории диалога (не только в последнем сообщении)
function findPhoneInHistory(messages) {
  // Идём с конца — последнее упоминание самое актуальное
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue;
    const phone = extractPhone(messages[i].content);
    if (phone) return phone;
  }
  return null;
}

// Определение типа комплекса по тексту ответа Алины — ОДИН источник правды
function detectComplexFromReply(reply) {
  const r = reply.toLowerCase();
  if (r.includes('про-сессия') || r.includes('про сессия')) return 'Про-сессия';
  if (r.includes('комфорт')) return 'Комфорт';
  if (r.includes('стандарт')) return 'Стандарт';
  if (r.includes('лайт')) return 'Лайт';
  // Эвристика: если в одном "Записала..." упомянуты и мануалка, и массаж — это комплекс
  if (r.includes('мануальн') && r.includes('массаж')) return 'Лайт';
  return null;
}

// Строгий триггер записи: Алина сказала "Записала" — это финал диалога
function isBookingConfirmation(reply) {
  // НЕ используем \b — в JS границы слов не работают с кириллицей.
  // Слова "записала", "оформила", "записываю" специфичны — ложных срабатываний практически нет.
  return /(записала|оформила|записываю)/i.test(reply);
}

// Алина передала диалог администратору — сообщение вне её зоны ответственности
function isEscalation(reply) {
  return /передам ваш (вопрос|случай) администратор/i.test(reply);
}

// Извлечение данных бронирования через Haiku.
// КЛЮЧЕВОЕ: анализируем только последние 8 сообщений — без галлюцинаций из середины диалога.
// anthropic — клиент @anthropic-ai/sdk, передаётся вызывающим кодом.
async function extractBookingData(anthropic, messages) {
  try {
    const recent = messages.slice(-8);
    const historyText = recent.map(m =>
      `${m.role === 'user' ? 'Клиент' : 'Алина'}: ${m.content}`
    ).join('\n');

    const today = todayMoscow();
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Проанализируй ПОСЛЕДНЮЮ ЧАСТЬ диалога и извлеки данные для записи. Отвечай ТОЛЬКО JSON без пояснений.
Если данных нет — пиши null для этого поля.
Сегодняшняя дата: ${today} (GMT+3 Краснодар/Москва)

ВАЖНО: ориентируйся прежде всего на последнее сообщение Алины со словом "Записала". Имя, дата, время и услуга — оттуда.

Диалог (последняя часть):
${historyText}

Верни JSON:
{
  "name": "имя клиента (только имя, в именительном падеже) или null",
  "phone": "телефон в формате 79991234567 или null",
  "service": "название услуги или null",
  "duration": "30 или 60 или 90 (минут массажа) или null",
  "date": "дата в формате YYYY-MM-DD (вычисли из 'сегодня'/'завтра'/конкретной даты) или null",
  "time": "время в формате HH:MM — конкретное время записи или null",
  "specialist": "полное имя специалиста или null",
  "problem": "с чем пришёл клиент, 1 предложение или null",
  "is_complex": "true если запись на КОМПЛЕКС (Лайт/Стандарт/Комфорт/Про-сессия), иначе false",
  "complex_type": "Лайт / Стандарт / Комфорт / Про-сессия или null"
}`
      }]
    });

    const text = response.content[0].text.trim();
    let clean = text.replace(/```json|```/g, '').trim();
    const first = clean.indexOf('{');
    const last = clean.lastIndexOf('}');
    if (first !== -1 && last !== -1) clean = clean.substring(first, last + 1);
    return JSON.parse(clean);
  } catch (e) {
    console.error('extractBookingData error:', e.message);
    return null;
  }
}

// Резервный парсер из текста ответа Алины (на случай если Haiku вернул null)
function parseBookingFromReply(reply, today) {
  try {
    const result = { name: null, date: null, time: null, service: null };

    const nameMatch = reply.match(/Записала\s+([А-ЯЁ][а-яё]+)/);
    if (nameMatch) result.name = nameMatch[1];

    const timeMatch = reply.match(/в\s+(\d{1,2}:\d{2})/);
    if (timeMatch) result.time = timeMatch[1].padStart(5, '0');

    const months = { 'января':1,'февраля':2,'марта':3,'апреля':4,'мая':5,'июня':6,'июля':7,'августа':8,'сентября':9,'октября':10,'ноября':11,'декабря':12 };
    const dateMatch = reply.match(/на\s+(\d{1,2})\s+([а-яё]+)/i);
    if (dateMatch) {
      const day = parseInt(dateMatch[1]);
      const month = months[dateMatch[2].toLowerCase()];
      if (month && day) {
        const year = parseInt(today.split('-')[0]);
        result.date = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      }
    }
    return result;
  } catch (e) {
    return null;
  }
}

module.exports = {
  extractPhone,
  normalizePhone,
  findPhoneInHistory,
  detectComplexFromReply,
  isBookingConfirmation,
  isEscalation,
  extractBookingData,
  parseBookingFromReply,
};
