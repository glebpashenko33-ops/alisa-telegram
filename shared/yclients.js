// =====================================================================
// shared/yclients.js — YCLIENTS API: слоты, записи, клиенты, аналитика
// =====================================================================

const { YC, STAFF, SERVICES, COMPLEX_CONFIG, STAFF_FULLNAME } = require('./constants');

async function ycRequest(method, path, body) {
  const r = await fetch(`https://api.yclients.com/api/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${YC.partner()}, User ${YC.user()}`,
      'Accept': 'application/vnd.yclients.v2+json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

// Свободные слоты конкретного мастера на дату.
// serviceId опционально — YCLIENTS вернёт слоты с учётом длительности услуги.
async function getFreeSlots(date, staffId, serviceId) {
  try {
    let url = `/book_times/${YC.company()}/${staffId}/${date}`;
    if (serviceId) url += `?service_ids[]=${serviceId}`;
    const data = await ycRequest('GET', url, null);
    if (!data.data || !data.data.length) return [];
    return data.data.map(s => s.time ? s.time.substring(0, 5) : null).filter(Boolean);
  } catch (e) {
    console.error('getFreeSlots error:', e.message);
    return [];
  }
}

// Объединённые слоты массажистов (для одиночного массажа)
async function getMassageSlots(date, serviceId) {
  try {
    const [nikita, pavel] = await Promise.all([
      getFreeSlots(date, STAFF.NIKITA, serviceId),
      getFreeSlots(date, STAFF.PAVEL,  serviceId),
    ]);
    const all = [...new Set([...nikita, ...pavel])].sort();
    return { slots: all, nikita, pavel };
  } catch (e) {
    console.error('getMassageSlots error:', e.message);
    return { slots: [], nikita: [], pavel: [] };
  }
}

// Расчёт слотов для комплекса: Александр (мануалка 30 мин) → массажист сразу после.
// Принимает уже загруженные слоты — без лишних API вызовов.
function calcComplexSlots(alexSlots, nikitaSlots, pavelSlots) {
  const byTime = {};
  const validSlots = [];

  for (const aSlot of alexSlots) {
    const [h, m] = aSlot.split(':').map(Number);
    const afterMin = h * 60 + m + 30;
    const needTime = `${String(Math.floor(afterMin / 60)).padStart(2, '0')}:${String(afterMin % 60).padStart(2, '0')}`;

    // Никита приоритетнее (он первым в списке)
    let match = null;
    if (nikitaSlots.includes(needTime)) match = { massageTime: needTime, staffId: STAFF.NIKITA };
    else if (pavelSlots.includes(needTime)) match = { massageTime: needTime, staffId: STAFF.PAVEL };

    if (match) {
      validSlots.push(aSlot);
      byTime[aSlot] = match;
    }
  }
  return { slots: validSlots, byTime };
}

// Полная загрузка слотов комплекса с учётом длительности массажа.
async function getComplexSlots(date, massageServiceId) {
  try {
    const [alex, massage] = await Promise.all([
      getFreeSlots(date, STAFF.ALEXANDER, SERVICES.MANUAL),
      getMassageSlots(date, massageServiceId),
    ]);
    // Fallback если service_id не вернул ничего — берём общие слоты массажистов
    const useMassage = (massage.nikita.length || massage.pavel.length) ? massage : await getMassageSlots(date);
    return { ...calcComplexSlots(alex, useMassage.nikita, useMassage.pavel), alex, massage: useMassage.slots };
  } catch (e) {
    console.error('getComplexSlots error:', e.message);
    return { slots: [], alex: [], massage: [], byTime: {} };
  }
}

// Создание одиночной записи с верификацией и проверкой слота
async function createBooking({ name, phone, date, time, serviceId, staffId, comment }) {
  try {
    // Перепроверяем что слот ещё свободен — но это НЕ блокирующая проверка.
    // YCLIENTS — единственный источник правды. Если слот реально занят — POST вернёт ошибку,
    // и мы корректно её обработаем. Если же предварительная проверка ложно отрицательна
    // (например, разные list'ы из-за параметров услуги) — это не должно ломать запись.
    const freshSlots = await getFreeSlots(date, staffId, serviceId);
    if (!freshSlots.includes(time)) {
      console.warn(`[pre-check] Slot ${time} not in fresh list for staff ${staffId} on ${date}. Available: ${freshSlots.join(', ')}. Будем пробовать создать запись.`);
    }

    const datetime = `${date}T${time}:00+03:00`;
    const body = {
      phone,
      fullname: name,
      email: '',
      notify_by_sms: 1,
      notify_by_email: 0,
      appointments: [{ id: 1, services: [serviceId], staff_id: staffId, datetime }],
      comment: comment || 'Запись через Алину (Авито)',
    };

    console.log('createBooking REQUEST:', JSON.stringify(body));
    const data = await ycRequest('POST', `/book_record/${YC.company()}`, body);
    console.log('createBooking RESPONSE:', JSON.stringify(data));

    const created = data.success === true || data.returncode === 1 ||
      (Array.isArray(data.data) && data.data.length > 0);

    if (!created) {
      // Определяем по сообщению YCLIENTS — занят ли слот
      const errMsg = data.meta?.message || JSON.stringify(data);
      const isSlotTaken = /занят|свободн|недоступ|не подход|busy|unavailable/i.test(errMsg);
      const result = { success: false, error: errMsg, recordId: null };
      if (isSlotTaken) {
        result.slotTaken = true;
        result.availableSlots = await getFreeSlots(date, staffId, serviceId);
      }
      return result;
    }

    const recordId = data.data?.[0]?.id || null;
    await new Promise(r => setTimeout(r, 2000));
    const verified = await verifyBooking(phone, date);
    console.log('Booking verify result:', verified);

    return { success: true, recordId, verified };
  } catch (e) {
    console.error('createBooking error:', e.message);
    return { success: false, error: e.message, recordId: null };
  }
}

// Создание комплексной записи — 2 записи подряд
async function createComplexBooking({ name, phone, date, time, complexType }) {
  try {
    const cfg = COMPLEX_CONFIG[complexType] || COMPLEX_CONFIG['Лайт'];

    // ВАЖНО: получаем слоты с учётом правильной длительности массажа
    const complex = await getComplexSlots(date, cfg.massageSvc);
    const match = complex.byTime[time];

    if (!match) {
      console.error('Complex slot not found for time:', time, 'in', JSON.stringify(complex.slots));
      return { success: false, error: 'Время не найдено в слотах комплекса', recordId: null };
    }

    const massageStaffId = match.staffId;
    const massageTime = match.massageTime;
    const commonComment = `${cfg.label} (${cfg.price} ₽)`;

    console.log(`Complex booking: Александр at ${time}, ${STAFF_FULLNAME[massageStaffId]} at ${massageTime}`);

    const alexResult = await createBooking({
      name, phone, date, time,
      serviceId: cfg.manualSvc, staffId: STAFF.ALEXANDER,
      comment: commonComment + ' [часть 1/2]',
    });

    const massageResult = await createBooking({
      name, phone, date, time: massageTime,
      serviceId: cfg.massageSvc, staffId: massageStaffId,
      comment: commonComment + ' [часть 2/2]',
    });

    console.log('Complex part 1 (alex):', JSON.stringify(alexResult));
    console.log('Complex part 2 (massage):', JSON.stringify(massageResult));

    return {
      success: alexResult.success && massageResult.success,
      complexLabel: cfg.label, complexPrice: cfg.price,
      manualPart:  { time, staffId: STAFF.ALEXANDER, result: alexResult },
      massagePart: { time: massageTime, staffId: massageStaffId, result: massageResult },
    };
  } catch (e) {
    console.error('createComplexBooking error:', e.message);
    return { success: false, error: e.message };
  }
}

async function verifyBooking(phone, date) {
  try {
    const cleanPhone = phone.replace(/\D/g, '');
    const clientData = await ycRequest('POST', `/company/${YC.company()}/clients/search`, { phone: cleanPhone });
    if (!clientData.data?.length) return false;
    const clientId = clientData.data[0].id;
    const recordsData = await ycRequest('GET', `/records/${YC.company()}?client_id=${clientId}&start_date=${date}&end_date=${date}`, null);
    return Array.isArray(recordsData.data) && recordsData.data.length > 0;
  } catch (e) {
    console.error('verifyBooking error:', e.message);
    return false;
  }
}

async function findClient(phone) {
  try {
    const cleanPhone = phone.replace(/\D/g, '');
    const data = await ycRequest('POST', `/company/${YC.company()}/clients/search`, { phone: cleanPhone });
    if (data.data?.length) {
      const c = data.data[0];
      return { id: c.id, name: c.name, phone: c.phone, visits: c.visits_count || 0, comment: c.comment || '' };
    }
    return null;
  } catch (e) {
    console.error('findClient error:', e.message);
    return null;
  }
}

// Добавление текста в примечание о клиенте (видно администратору в карточке клиента)
async function appendClientNote(clientId, existingComment, note) {
  try {
    const comment = existingComment ? `${existingComment}\n${note}` : note;
    await ycRequest('PUT', `/client/${YC.company()}/${clientId}`, { comment });
    return true;
  } catch (e) {
    console.error('appendClientNote error:', e.message);
    return false;
  }
}

// Сохраняем жалобу клиента (с чем пришёл) в примечание о клиенте — НЕ в комментарий к записи
async function saveComplaintNote(phone, label, source, problem) {
  if (!problem) return;
  const client = await findClient(phone);
  if (client) {
    await appendClientNote(client.id, client.comment, `Жалоба клиента (${label}, ${source}): ${problem}`);
  }
}

async function getRecordsForPeriod(dateFrom, dateTo) {
  try {
    const data = await ycRequest('GET', `/records/${YC.company()}?start_date=${dateFrom}&end_date=${dateTo}&count=200`, null);
    return data.data || [];
  } catch (e) {
    console.error('getRecordsForPeriod error:', e.message);
    return [];
  }
}

// attendance: 2 = клиент подтвердил визит
async function setRecordAttendance(recordId, recordHash, attendance) {
  try {
    await ycRequest('PUT', `/record/${YC.company()}/${recordId}/${recordHash}`, { attendance });
    return true;
  } catch (e) {
    console.error('setRecordAttendance error:', e.message);
    return false;
  }
}

async function getFinanceForPeriod(dateFrom, dateTo) {
  try {
    const data = await ycRequest('GET', `/transactions/${YC.company()}?start_date=${dateFrom}&end_date=${dateTo}&count=200`, null);
    return data.data || [];
  } catch (e) {
    console.error('getFinanceForPeriod error:', e.message);
    return [];
  }
}

// Затраты — транзакции с отрицательной суммой (расходы из кассы)
function sumExpenses(finance) {
  let total = 0;
  for (const t of finance) {
    if ((t.amount || 0) < 0) total += Math.abs(t.amount);
  }
  return total;
}

module.exports = {
  ycRequest,
  getFreeSlots,
  getMassageSlots,
  calcComplexSlots,
  getComplexSlots,
  createBooking,
  createComplexBooking,
  verifyBooking,
  findClient,
  appendClientNote,
  saveComplaintNote,
  getRecordsForPeriod,
  setRecordAttendance,
  getFinanceForPeriod,
  sumExpenses,
};
