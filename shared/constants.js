// =====================================================================
// shared/constants.js — конфиг, ID, цены, расписание услуг
// =====================================================================

const YC = {
  partner: () => process.env.YCLIENTS_PARTNER_TOKEN,
  user:    () => process.env.YCLIENTS_USER_TOKEN,
  company: () => process.env.YCLIENTS_COMPANY_ID || '905561',
};

const STAFF = {
  ALEXANDER: 2749354,
  NIKITA:    3459462,
  PAVEL:     4391850,
};

const STAFF_FULLNAME = {
  [STAFF.ALEXANDER]: 'Цой Александр Игоревич',
  [STAFF.NIKITA]:    'Цыганков Никита Александрович',
  [STAFF.PAVEL]:     'Нелюбов Павел Сергеевич',
};

const MASSAGE_STAFF_IDS = [STAFF.NIKITA, STAFF.PAVEL];

// Соответствие объявлений Авито (item_id) персональному мастеру.
// Объявления Александра — общие, без приоритета по мастеру.
const AD_STAFF_PRIORITY = {
  7536696953: STAFF.NIKITA, // массаж спины и шеи — Никита
  7760535318: STAFF.PAVEL,  // опытный массажист 12 лет практики — Паша
};

const SERVICES = {
  CONSULTATION:     15063315,
  MANUAL:           13398926,
  NEEDLES:          17627833,
  UWT:              26627593,
  SIS_PBM:          26627596,
  MASSAGE_30:       22582389,
  MASSAGE_60:       18409863,
  MASSAGE_90:       18409870,
  LITE:             18404646,
  STANDARD:         18290874,
  COMFORT:          18290875,
  PRO:              18290894,
  VIP_60:           26627585,
  ACQUAINTANCE:     17684234,
  MASSAGE_LATE_60:  28905519, // Поздняя запись (20:00-23:59), только Никита
  MASSAGE_LATE_90:  28905543, // Поздняя запись (20:00-23:59), только Никита
  NEURO_MASSAGE:    28905588,
};

// Поздняя запись доступна только у Никиты, начиная с этого времени
const LATE_BOOKING_FROM = '20:00';

const SERVICE_PRICES = {
  [SERVICES.CONSULTATION]:    0,
  [SERVICES.MANUAL]:          3000,
  [SERVICES.NEEDLES]:         1500,
  [SERVICES.UWT]:             2000,
  [SERVICES.SIS_PBM]:         2000,
  [SERVICES.MASSAGE_30]:      2000,
  [SERVICES.MASSAGE_60]:      3000,
  [SERVICES.MASSAGE_90]:      4000,
  [SERVICES.LITE]:            4500,
  [SERVICES.STANDARD]:        5500,
  [SERVICES.COMFORT]:         6500,
  [SERVICES.PRO]:             7500,
  [SERVICES.VIP_60]:          6000,
  [SERVICES.ACQUAINTANCE]:    1999,
  [SERVICES.MASSAGE_LATE_60]: 5000,
  [SERVICES.MASSAGE_LATE_90]: 6500,
  [SERVICES.NEURO_MASSAGE]:   5000,
};

// Конфиг комплексов — единый источник правды
const COMPLEX_CONFIG = {
  'Лайт':       { id: SERVICES.LITE,     price: 4500, manualSvc: SERVICES.MANUAL, massageSvc: SERVICES.MASSAGE_60, label: 'Комплекс Лайт',     durationMin: 90 },
  'Стандарт':   { id: SERVICES.STANDARD, price: 5500, manualSvc: SERVICES.MANUAL, massageSvc: SERVICES.MASSAGE_60, label: 'Комплекс Стандарт', durationMin: 90 },
  'Комфорт':    { id: SERVICES.COMFORT,  price: 6500, manualSvc: SERVICES.MANUAL, massageSvc: SERVICES.MASSAGE_90, label: 'Комплекс Комфорт',  durationMin: 120 },
  'Про-сессия': { id: SERVICES.PRO,      price: 7500, manualSvc: SERVICES.MANUAL, massageSvc: SERVICES.MASSAGE_90, label: 'Про-сессия',        durationMin: 120 },
};

// ЗП массажистов
function calcMassageSalary(serviceId) {
  if (serviceId === SERVICES.MASSAGE_30) return 800;
  if (serviceId === SERVICES.MASSAGE_90 || serviceId === SERVICES.MASSAGE_LATE_90) return 1500;
  if (serviceId === SERVICES.MASSAGE_60 || serviceId === SERVICES.MASSAGE_LATE_60 || serviceId === SERVICES.NEURO_MASSAGE) return 1000;
  return 0;
}

// --- Скидочные окна (массаж 60/90 мин и комплекс "Стандарт") ---
const DISCOUNT_MASSAGE_PRICES = {
  60: {
    full: SERVICE_PRICES[SERVICES.MASSAGE_60],
    discounted: Math.round(SERVICE_PRICES[SERVICES.MASSAGE_60] * 0.8),
  },
  90: {
    full: SERVICE_PRICES[SERVICES.MASSAGE_90],
    discounted: Math.round(SERVICE_PRICES[SERVICES.MASSAGE_90] * 0.8),
  },
};
const DISCOUNT_COMPLEX_PRICE = {
  full: COMPLEX_CONFIG['Стандарт'].price,
  discounted: Math.round(COMPLEX_CONFIG['Стандарт'].price * 0.8),
};

module.exports = {
  YC,
  STAFF,
  STAFF_FULLNAME,
  MASSAGE_STAFF_IDS,
  AD_STAFF_PRIORITY,
  SERVICES,
  SERVICE_PRICES,
  COMPLEX_CONFIG,
  LATE_BOOKING_FROM,
  calcMassageSalary,
  DISCOUNT_MASSAGE_PRICES,
  DISCOUNT_COMPLEX_PRICE,
};
