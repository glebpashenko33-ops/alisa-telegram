// =====================================================================
// shared/scheduleContext.js — сборка контекста расписания для промпта,
// определение service_id/staff_id по тексту
// =====================================================================

const { STAFF, SERVICES, STAFF_FULLNAME } = require('./constants');
const { nowMoscow, fmtDate } = require('./time');
const { getFreeSlots, getMassageSlots, calcComplexSlots } = require('./yclients');

// Форматирует слоты массажистов с именем мастера в скобках
// Если оба мастера свободны в одно время — показывает обоих через /
function fmtMassageSlots(slots, detail) {
  return slots.map(slot => {
    const hasN = detail.nikita.includes(slot);
    const hasP = detail.pavel.includes(slot);
    if (hasN && hasP) return `${slot} (Никита/Павел)`;
    if (hasN) return `${slot} (Никита)`;
    if (hasP) return `${slot} (Павел)`;
    return slot;
  }).join(', ');
}

// Кэш расписания — 5 минут, чтобы не дёргать YCLIENTS на каждое сообщение
let scheduleCache = null;
let scheduleCacheTime = 0;
const SCHEDULE_CACHE_TTL = 5 * 60 * 1000;

// Сборка контекста расписания для системного промпта
async function buildScheduleContext() {
  // Возвращаем из кэша если свежий
  if (scheduleCache && Date.now() - scheduleCacheTime < SCHEDULE_CACHE_TTL) {
    return scheduleCache;
  }

  try {
    const now = nowMoscow();
    const daysToFetch = 4; // 4 дня достаточно — большинство записей в ближайшие дни
    const dates = [];
    for (let i = 0; i <= daysToFetch; i++) {
      const d = new Date(now.getTime() + i * 86400000);
      dates.push(d.toISOString().split('T')[0]);
    }

    const allSlots = await Promise.all(dates.map(async (date) => {
      const [alex, alexManual, massage30, massage60, massage90, late60, late90] = await Promise.all([
        getFreeSlots(date, STAFF.ALEXANDER),
        getFreeSlots(date, STAFF.ALEXANDER, SERVICES.MANUAL),
        getMassageSlots(date, SERVICES.MASSAGE_30),
        getMassageSlots(date, SERVICES.MASSAGE_60),
        getMassageSlots(date, SERVICES.MASSAGE_90),
        getFreeSlots(date, STAFF.NIKITA, SERVICES.MASSAGE_LATE_60),
        getFreeSlots(date, STAFF.NIKITA, SERVICES.MASSAGE_LATE_90),
      ]);
      const alexForComplex = alexManual.length ? alexManual : alex;
      // Fallback только если все три вернули пусто (ленивый — без лишнего запроса)
      let fallback = null;
      const needFallback =
        (!massage30.nikita.length && !massage30.pavel.length) ||
        (!massage60.nikita.length && !massage60.pavel.length) ||
        (!massage90.nikita.length && !massage90.pavel.length);
      if (needFallback) fallback = await getMassageSlots(date);
      const m30 = (massage30.nikita.length || massage30.pavel.length) ? massage30 : (fallback || massage30);
      const m60 = (massage60.nikita.length || massage60.pavel.length) ? massage60 : (fallback || massage60);
      const m90 = (massage90.nikita.length || massage90.pavel.length) ? massage90 : (fallback || massage90);
      const complex60 = calcComplexSlots(alexForComplex, m60.nikita, m60.pavel);
      const complex90 = calcComplexSlots(alexForComplex, m90.nikita, m90.pavel);
      return {
        date, alex,
        massage30: m30.slots, massage60: m60.slots, massage90: m90.slots,
        massage30detail: m30, massage60detail: m60, massage90detail: m90,
        complex60: complex60.slots, complex60byTime: complex60.byTime,
        complex90: complex90.slots, complex90byTime: complex90.byTime,
        late60, late90,
      };
    }));

    const nowLabel = now.toLocaleDateString('ru-RU', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow',
    });

    let text = "\n\n[РЕАЛЬНОЕ РАСПИСАНИЕ — GMT+3 Краснодар]\n";
    text += `СЕГОДНЯ: ${nowLabel}\n\n`;
    text += "ПРАВИЛО ВЫБОРА СЛОТОВ:\n";
    text += "- Массаж 30 мин → бери из МАССАЖ-30\n";
    text += "- Массаж 60 мин → бери из МАССАЖ-60\n";
    text += "- Массаж 90 мин → бери из МАССАЖ-90\n";
    text += "- Мануальная / иглы / УВТ / SIS+PBM / консультация / VIP → бери из АЛЕКСАНДР\n";
    text += "- Лайт или Стандарт → бери из ЛАЙТ/СТАНДАРТ\n";
    text += "- Комфорт или Про-сессия → бери из КОМФОРТ/ПРО\n";
    text += "- Массаж 60/90 мин на время с 20:00 и позже → бери из ПОЗДНЯЯ ЗАПИСЬ-60 / ПОЗДНЯЯ ЗАПИСЬ-90 (только Никита, повышенная цена)\n";
    text += "КРИТИЧНО: слоты в каждой строке уже учитывают длительность услуги — предлагай ТОЛЬКО их.\n\n";

    for (const day of allSlots) {
      const hasAny = day.alex.length || day.massage30.length || day.massage60.length || day.massage90.length || day.complex60.length || day.complex90.length || day.late60.length || day.late90.length;
      if (!hasAny) continue;
      text += fmtDate(day.date) + ":\n";
      if (day.alex.length) text += "  АЛЕКСАНДР: " + day.alex.join(", ") + "\n";
      if (day.massage30.length) {
        const slots30 = fmtMassageSlots(day.massage30, day.massage30detail);
        text += "  МАССАЖ-30: " + slots30 + "\n";
      }
      if (day.massage60.length) {
        const slots60 = fmtMassageSlots(day.massage60, day.massage60detail);
        text += "  МАССАЖ-60: " + slots60 + "\n";
      }
      if (day.massage90.length) {
        const slots90 = fmtMassageSlots(day.massage90, day.massage90detail);
        text += "  МАССАЖ-90: " + slots90 + "\n";
      }
      if (day.late60.length) text += "  ПОЗДНЯЯ ЗАПИСЬ-60 (Никита, 5000 руб): " + day.late60.join(", ") + "\n";
      if (day.late90.length) text += "  ПОЗДНЯЯ ЗАПИСЬ-90 (Никита, 6500 руб): " + day.late90.join(", ") + "\n";
      if (day.complex60.length) {
        const details = day.complex60.map(slot => {
          const m = day.complex60byTime[slot];
          return m ? `${slot} (${STAFF_FULLNAME[m.staffId]})` : slot;
        });
        text += "  ЛАЙТ/СТАНДАРТ (1.5ч): " + details.join(", ") + "\n";
      }
      if (day.complex90.length) {
        const details = day.complex90.map(slot => {
          const m = day.complex90byTime[slot];
          return m ? `${slot} (${STAFF_FULLNAME[m.staffId]})` : slot;
        });
        text += "  КОМФОРТ/ПРО (2ч): " + details.join(", ") + "\n";
      }
      text += "\n";
    }

    text += "ПРАВИЛО: предлагай клиенту ТОЛЬКО дни и слоты которые есть в расписании выше.\n";
    text += "Если дня нет в списке — в этот день нет свободных мест.\n\n";
    text += "КРИТИЧНО ПРО ДЛИТЕЛЬНОСТЬ МАССАЖА:\n";
    text += "- Клиент хочет массаж 30 мин → показывай только МАССАЖ-30. Не предлагай слоты из других строк.\n";
    text += "- Клиент хочет массаж 60 мин → показывай только МАССАЖ-60.\n";
    text += "- Клиент хочет массаж 90 мин → показывай только МАССАЖ-90.\n";
    text += "- Слоты уже посчитаны с учётом длительности — НЕ добавляй и НЕ убирай ничего от себя.\n\n";
    text += "КРИТИЧНО ПРО СПЕЦИАЛИСТОВ:\n";
    text += "- НИКОГДА не говори 'Павел не принимает' или 'Никита не работает' — ты не знаешь этого.\n";
    text += "- Если клиент просит конкретного мастера — найди его имя в скобках рядом со слотами. Если его нет — значит у него нет свободного времени в этот день, скажи 'на сегодня к Павлу мест нет' и предложи другой день или другого мастера.\n";
    text += "- Отсутствие слотов = всё занято, а не 'не принимает'.\n\n";
    text += "ВАЖНО ПРО ДНИ НЕДЕЛИ:\n";
    text += "- Когда клиент говорит 'четверг', 'пятница' и т.д. — найди БЛИЖАЙШИЙ такой день в расписании и сразу покажи слоты. НЕ уточняй 'какой именно четверг' — всегда ближайший.\n";
    text += "- Если ближайшего такого дня нет в расписании — предложи другие дни из списка.\n";
    text += "- 'на этой неделе' / 'после обеда' — сразу выбери подходящие слоты после 12:00-13:00 из ближайших дней.\n\n";
    text += "ВАЖНО ПРО КОМПЛЕКСЫ:\n";
    text += "- Лайт/Стандарт → бери слоты из строки ЛАЙТ/СТАНДАРТ. Там массаж 60 мин точно влезает.\n";
    text += "- Комфорт/Про-сессия → бери слоты из строки КОМФОРТ/ПРО. Там общий массаж 90 мин точно влезает.\n";
    text += "- В скобках указан ФИО массажиста — используй его в подтверждении записи.\n";
    text += "- Время = начало мануалки. Массаж начинается сразу после, без перерыва.\n\n";
    text += "Если клиент просит время которого нет — назови слоты которые есть в этот день И предложи дни где есть похожее время.\n";
    text += "Если совсем ничего не подходит — сообщи что передашь администратору.\n";
    text += "[СТРОГО: предлагай ТОЛЬКО реальные слоты из расписания выше]";

    // Сохраняем в кэш
    scheduleCache = text;
    scheduleCacheTime = Date.now();
    return text;
  } catch (e) {
    console.error('buildScheduleContext error:', e.message);
    return scheduleCache || ''; // при ошибке отдаём прошлый кэш если есть
  }
}

// Определение service_id по названию услуги и длительности
function getServiceId(serviceName, duration) {
  if (!serviceName) return SERVICES.CONSULTATION;
  const s = serviceName.toLowerCase();
  if (s.includes('консультац')) return SERVICES.CONSULTATION;
  if (s.includes('мануальн')) return SERVICES.MANUAL;
  if (s.includes('игл') || s.includes('миостимул') || s.includes('сухой')) return SERVICES.NEEDLES;
  if (s.includes('увт') || s.includes('волнов')) return SERVICES.UWT;
  if (s.includes('sis') || s.includes('магнит') || s.includes('pbm')) return SERVICES.SIS_PBM;
  if (s.includes('vip') || s.includes('вип')) return SERVICES.VIP_60;
  if (s.includes('лайт')) return SERVICES.LITE;
  if (s.includes('стандарт')) return SERVICES.STANDARD;
  if (s.includes('комфорт')) return SERVICES.COMFORT;
  if (s.includes('про-сессия') || s.includes('про сессия')) return SERVICES.PRO;
  if (s.includes('антистресс') || s.includes('нейросед')) return SERVICES.NEURO_MASSAGE;
  if (s.includes('поздн')) {
    const d = parseInt(duration) || 60;
    return d === 90 ? SERVICES.MASSAGE_LATE_90 : SERVICES.MASSAGE_LATE_60;
  }
  if (s.includes('знакомств')) return SERVICES.ACQUAINTANCE;

  if (s.includes('массаж')) {
    const d = parseInt(duration) || 60;
    if (d === 30) return SERVICES.MASSAGE_30;
    if (d === 90) return SERVICES.MASSAGE_90;
    return SERVICES.MASSAGE_60;
  }
  if (s.includes('30 мин') || s.includes('полчаса')) return SERVICES.MASSAGE_30;
  if (s.includes('90 мин') || s.includes('полтора')) return SERVICES.MASSAGE_90;
  return SERVICES.CONSULTATION;
}

function getStaffId(specialistName, serviceId) {
  // Поздняя запись — только Никита
  if (serviceId === SERVICES.MASSAGE_LATE_60 || serviceId === SERVICES.MASSAGE_LATE_90) {
    return STAFF.NIKITA;
  }
  const massageServices = [
    SERVICES.MASSAGE_30, SERVICES.MASSAGE_60, SERVICES.MASSAGE_90,
    SERVICES.NEURO_MASSAGE
  ];
  if (massageServices.includes(serviceId)) {
    if (specialistName) {
      const s = specialistName.toLowerCase();
      if (s.includes('никита') || s.includes('цыганков')) return STAFF.NIKITA;
      if (s.includes('павел') || s.includes('нелюбов')) return STAFF.PAVEL;
    }
    return STAFF.NIKITA;
  }
  if (!specialistName) return STAFF.ALEXANDER;
  const s = specialistName.toLowerCase();
  if (s.includes('никита') || s.includes('цыганков')) return STAFF.NIKITA;
  if (s.includes('павел') || s.includes('нелюбов')) return STAFF.PAVEL;
  return STAFF.ALEXANDER;
}

module.exports = {
  buildScheduleContext,
  fmtMassageSlots,
  getServiceId,
  getStaffId,
  SCHEDULE_CACHE_TTL,
};
