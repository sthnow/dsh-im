// Public display-route partition only: never a profile, credential or authority.
// Production creates a fresh UUID v4 for every createRuntime invocation.
export function normalizeHfcRuntimeNamespace(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value : null;
}

export function hfcRuntimeNamespaceFacts(value) {
  return Object.freeze({ scope: 'runtime', source: 'runtime-random',
    code: normalizeHfcRuntimeNamespace(value) ? 'ready' : 'unavailable' });
}
