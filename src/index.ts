import 'dotenv/config';
import app from './app';
import rabbitmq from './services/rabbitmq';

const PORT = Number(process.env.PORT) || 3201;

async function main() {
  // RabbitMQ is optional. If RABBITMQ_URL isn't set, or if the broker isn't
  // reachable, Factory still starts and serves requests — events just aren't
  // published. Same pattern as Stock.
  try {
    await rabbitmq.connect();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      '[RabbitMQ] Not available, continuing without event bus:',
      message,
    );
  }

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[bornes-factory] API listening on http://localhost:${PORT}`);
  });
}

// Graceful shutdown — flush in-flight publishes before exit.
process.on('SIGINT', async () => {
  await rabbitmq.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await rabbitmq.close();
  process.exit(0);
});

main().catch((err) => {
  console.error('=== STARTUP ERROR ===');
  console.error(err);
  process.exit(1);
});
