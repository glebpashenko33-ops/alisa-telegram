// =====================================================================
// db.js — Подключение к PostgreSQL, настройки и история промптов
// =====================================================================

const { Pool } = require('pg');

// Пул соединений — переиспользуем между запросами
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

// =====================================================================
// Инициализация таблиц при первом запуске
// =====================================================================

async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS prompt_versions (
        id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS followups (
        id SERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL,
        send_at TIMESTAMP NOT NULL,
        message TEXT NOT NULL,
        sent BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pending_reminders (
        id SERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL,
        reminder_type INT NOT NULL,
        due_at TIMESTAMP NOT NULL,
        snapshot TEXT,
        sent BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS client_channels (
        phone TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (phone, chat_id)
      )
    `);

    // Миграция со старой схемы (один канал на телефон) — поддержка нескольких каналов
    await pool.query(`
      ALTER TABLE client_channels DROP CONSTRAINT IF EXISTS client_channels_pkey
    `);
    await pool.query(`
      ALTER TABLE client_channels ADD PRIMARY KEY (phone, chat_id)
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS visit_confirmations (
        id SERIAL PRIMARY KEY,
        record_id TEXT NOT NULL,
        record_hash TEXT,
        phone TEXT,
        chat_id TEXT NOT NULL,
        visit_date DATE NOT NULL,
        start_time TEXT,
        confirmed BOOLEAN NOT NULL DEFAULT FALSE,
        morning_sent BOOLEAN NOT NULL DEFAULT FALSE,
        escalation_notified BOOLEAN NOT NULL DEFAULT FALSE,
        sent_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      ALTER TABLE visit_confirmations ADD COLUMN IF NOT EXISTS escalation_notified BOOLEAN NOT NULL DEFAULT FALSE
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS review_followups (
        id SERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL,
        phone TEXT,
        record_id TEXT,
        visit_date DATE,
        due_at TIMESTAMP NOT NULL,
        sent BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS social_followups (
        id SERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL,
        phone TEXT,
        record_id TEXT,
        visit_date DATE,
        due_at TIMESTAMP NOT NULL,
        sent BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS tracked_records (
        record_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        visit_date DATE NOT NULL,
        start_time TEXT,
        cancel_notified BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS touch_chain (
        id SERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL UNIQUE,
        phone TEXT,
        name TEXT,
        last_visit_date DATE NOT NULL,
        next_step INT NOT NULL DEFAULT 1,
        due_at TIMESTAMP NOT NULL,
        stopped BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS human_taken_chats (
        chat_id TEXT PRIMARY KEY,
        taken_at TIMESTAMP NOT NULL
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS discount_posts (
        id SERIAL PRIMARY KEY,
        post_date DATE NOT NULL,
        post_type TEXT NOT NULL,
        staff_id BIGINT,
        service_id BIGINT,
        slot_time TEXT NOT NULL,
        channel_chat_id TEXT,
        channel_message_id BIGINT,
        admin_chat_id TEXT,
        admin_message_id BIGINT,
        removed BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    console.log('[db] Таблицы готовы');
    return true;
  } catch (e) {
    console.error('[db] Ошибка инициализации таблиц:', e.message);
    return false;
  }
}

// =====================================================================
// Кэш — 30 секунд, чтобы не дёргать БД на каждый запрос
// =====================================================================

const cache = {};
const CACHE_TTL = 30 * 1000; // 30 секунд

function cacheGet(key) {
  const entry = cache[key];
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL) {
    delete cache[key];
    return undefined;
  }
  return entry.value;
}

function cacheSet(key, value) {
  cache[key] = { value, ts: Date.now() };
}

function cacheInvalidate(key) {
  delete cache[key];
}

// =====================================================================
// settings — произвольные ключ-значение
// =====================================================================

async function getSetting(key) {
  const cached = cacheGet('setting:' + key);
  if (cached !== undefined) return cached;

  try {
    const res = await pool.query(
      'SELECT value FROM settings WHERE key = $1',
      [key]
    );
    const value = res.rows[0]?.value ?? null;
    cacheSet('setting:' + key, value);
    return value;
  } catch (e) {
    console.error(`[db] getSetting(${key}) ошибка:`, e.message);
    return null;
  }
}

async function setSetting(key, value) {
  try {
    await pool.query(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, value]
    );
    cacheInvalidate('setting:' + key);
    return true;
  } catch (e) {
    console.error(`[db] setSetting(${key}) ошибка:`, e.message);
    return false;
  }
}

async function getAllSettings() {
  try {
    const res = await pool.query(
      'SELECT key, value, updated_at FROM settings ORDER BY key'
    );
    return res.rows;
  } catch (e) {
    console.error('[db] getAllSettings ошибка:', e.message);
    return [];
  }
}

// =====================================================================
// prompt_versions — история версий промпта
// =====================================================================

async function getPrompt() {
  const cached = cacheGet('prompt:current');
  if (cached !== undefined) return cached;

  try {
    const res = await pool.query(
      'SELECT content FROM prompt_versions ORDER BY id DESC LIMIT 1'
    );
    const content = res.rows[0]?.content ?? null;
    cacheSet('prompt:current', content);
    return content;
  } catch (e) {
    console.error('[db] getPrompt ошибка:', e.message);
    return null;
  }
}

async function setPrompt(text) {
  try {
    await pool.query(
      'INSERT INTO prompt_versions (content, created_at) VALUES ($1, NOW())',
      [text]
    );
    cacheInvalidate('prompt:current');
    return true;
  } catch (e) {
    console.error('[db] setPrompt ошибка:', e.message);
    return false;
  }
}

async function getPromptHistory() {
  try {
    const res = await pool.query(
      'SELECT id, LEFT(content, 120) AS preview, created_at FROM prompt_versions ORDER BY id DESC LIMIT 5'
    );
    return res.rows;
  } catch (e) {
    console.error('[db] getPromptHistory ошибка:', e.message);
    return [];
  }
}

// Откат: берём текст конкретной версии и создаём новую запись с ним
async function rollbackPrompt(versionId) {
  try {
    const res = await pool.query(
      'SELECT content FROM prompt_versions WHERE id = $1',
      [versionId]
    );
    if (!res.rows[0]) return { ok: false, error: 'Версия не найдена' };
    await pool.query(
      'INSERT INTO prompt_versions (content, created_at) VALUES ($1, NOW())',
      [res.rows[0].content]
    );
    cacheInvalidate('prompt:current');
    return { ok: true };
  } catch (e) {
    console.error('[db] rollbackPrompt ошибка:', e.message);
    return { ok: false, error: e.message };
  }
}

// =====================================================================
// followups — отложенные сообщения клиентам после сеанса
// =====================================================================

async function addFollowup(chatId, sendAt, message) {
  try {
    await pool.query(
      'INSERT INTO followups (chat_id, send_at, message) VALUES ($1, $2, $3)',
      [chatId, sendAt, message]
    );
    return true;
  } catch (e) {
    console.error('[db] addFollowup ошибка:', e.message);
    return false;
  }
}

async function getDueFollowups() {
  try {
    const res = await pool.query(
      'SELECT id, chat_id, message FROM followups WHERE sent = FALSE AND send_at <= NOW()'
    );
    return res.rows;
  } catch (e) {
    console.error('[db] getDueFollowups ошибка:', e.message);
    return [];
  }
}

async function markFollowupSent(id) {
  try {
    await pool.query('UPDATE followups SET sent = TRUE WHERE id = $1', [id]);
    return true;
  } catch (e) {
    console.error('[db] markFollowupSent ошибка:', e.message);
    return false;
  }
}

// =====================================================================
// pending_reminders — напоминания клиенту, если он замолчал
// =====================================================================

async function scheduleReminder(chatId, reminderType, dueAt, snapshot) {
  try {
    await pool.query(
      'INSERT INTO pending_reminders (chat_id, reminder_type, due_at, snapshot) VALUES ($1, $2, $3, $4)',
      [chatId, reminderType, dueAt, snapshot]
    );
    return true;
  } catch (e) {
    console.error('[db] scheduleReminder ошибка:', e.message);
    return false;
  }
}

async function cancelReminders(chatId) {
  try {
    await pool.query(
      'UPDATE pending_reminders SET sent = TRUE WHERE chat_id = $1 AND sent = FALSE',
      [chatId]
    );
    return true;
  } catch (e) {
    console.error('[db] cancelReminders ошибка:', e.message);
    return false;
  }
}

async function getDueReminders() {
  try {
    const res = await pool.query(
      'SELECT id, chat_id, reminder_type, snapshot FROM pending_reminders WHERE sent = FALSE AND due_at <= NOW()'
    );
    return res.rows;
  } catch (e) {
    console.error('[db] getDueReminders ошибка:', e.message);
    return [];
  }
}

async function markReminderSent(id) {
  try {
    await pool.query('UPDATE pending_reminders SET sent = TRUE WHERE id = $1', [id]);
    return true;
  } catch (e) {
    console.error('[db] markReminderSent ошибка:', e.message);
    return false;
  }
}

// =====================================================================
// client_channels — связь телефона клиента с его чатом (Telegram и т.п.)
// =====================================================================

async function setClientChannel(phone, chatId) {
  try {
    await pool.query(
      `INSERT INTO client_channels (phone, chat_id, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (phone, chat_id) DO UPDATE SET updated_at = NOW()`,
      [phone, chatId]
    );
    return true;
  } catch (e) {
    console.error('[db] setClientChannel ошибка:', e.message);
    return false;
  }
}

async function getClientChannel(phone) {
  try {
    const res = await pool.query(
      'SELECT chat_id FROM client_channels WHERE phone = $1 ORDER BY updated_at DESC LIMIT 1',
      [phone]
    );
    return res.rows[0]?.chat_id ?? null;
  } catch (e) {
    console.error('[db] getClientChannel ошибка:', e.message);
    return null;
  }
}

// Все известные мессенджер-каналы клиента (может быть и Telegram, и MAX)
async function getClientChannels(phone) {
  try {
    const res = await pool.query('SELECT chat_id FROM client_channels WHERE phone = $1', [phone]);
    return res.rows.map(r => r.chat_id);
  } catch (e) {
    console.error('[db] getClientChannels ошибка:', e.message);
    return [];
  }
}

// =====================================================================
// visit_confirmations — напоминания за день до визита и подтверждения
// =====================================================================

async function hasVisitConfirmation(recordId) {
  try {
    const res = await pool.query('SELECT 1 FROM visit_confirmations WHERE record_id = $1', [recordId]);
    return res.rows.length > 0;
  } catch (e) {
    console.error('[db] hasVisitConfirmation ошибка:', e.message);
    return false;
  }
}

async function getVisitConfirmationByRecord(recordId) {
  try {
    const res = await pool.query('SELECT * FROM visit_confirmations WHERE record_id = $1', [recordId]);
    return res.rows[0] || null;
  } catch (e) {
    console.error('[db] getVisitConfirmationByRecord ошибка:', e.message);
    return null;
  }
}

async function addVisitConfirmation(recordId, recordHash, phone, chatId, visitDate, startTime, morningSent = false) {
  try {
    await pool.query(
      `INSERT INTO visit_confirmations (record_id, record_hash, phone, chat_id, visit_date, start_time, morning_sent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [recordId, recordHash, phone, chatId, visitDate, startTime, morningSent]
    );
    return true;
  } catch (e) {
    console.error('[db] addVisitConfirmation ошибка:', e.message);
    return false;
  }
}

// Последнее неподтверждённое напоминание для чата (за последние 36 часов)
async function getPendingConfirmation(chatId) {
  try {
    const res = await pool.query(
      `SELECT id, record_id, record_hash, start_time, visit_date FROM visit_confirmations
       WHERE chat_id = $1 AND confirmed = FALSE AND sent_at >= NOW() - INTERVAL '36 hours'
       ORDER BY id DESC LIMIT 1`,
      [chatId]
    );
    return res.rows[0] || null;
  } catch (e) {
    console.error('[db] getPendingConfirmation ошибка:', e.message);
    return null;
  }
}

async function markVisitConfirmed(id) {
  try {
    await pool.query('UPDATE visit_confirmations SET confirmed = TRUE WHERE id = $1', [id]);
    return true;
  } catch (e) {
    console.error('[db] markVisitConfirmed ошибка:', e.message);
    return false;
  }
}

async function markMorningSent(id) {
  try {
    await pool.query('UPDATE visit_confirmations SET morning_sent = TRUE WHERE id = $1', [id]);
    return true;
  } catch (e) {
    console.error('[db] markMorningSent ошибка:', e.message);
    return false;
  }
}

// Визиты на сегодня, по которым отправлено утреннее напоминание, но нет
// подтверждения и админ ещё не уведомлён — нужно прозвонить клиента
async function getDueEscalations() {
  try {
    const res = await pool.query(
      `SELECT * FROM visit_confirmations
       WHERE visit_date = CURRENT_DATE AND morning_sent = TRUE
         AND confirmed = FALSE AND escalation_notified = FALSE`
    );
    return res.rows;
  } catch (e) {
    console.error('[db] getDueEscalations ошибка:', e.message);
    return [];
  }
}

async function markEscalationNotified(id) {
  try {
    await pool.query('UPDATE visit_confirmations SET escalation_notified = TRUE WHERE id = $1', [id]);
    return true;
  } catch (e) {
    console.error('[db] markEscalationNotified ошибка:', e.message);
    return false;
  }
}

// =====================================================================
// review_followups — запрос отзыва после визита (с периодичностью)
// =====================================================================

async function addReviewFollowup(chatId, phone, recordId, visitDate, dueAt) {
  try {
    await pool.query(
      'INSERT INTO review_followups (chat_id, phone, record_id, visit_date, due_at) VALUES ($1, $2, $3, $4, $5)',
      [chatId, phone, recordId, visitDate, dueAt]
    );
    return true;
  } catch (e) {
    console.error('[db] addReviewFollowup ошибка:', e.message);
    return false;
  }
}

async function getDueReviewFollowups() {
  try {
    const res = await pool.query(
      'SELECT id, chat_id, phone, record_id, visit_date FROM review_followups WHERE sent = FALSE AND due_at <= NOW()'
    );
    return res.rows;
  } catch (e) {
    console.error('[db] getDueReviewFollowups ошибка:', e.message);
    return [];
  }
}

async function markReviewFollowupSent(id) {
  try {
    await pool.query('UPDATE review_followups SET sent = TRUE WHERE id = $1', [id]);
    return true;
  } catch (e) {
    console.error('[db] markReviewFollowupSent ошибка:', e.message);
    return false;
  }
}

// =====================================================================
// social_followups — приглашение в телеграм-канал перед визитом
// =====================================================================

async function addSocialFollowup(chatId, phone, recordId, visitDate, dueAt) {
  try {
    await pool.query(
      'INSERT INTO social_followups (chat_id, phone, record_id, visit_date, due_at) VALUES ($1, $2, $3, $4, $5)',
      [chatId, phone, recordId, visitDate, dueAt]
    );
    return true;
  } catch (e) {
    console.error('[db] addSocialFollowup ошибка:', e.message);
    return false;
  }
}

async function getDueSocialFollowups() {
  try {
    const res = await pool.query(
      'SELECT id, chat_id, phone, record_id, visit_date FROM social_followups WHERE sent = FALSE AND due_at <= NOW()'
    );
    return res.rows;
  } catch (e) {
    console.error('[db] getDueSocialFollowups ошибка:', e.message);
    return [];
  }
}

async function markSocialFollowupSent(id) {
  try {
    await pool.query('UPDATE social_followups SET sent = TRUE WHERE id = $1', [id]);
    return true;
  } catch (e) {
    console.error('[db] markSocialFollowupSent ошибка:', e.message);
    return false;
  }
}

// =====================================================================
// tracked_records — отслеживание записей для уведомления об отмене
// =====================================================================

async function addTrackedRecord(recordId, chatId, visitDate, startTime) {
  try {
    await pool.query(
      `INSERT INTO tracked_records (record_id, chat_id, visit_date, start_time)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (record_id) DO UPDATE SET chat_id = $2, visit_date = $3, start_time = $4`,
      [String(recordId), chatId, visitDate, startTime]
    );
    return true;
  } catch (e) {
    console.error('[db] addTrackedRecord ошибка:', e.message);
    return false;
  }
}

async function hasTrackedRecord(recordId) {
  try {
    const res = await pool.query('SELECT 1 FROM tracked_records WHERE record_id = $1', [String(recordId)]);
    return res.rows.length > 0;
  } catch (e) {
    console.error('[db] hasTrackedRecord ошибка:', e.message);
    return false;
  }
}

async function getActiveTrackedRecords() {
  try {
    const res = await pool.query(
      `SELECT record_id, chat_id, visit_date, start_time FROM tracked_records
       WHERE cancel_notified = FALSE AND visit_date >= CURRENT_DATE`
    );
    return res.rows;
  } catch (e) {
    console.error('[db] getActiveTrackedRecords ошибка:', e.message);
    return [];
  }
}

async function markCancelNotified(recordId) {
  try {
    await pool.query('UPDATE tracked_records SET cancel_notified = TRUE WHERE record_id = $1', [String(recordId)]);
    return true;
  } catch (e) {
    console.error('[db] markCancelNotified ошибка:', e.message);
    return false;
  }
}

// =====================================================================
// touch_chain — цепочка касаний после визита (день 3-5 / 30 / 90)
// =====================================================================

// Запуск/перезапуск цепочки от даты последнего завершённого визита
async function upsertTouchChain(chatId, phone, name, lastVisitDate, dueAt) {
  try {
    await pool.query(
      `INSERT INTO touch_chain (chat_id, phone, name, last_visit_date, next_step, due_at, stopped, updated_at)
       VALUES ($1, $2, $3, $4, 1, $5, FALSE, NOW())
       ON CONFLICT (chat_id) DO UPDATE SET
         phone = $2, name = $3, last_visit_date = $4, next_step = 1, due_at = $5, stopped = FALSE, updated_at = NOW()`,
      [chatId, phone, name, lastVisitDate, dueAt]
    );
    return true;
  } catch (e) {
    console.error('[db] upsertTouchChain ошибка:', e.message);
    return false;
  }
}

async function getDueTouchChains() {
  try {
    const res = await pool.query(
      `SELECT id, chat_id, phone, name, last_visit_date, next_step FROM touch_chain
       WHERE stopped = FALSE AND next_step <= 3 AND due_at <= NOW()`
    );
    return res.rows;
  } catch (e) {
    console.error('[db] getDueTouchChains ошибка:', e.message);
    return [];
  }
}

async function markTouchSent(id, nextStep, dueAt) {
  try {
    await pool.query(
      'UPDATE touch_chain SET next_step = $2, due_at = $3, stopped = $4, updated_at = NOW() WHERE id = $1',
      [id, nextStep, dueAt, nextStep > 3]
    );
    return true;
  } catch (e) {
    console.error('[db] markTouchSent ошибка:', e.message);
    return false;
  }
}

async function stopTouchChain(chatId) {
  try {
    await pool.query('UPDATE touch_chain SET stopped = TRUE, updated_at = NOW() WHERE chat_id = $1', [chatId]);
    return true;
  } catch (e) {
    console.error('[db] stopTouchChain ошибка:', e.message);
    return false;
  }
}

// Клиент снова записался после last_visit_date — стоп-триггер цепочки
async function hasFutureTrackedRecord(chatId, afterDate) {
  try {
    const res = await pool.query(
      `SELECT 1 FROM tracked_records WHERE chat_id = $1 AND visit_date > $2 AND cancel_notified = FALSE LIMIT 1`,
      [chatId, afterDate]
    );
    return res.rows.length > 0;
  } catch (e) {
    console.error('[db] hasFutureTrackedRecord ошибка:', e.message);
    return false;
  }
}

// =====================================================================
// discount_posts — постинг скидочных окон в канал/чат
// =====================================================================

async function addDiscountPost(postDate, postType, staffId, serviceId, slotTime, channelChatId, channelMessageId) {
  try {
    await pool.query(
      `INSERT INTO discount_posts
        (post_date, post_type, staff_id, service_id, slot_time, channel_chat_id, channel_message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [postDate, postType, staffId, serviceId, slotTime, channelChatId, channelMessageId]
    );
    return true;
  } catch (e) {
    console.error('[db] addDiscountPost ошибка:', e.message);
    return false;
  }
}

async function getActiveDiscountPosts(postDate) {
  try {
    const res = await pool.query(
      'SELECT * FROM discount_posts WHERE post_date = $1 AND removed = FALSE',
      [postDate]
    );
    return res.rows;
  } catch (e) {
    console.error('[db] getActiveDiscountPosts ошибка:', e.message);
    return [];
  }
}

async function markDiscountPostRemoved(id) {
  try {
    await pool.query('UPDATE discount_posts SET removed = TRUE WHERE id = $1', [id]);
    return true;
  } catch (e) {
    console.error('[db] markDiscountPostRemoved ошибка:', e.message);
    return false;
  }
}

// =====================================================================
// human_taken_chats — чаты, перехваченные владельцем вручную (Алина молчит)
// =====================================================================

async function setHumanTaken(chatId) {
  try {
    await pool.query(
      `INSERT INTO human_taken_chats (chat_id, taken_at)
       VALUES ($1, NOW())
       ON CONFLICT (chat_id) DO UPDATE SET taken_at = NOW()`,
      [chatId]
    );
    return true;
  } catch (e) {
    console.error('[db] setHumanTaken ошибка:', e.message);
    return false;
  }
}

async function getHumanTaken(chatId) {
  try {
    const res = await pool.query('SELECT taken_at FROM human_taken_chats WHERE chat_id = $1', [chatId]);
    return res.rows[0]?.taken_at ?? null;
  } catch (e) {
    console.error('[db] getHumanTaken ошибка:', e.message);
    return null;
  }
}

async function clearHumanTaken(chatId) {
  try {
    await pool.query('DELETE FROM human_taken_chats WHERE chat_id = $1', [chatId]);
    return true;
  } catch (e) {
    console.error('[db] clearHumanTaken ошибка:', e.message);
    return false;
  }
}

// =====================================================================
// Проверка соединения
// =====================================================================

async function ping() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  initDb,
  getSetting,
  setSetting,
  getAllSettings,
  getPrompt,
  setPrompt,
  getPromptHistory,
  rollbackPrompt,
  addFollowup,
  getDueFollowups,
  markFollowupSent,
  scheduleReminder,
  cancelReminders,
  getDueReminders,
  markReminderSent,
  setClientChannel,
  getClientChannel,
  getClientChannels,
  hasVisitConfirmation,
  getVisitConfirmationByRecord,
  addVisitConfirmation,
  getPendingConfirmation,
  markVisitConfirmed,
  markMorningSent,
  getDueEscalations,
  markEscalationNotified,
  addReviewFollowup,
  getDueReviewFollowups,
  markReviewFollowupSent,
  addSocialFollowup,
  getDueSocialFollowups,
  markSocialFollowupSent,
  addTrackedRecord,
  hasTrackedRecord,
  getActiveTrackedRecords,
  markCancelNotified,
  upsertTouchChain,
  getDueTouchChains,
  markTouchSent,
  stopTouchChain,
  hasFutureTrackedRecord,
  addDiscountPost,
  getActiveDiscountPosts,
  markDiscountPostRemoved,
  setHumanTaken,
  getHumanTaken,
  clearHumanTaken,
  ping,
};
