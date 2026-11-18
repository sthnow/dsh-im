import { HfcWorker } from './hfc/worker-client.mjs';

// Legacy per-bot trial selection. Explicit UI selections supersede this override.
// Never discover Python through PATH or silently change the configured executable.
export async function assertHfcPresentationReady(value) {
  const { python } = normalizeHfcPresentation(value);
  if (!python) throw Object.assign(new Error('HFC requires an explicitly configured Python executable (hfcPresentation.python).'), { code: 'hfc-python-required' });
  const worker = new HfcWorker({ python, timeoutMs: 5_000 });
  try {
    await worker.reset();
  } catch {
    throw Object.assign(new Error('HFC Python renderer is unavailable; verify hfcPresentation.python (Python 3.10+). Settings were not saved.'), { code: 'hfc-python-unavailable' });
  } finally {
    await worker.close().catch(() => {
      throw Object.assign(new Error('HFC Python renderer could not close safely. Settings were not saved.'), { code: 'hfc-python-unavailable' });
    });
  }
}
export function normalizeHfcPresentation(value) {
  const ids = Array.isArray(value?.testSessionIds)
    ? [...new Set(value.testSessionIds.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 256 && id.trim() === id))].slice(0, 32)
    : [];
  const python = typeof value?.python === 'string' && value.python.trim() ? value.python.trim() : null;
  return Object.freeze({
    backend: value?.backend === 'hfc' ? 'hfc' : 'legacy',
    testSessionIds: Object.freeze(ids),
    python,
  });
}
