import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import routes from './routes';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { UPLOADS_DIR } from './config/uploads';

const app = express();

const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:5273';

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(
  cors({
    origin: corsOrigin === '*' ? true : corsOrigin.includes(',') ? corsOrigin.split(',') : corsOrigin,
    credentials: true,
  }),
);
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/', (_req, res) => {
  res.json({ name: 'bornes-factory-api', status: 'alive', timestamp: new Date().toISOString() });
});

// Pieces jointes servies en lecture seule. UPLOADS_DIR pointe vers un
// dossier local persistant (voir config/uploads.ts).
app.use('/uploads', express.static(UPLOADS_DIR, { fallthrough: true, index: false }));

app.use('/api', routes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
