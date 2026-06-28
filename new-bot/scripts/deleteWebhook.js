const { deleteWebhook } = require('../lib/telegramApi');

deleteWebhook()
  .then(() => console.log('Webhook deleted'))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
