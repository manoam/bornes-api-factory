import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { randomUUID } from 'crypto';

/**
 * Config des pieces jointes Factory (V2 Repair).
 *
 * Stockage disque local. Le dossier UPLOADS_DIR doit etre persistant
 * en prod (volume Coolify ou bind mount). En dev, le dossier local
 * `uploads/` est cree si absent.
 *
 * Env :
 *   UPLOADS_DIR    - chemin absolu du dossier racine (default: <cwd>/uploads)
 *   MAX_UPLOAD_MB  - taille max par fichier en MB (default: 10)
 */

export const UPLOADS_DIR =
  process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads');

const MAX_MB = Number(process.env.MAX_UPLOAD_MB || 10);
const MAX_BYTES = Math.max(1, MAX_MB) * 1024 * 1024;

// Types autorises. On reste strict — pas de vrais fichiers arbitraires.
// PDF pour les factures, images pour les photos de composants HS.
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
]);

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** Multer pour /repair-orders/:id/attachments. Enregistre sous uploads/repairs/. */
export function repairAttachmentsMulter() {
  const dir = path.join(UPLOADS_DIR, 'repairs');
  ensureDir(dir);

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, dir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().slice(0, 10);
      const safeExt = /^\.[a-z0-9]+$/.test(ext) ? ext : '';
      cb(null, `${randomUUID()}${safeExt}`);
    },
  });

  return multer({
    storage,
    limits: { fileSize: MAX_BYTES, files: 1 },
    fileFilter: (_req, file, cb) => {
      if (!ALLOWED_MIME.has(file.mimetype)) {
        cb(new Error(`Type de fichier non autorise: ${file.mimetype}`));
        return;
      }
      cb(null, true);
    },
  });
}

/** Chemin public relatif (a stocker en DB, servi par /uploads/*). */
export function relativeUploadUrl(fullPath: string): string {
  const rel = path.relative(UPLOADS_DIR, fullPath).replace(/\\/g, '/');
  return `/uploads/${rel}`;
}

/** Reciproque : chemin disque a partir de l'URL relative. */
export function fullUploadPath(relUrl: string): string {
  // On accepte "/uploads/..." ou "uploads/...".
  const clean = relUrl.replace(/^\/?uploads\/?/, '');
  return path.join(UPLOADS_DIR, clean);
}
