// =====================================================================
// shared/analytics.js — отчёты по дню/неделе/месяцу
// =====================================================================

const { STAFF, STAFF_FULLNAME, MASSAGE_STAFF_IDS, SERVICE_PRICES, calcMassageSalary } = require('./constants');
const { fmtDate } = require('./time');
const { getRecordsForPeriod, getFinanceForPeriod, getFreeSlots, getMassageSlots, sumExpenses } = require('./yclients');

// --- Аналитика ---
async function buildDayAnalytics(date) {
  const [records, finance] = await Promise.all([
    getRecordsForPeriod(date, date),
    getFinanceForPeriod(date, date),
  ]);

  const visited = records.filter(r => r.attendance === 1 || r.visit_attendance === 1 || r.status === 7);
  const allBooked = records.filter(r => r.deleted !== true);

  let cashTotal = 0, cardTotal = 0, cashCount = 0, cardCount = 0;
  for (const t of finance) {
    const amount = Math.abs(t.amount || 0);
    if (amount === 0) continue;
    if (t.payment_id === 1 || t.type === 'cash') { cashTotal += amount; cashCount++; }
    else { cardTotal += amount; cardCount++; }
  }

  let calcRevenue = 0;
  const serviceCounter = {};
  const massageSalary = { [STAFF.NIKITA]: 0, [STAFF.PAVEL]: 0 };

  for (const r of allBooked) {
    for (const s of (r.services || [])) {
      const sid = s.id;
      const price = s.cost || SERVICE_PRICES[sid] || 0;
      calcRevenue += price;
      const sName = s.title || sid;
      serviceCounter[sName] = (serviceCounter[sName] || 0) + 1;
      if (MASSAGE_STAFF_IDS.includes(r.staff_id)) {
        const salary = calcMassageSalary(sid);
        if (r.staff_id in massageSalary) massageSalary[r.staff_id] += salary;
      }
    }
  }

  const topServices = Object.entries(serviceCounter).sort((a, b) => b[1] - a[1]).slice(0, 5);
  return {
    date, totalBooked: allBooked.length, visited: visited.length,
    totalCassa: cashTotal + cardTotal, cashTotal, cardTotal, calcRevenue,
    topServices, massageSalary, records: allBooked,
  };
}

// dialogsCount — количество активных диалогов (для расчёта конверсии)
async function buildMonthAnalytics(year, month, dialogsCount = 0) {
  const dateFrom = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const dateTo = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;

  const [records, finance] = await Promise.all([
    getRecordsForPeriod(dateFrom, dateTo),
    getFinanceForPeriod(dateFrom, dateTo),
  ]);

  const allBooked = records.filter(r => r.deleted !== true);
  let cashTotal = 0, cardTotal = 0;
  for (const t of finance) {
    const amount = Math.abs(t.amount || 0);
    if (t.payment_id === 1 || t.type === 'cash') cashTotal += amount;
    else cardTotal += amount;
  }

  let calcRevenue = 0;
  const serviceCounter = {};
  const staffCounter = {};
  const massageSalary = { [STAFF.NIKITA]: 0, [STAFF.PAVEL]: 0 };
  const newClients = new Set();
  const repeatClients = new Set();

  for (const r of allBooked) {
    const sName = STAFF_FULLNAME[r.staff_id] || 'Другой';
    staffCounter[sName] = (staffCounter[sName] || 0) + 1;
    if (r.client?.id) {
      if ((r.client.visits_count || 0) <= 1) newClients.add(r.client.id);
      else repeatClients.add(r.client.id);
    }
    for (const s of (r.services || [])) {
      const sid = s.id;
      calcRevenue += s.cost || SERVICE_PRICES[sid] || 0;
      const sTitle = s.title || 'Услуга';
      serviceCounter[sTitle] = (serviceCounter[sTitle] || 0) + 1;
      if (MASSAGE_STAFF_IDS.includes(r.staff_id)) {
        const salary = calcMassageSalary(sid);
        if (r.staff_id in massageSalary) massageSalary[r.staff_id] += salary;
      }
    }
  }

  const topServices = Object.entries(serviceCounter).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topStaff = Object.entries(staffCounter).sort((a, b) => b[1] - a[1]);
  const totalDialogs = dialogsCount;
  const convRate = totalDialogs > 0 ? Math.round((allBooked.length / totalDialogs) * 100) : 0;

  return {
    dateFrom, dateTo, month, year,
    totalBooked: allBooked.length,
    totalCassa: cashTotal + cardTotal, cashTotal, cardTotal, calcRevenue,
    topServices, topStaff,
    newClients: newClients.size, repeatClients: repeatClients.size,
    massageSalary, convRate, totalDialogs,
    expenses: sumExpenses(finance),
  };
}

// Итоги недели (визиты, новые/повторные клиенты, затраты)
async function buildWeekAnalytics(dateFrom, dateTo) {
  const [records, finance] = await Promise.all([
    getRecordsForPeriod(dateFrom, dateTo),
    getFinanceForPeriod(dateFrom, dateTo),
  ]);

  const allBooked = records.filter(r => r.deleted !== true);
  const visited = allBooked.filter(r => r.attendance === 1 || r.visit_attendance === 1 || r.status === 7);

  const newClients = new Set();
  const repeatClients = new Set();
  for (const r of allBooked) {
    if (r.client?.id) {
      if ((r.client.visits_count || 0) <= 1) newClients.add(r.client.id);
      else repeatClients.add(r.client.id);
    }
  }

  return {
    dateFrom, dateTo,
    totalBooked: allBooked.length,
    visited: visited.length,
    newClients: newClients.size,
    repeatClients: repeatClients.size,
    expenses: sumExpenses(finance),
  };
}

// Записи и свободные слоты на следующую неделю
async function countNextWeekStats(dateFrom, dateTo) {
  const records = await getRecordsForPeriod(dateFrom, dateTo);
  const bookings = records.filter(r => r.deleted !== true).length;

  let emptySlots = 0;
  let d = new Date(dateFrom + 'T12:00:00+03:00');
  const end = new Date(dateTo + 'T12:00:00+03:00');
  while (d <= end) {
    const date = d.toISOString().split('T')[0];
    const [alexSlots, massage] = await Promise.all([
      getFreeSlots(date, STAFF.ALEXANDER),
      getMassageSlots(date),
    ]);
    emptySlots += alexSlots.length + massage.slots.length;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return { bookings, emptySlots };
}

function formatDayReport(a) {
  const dateLabel = fmtDate(a.date);
  const cassa = a.totalCassa > 0
    ? `${a.totalCassa.toLocaleString('ru-RU')} ₽`
    : `~${a.calcRevenue.toLocaleString('ru-RU')} ₽ (расчётно по прайсу)`;

  let msg = `📊 <b>Аналитика дня — ${dateLabel}</b>\n\n`;
  msg += `📋 Записей: <b>${a.totalBooked}</b>\n`;

  if (a.totalCassa > 0) {
    msg += `💰 Касса: <b>${cassa}</b>\n`;
    if (a.cashTotal > 0) msg += `   💵 Нал: ${a.cashTotal.toLocaleString('ru-RU')} ₽\n`;
    if (a.cardTotal > 0) msg += `   💳 Безнал: ${a.cardTotal.toLocaleString('ru-RU')} ₽\n`;
  } else {
    msg += `💰 Расчётная выручка: <b>${a.calcRevenue.toLocaleString('ru-RU')} ₽</b>\n`;
    msg += `   <i>(данные оплат из YCLIENTS недоступны)</i>\n`;
  }
  msg += `\n`;

  const ns = a.massageSalary[STAFF.NIKITA], ps = a.massageSalary[STAFF.PAVEL];
  if (ns > 0 || ps > 0) {
    msg += `👨‍⚕️ <b>ЗП массажистов:</b>\n`;
    if (ns > 0) msg += `   Никита Цыганков: ${ns.toLocaleString('ru-RU')} ₽\n`;
    if (ps > 0) msg += `   Павел Нелюбов: ${ps.toLocaleString('ru-RU')} ₽\n`;
    msg += `\n`;
  }

  if (a.records.length > 0) {
    msg += `📝 <b>Записи:</b>\n`;
    for (const r of a.records.slice(0, 10)) {
      const time = r.datetime ? r.datetime.substring(11, 16) : '?';
      const clientName = r.client?.name || 'Клиент';
      const staffName = STAFF_FULLNAME[r.staff_id] || '';
      const service = r.services?.[0]?.title || 'услуга';
      msg += `   ${time} — ${clientName}, ${service}`;
      if (staffName) msg += `, ${staffName.split(' ')[0]}`;
      msg += `\n`;
    }
    if (a.records.length > 10) msg += `   ...и ещё ${a.records.length - 10}\n`;
  } else {
    msg += `📝 Записей на этот день нет\n`;
  }
  return msg;
}

function formatMonthReport(a) {
  const monthNames = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
  const monthLabel = `${monthNames[a.month - 1]} ${a.year}`;
  const cassa = a.totalCassa > 0
    ? `${a.totalCassa.toLocaleString('ru-RU')} ₽`
    : `~${a.calcRevenue.toLocaleString('ru-RU')} ₽ (расчётно)`;

  let msg = `📈 <b>Аналитика за ${monthLabel}</b>\n\n`;
  msg += `📋 Всего записей: <b>${a.totalBooked}</b>\n`;
  msg += `💰 Касса: <b>${cassa}</b>\n`;
  if (a.totalCassa > 0) {
    msg += `   💵 Нал: ${a.cashTotal.toLocaleString('ru-RU')} ₽\n`;
    msg += `   💳 Безнал: ${a.cardTotal.toLocaleString('ru-RU')} ₽\n`;
  }
  msg += `\n👥 <b>Клиенты:</b>\n`;
  msg += `   🆕 Новые: ${a.newClients}\n`;
  msg += `   ♻️ Повторные: ${a.repeatClients}\n`;
  if (a.totalDialogs > 0) msg += `   📱 Конверсия диалогов: ${a.convRate}%\n`;

  if (a.topServices.length) {
    msg += `\n🏆 <b>Топ услуг:</b>\n`;
    for (const [name, count] of a.topServices) msg += `   ${name}: ${count} раз\n`;
  }
  if (a.topStaff.length) {
    msg += `\n👨‍⚕️ <b>Специалисты:</b>\n`;
    for (const [name, count] of a.topStaff) msg += `   ${name}: ${count} записей\n`;
  }

  const ns = a.massageSalary[STAFF.NIKITA], ps = a.massageSalary[STAFF.PAVEL];
  if (ns > 0 || ps > 0) {
    msg += `\n💸 <b>ЗП массажистов за месяц:</b>\n`;
    if (ns > 0) msg += `   Никита Цыганков: ${ns.toLocaleString('ru-RU')} ₽\n`;
    if (ps > 0) msg += `   Павел Нелюбов: ${ps.toLocaleString('ru-RU')} ₽\n`;
  }

  if (a.expenses > 0) msg += `\n📉 Затраты за месяц: ${a.expenses.toLocaleString('ru-RU')} ₽\n`;

  const totalClients = a.newClients + a.repeatClients;
  if (totalClients > 0) {
    const retention = Math.round((a.repeatClients / totalClients) * 100);
    msg += `🔁 Возвращаемость: ${retention}%\n`;
  }
  return msg;
}

// Еженедельный отчёт по понедельникам в 9:00
function formatWeekReport(week, next) {
  let msg = `🗓 <b>Итоги недели</b>\n\n`;
  msg += `Визитов: ${week.visited}\n`;
  msg += `Новых клиентов: ${week.newClients}\n`;
  msg += `Повторных: ${week.repeatClients}\n`;
  msg += `Записей на следующую неделю: ${next.bookings}\n`;
  msg += `Пустых слотов: ${next.emptySlots}\n`;
  if (week.expenses > 0) msg += `\n📉 Затраты за неделю: ${week.expenses.toLocaleString('ru-RU')} ₽\n`;
  return msg;
}

// Закрытие дня — каждый день в 19:30
function formatDayCloseReport(a) {
  const dateLabel = fmtDate(a.date);
  let msg = `🌙 <b>Закрытие дня — ${dateLabel}</b>\n\n`;

  if (a.totalCassa > 0) {
    msg += `💰 Касса: <b>${a.totalCassa.toLocaleString('ru-RU')} ₽</b>\n`;
    if (a.cashTotal > 0) msg += `   💵 Нал: ${a.cashTotal.toLocaleString('ru-RU')} ₽\n`;
    if (a.cardTotal > 0) msg += `   💳 Безнал: ${a.cardTotal.toLocaleString('ru-RU')} ₽\n`;
  } else {
    msg += `💰 Касса: данные из YCLIENTS недоступны\n`;
  }

  const ns = a.massageSalary[STAFF.NIKITA], ps = a.massageSalary[STAFF.PAVEL];
  msg += `\n👨‍⚕️ <b>ЗП массажистов сегодня:</b>\n`;
  msg += `   Никита Цыганков: ${ns.toLocaleString('ru-RU')} ₽\n`;
  msg += `   Павел Нелюбов: ${ps.toLocaleString('ru-RU')} ₽\n`;

  return msg;
}

module.exports = {
  buildDayAnalytics,
  buildMonthAnalytics,
  buildWeekAnalytics,
  countNextWeekStats,
  formatDayReport,
  formatMonthReport,
  formatWeekReport,
  formatDayCloseReport,
};
