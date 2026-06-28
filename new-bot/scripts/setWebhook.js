const { setWebhook } = require('../lib/telegramApi');

const url = process.env.WEBHOOK_URL;
if (!url) {
  throw new Error('WEBHOOK_URL env var is required, e.g. https://your-domain.com/webhook');
}

setWebhook(url)
  .then(() => console.log(`Webhook set to ${url}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
