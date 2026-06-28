const { sendMessage, getUpdates, deleteWebhook } = require('./lib/telegramApi');
const { findNearby } = require('./lib/stations');
const { geocodeAddress } = require('./lib/geocode');

if (!process.env.BOT_TOKEN) {
  throw new Error('BOT_TOKEN env var is required');
}

const BTN_NEARBY = '📍 Заправки рядом';
const BTN_BY_ADDRESS = '🏙 Найти по адресу';

// chatId -> 'awaiting_address' | undefined
const chatState = {};

const startKeyboard = {
  keyboard: [[{ text: BTN_NEARBY }], [{ text: BTN_BY_ADDRESS }]],
  resize_keyboard: true,
};

const locationKeyboard = {
  keyboard: [[{ text: 'Отправить мою геолокацию', request_location: true }]],
  resize_keyboard: true,
};

function formatStationsList(stations) {
  if (!stations.length) {
    return 'Заправок рядом не нашлось.';
  }
  return stations
    .map((s, i) => `${i + 1}. ${s.name} — ${s.address} (${s.distanceKm.toFixed(1)} км)`)
    .join('\n');
}

async function findNearbyStations(chatId, lat, lon) {
  await sendMessage(chatId, 'Ищу заправки рядом с вами...', { reply_markup: { remove_keyboard: true } });
  try {
    const stations = await findNearby(lat, lon);
    await sendMessage(chatId, formatStationsList(stations));
  } catch (err) {
    console.error('findNearbyStations error:', err);
    await sendMessage(chatId, 'Не удалось получить список заправок. Попробуйте позже.');
  }
}

async function findStationsByAddress(chatId, address) {
  await sendMessage(chatId, `Ищу заправки по адресу: ${address}`, { reply_markup: { remove_keyboard: true } });
  try {
    const geo = await geocodeAddress(address);
    if (!geo) {
      await sendMessage(chatId, 'Не удалось найти такой адрес. Попробуйте написать точнее.');
      return;
    }
    const stations = await findNearby(geo.lat, geo.lon);
    await sendMessage(chatId, formatStationsList(stations));
  } catch (err) {
    console.error('findStationsByAddress error:', err);
    await sendMessage(chatId, 'Не удалось получить список заправок. Попробуйте позже.');
  }
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const text = (message.text || '').trim();

  if (text === '/start') {
    chatState[chatId] = undefined;
    await sendMessage(
      chatId,
      'Здравствуйте! Я помогу вам узнать актуальную информацию о заправках. Выберите...',
      { reply_markup: startKeyboard },
    );
    return;
  }

  if (message.location) {
    await findNearbyStations(chatId, message.location.latitude, message.location.longitude);
    return;
  }

  if (text === BTN_NEARBY) {
    chatState[chatId] = undefined;
    await sendMessage(
      chatId,
      'Покажу ближайшие заправки — поделитесь своей геопозицией, нажав кнопку ниже. 📍',
      { reply_markup: locationKeyboard },
    );
    return;
  }

  if (text === BTN_BY_ADDRESS) {
    chatState[chatId] = 'awaiting_address';
    await sendMessage(chatId, '✍️ Напишите адрес', { reply_markup: { remove_keyboard: true } });
    return;
  }

  if (chatState[chatId] === 'awaiting_address' && text) {
    chatState[chatId] = undefined;
    await findStationsByAddress(chatId, text);
    return;
  }

  if (text === '/help') {
    await sendMessage(chatId, 'Доступные команды:\n/start — главное меню');
    return;
  }
}

async function run() {
  // Webhook and polling can't be active at the same time on the same bot.
  await deleteWebhook();

  let offset = 0;
  console.log('Bot started (long polling)...');

  while (true) {
    try {
      const updates = await getUpdates(offset);
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) {
          await handleMessage(update.message);
        }
      }
    } catch (err) {
      console.error('Polling error:', err);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

run();
