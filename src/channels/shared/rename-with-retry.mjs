import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// Windows may temporarily deny replacement while another process holds the file.
// Keep the original target in place and retry only transient rename errors.
const RETRY_DELAYS_MS = [10, 20, 40, 80];
const TRANSIENT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

export async function renameWithRetry(source, target) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(source, target);
      return;
    } catch (error) {
      if (process.platform !== 'win32' || !TRANSIENT_CODES.has(error?.code) || attempt >= RETRY_DELAYS_MS.length) throw error;
      await delay(RETRY_DELAYS_MS[attempt]);
    }
  }
}
