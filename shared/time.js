// =====================================================================
// shared/time.js — работа с GMT+3 (Москва/Краснодар)
// =====================================================================

function nowMoscow() {
  return new Date(Date.now() + 3 * 60 * 60 * 1000);
}

function todayMoscow() {
  return nowMoscow().toISOString().split('T')[0];
}

function fmtDate(dateStr) {
  return new Date(dateStr + 'T12:00:00+03:00').toLocaleDateString('ru-RU', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Moscow',
  });
}

function addDaysISO(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00+03:00');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

// Сдвигает дату на ближайший будний день (если попали на сб/вс)
function nextWeekday(dateStr) {
  const d = new Date(dateStr + 'T12:00:00+03:00');
  const dow = d.getUTCDay(); // 0 = вс, 6 = сб
  if (dow === 0) d.setUTCDate(d.getUTCDate() + 1);
  else if (dow === 6) d.setUTCDate(d.getUTCDate() + 2);
  return d.toISOString().split('T')[0];
}

// Время отправки: будни, 10:00-12:00 или (если allowEvening) 18:00-20:00 МСК
function computeSendWindow(targetDateStr, allowEvening) {
  const date = nextWeekday(targetDateStr);
  const useEvening = allowEvening && Math.random() < 0.5;
  const startHour = useEvening ? 18 : 10;
  const hour = startHour + Math.floor(Math.random() * 2);
  const minute = Math.floor(Math.random() * 60);
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return new Date(`${date}T${hh}:${mm}:00+03:00`).toISOString();
}

function pick(...options) {
  return options[Math.floor(Math.random() * options.length)];
}

module.exports = {
  nowMoscow,
  todayMoscow,
  fmtDate,
  addDaysISO,
  nextWeekday,
  computeSendWindow,
  pick,
};
