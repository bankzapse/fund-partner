import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ROOT = resolve(__dirname, '../..');
export const PUBLIC_DIR = join(ROOT, 'public');
export const UPLOAD_DIR = process.env.FP_UPLOAD_DIR || join(ROOT, 'uploads');
export const BACKUP_DIR = process.env.FP_BACKUP_DIR || join(ROOT, 'backups');
