import 'dotenv/config';
import { createApp } from './app';
import { config } from './config/env';
import { logger } from './config/logger';

async function main() {
  const app = createApp();

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
