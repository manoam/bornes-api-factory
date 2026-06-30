import 'dotenv/config';
import app from './app';

const PORT = Number(process.env.PORT) || 3201;

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[bornes-factory] API listening on http://localhost:${PORT}`);
});
