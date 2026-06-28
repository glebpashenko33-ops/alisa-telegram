const express = require('express');
const { sendMessage } = require('./lib/telegramApi');

if (!process.env.BOT_TOKEN) {
  throw new Error('BOT_TOKEN env var is required');
}

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;

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

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const update = req.body;
    if (update.message) {
      await handleMessage(update.message);
    }
  } catch (err) {
    console.error('Error handling update:', err);
  }
});

app.get('/', (req, res) => res.send('ok'));

app.listen(PORT, () => {
  console.log(`new-bot listening on port ${PORT}`);
});
