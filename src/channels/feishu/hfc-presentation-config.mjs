// Explicit, per-bot trial selection. No environment opt-in and no automatic migration.
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
