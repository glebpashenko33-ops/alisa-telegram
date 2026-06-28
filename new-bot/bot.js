const { sendMessage, getUpdates, deleteWebhook } = require('./lib/telegramApi');

if (!process.env.BOT_TOKEN) {
  throw new Error('BOT_TOKEN env var is required');
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const text = (message.text || '').trim();

  if (text === '/start') {
    await sendMessage(chatId, 'Привет! Бот запущен и готов к работе.');
    return;
  }

  if (text === '/help') {
    await sendMessage(chatId, 'Доступные команды:\n/start — приветствие\n/help — список команд');
    return;
  }

  if (text) {
    await sendMessage(chatId, `Вы написали: ${text}`);
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
