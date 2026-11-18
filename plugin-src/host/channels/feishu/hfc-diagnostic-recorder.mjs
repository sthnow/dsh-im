import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { hfcDiagnosticFacts } from '../../../../src/channels/feishu/hfc-diagnostics.mjs';
// A capped diagnostic file, separate from bot state. It cannot carry conversation data.
export function createHfcDiagnosticRecorder(path, { limit = 64 } = {}) {
  let queue = Promise.resolve();
  const cap = Math.min(64, Math.max(1, Number.isSafeInteger(limit) ? limit : 64));
  return function record(stage, error, identity) {
    const row = { at: new Date().toISOString(), ...hfcDiagnosticFacts(stage, error, identity) };
    queue = queue.catch(() => {}).then(async () => {
      let rows = [];
      try {
        const bytes = await readFile(path);
        if (bytes.length <= 65536) {
          const parsed = JSON.parse(bytes);
          if (Array.isArray(parsed)) rows = parsed.slice(-cap + 1).filter(r => r && typeof r === 'object').map(r => ({
            ...(typeof r.at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(r.at) ? { at:r.at } : {}),
            ...hfcDiagnosticFacts(r.stage, { code:r.code, providerCode:r.providerCode, status:r.httpStatus }, { scope:r.namespaceScope, source:r.namespaceSource, code:r.namespaceCode }),
          }));
        }
      } catch {}
      await mkdir(dirname(path), { recursive:true });
      const temp = `${path}.tmp`;
      await writeFile(temp, JSON.stringify([...rows, row].slice(-cap), null, 2), { mode:0o600 });
      await rename(temp, path);
    }).catch(() => {}); // Diagnostics must never change message or delivery semantics.
    return queue;
  };
}
