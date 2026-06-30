import 'dotenv/config';
import app from './app';
import { initRabbitMQ } from './services/rabbitmqHttp';
import { startRefSync } from './services/refSync';

const PORT = Number(process.env.PORT) || 3201;

async function main() {
  // RabbitMQ + refSync sont best-effort. Si l'infra n'est pas dispo,
  // Factory démarre quand même — seul l'affichage des avatars opérateurs
  // sera dégradé jusqu'à ce que la sync rattrape.
  try {
    await initRabbitMQ();
    await startRefSync();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[RabbitMQ] init/refSync failed, continuing:', message);
  }

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[bornes-factory] API listening on http://localhost:${PORT}`);
  });
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch((err) => {
  console.error('=== STARTUP ERROR ===');
  console.error(err);
  process.exit(1);
});
