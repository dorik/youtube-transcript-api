import 'dotenv/config';
import { createApp } from './app';
import { config } from './config/env';
import { logger } from './config/logger';
import { startWorker } from './queue/worker';

async function main() {
  const app = createApp();

  // The BullMQ worker runs in this same process (see design doc — Render's
  // free tier has no separate worker service). Started before listen() so a
  // boot-time queue failure surfaces immediately.
  await startWorker();

  app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, env: config.NODE_ENV },
      `Server listening on http://localhost:${config.PORT}`,
    );
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', err);
  process.exit(1);
});
