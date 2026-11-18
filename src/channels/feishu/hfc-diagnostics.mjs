// HFC-local, allowlisted facts only. Never log cards, prompts, provider text or stacks.
const STAGES = new Set(['runtime.start', 'identity', 'prompt.prepare', 'ask', 'card.reply', 'card.patch', 'native', 'worker', 'finish']);
const CODES = new Set(['hfc-runtime-start', 'HFC_RUNTIME_NAMESPACE_UNAVAILABLE', 'HFC_IDENTITY_UNAVAILABLE', 'HFC_TURN_NOT_STARTED', 'channel-delivery-failed', 'channel-delivery-uncertain', 'worker-exited', 'worker-timeout', 'worker-protocol-error', 'profile-conflict', 'unknown-profile', 'profile-service-unavailable']);
export function hfcProviderError(response) {
  const error = new Error('HFC provider rejected card operation');
  error.code = 'channel-delivery-failed';
  const code = String(response?.code ?? '');
  if (/^-?\d{1,12}$/.test(code)) error.providerCode = code;
  error.details = { reason: 'provider-rejected', stage: 'message.send', ...(error.providerCode ? { providerCode: error.providerCode } : {}) };
  return error;
}
export function hfcDiagnosticFacts(stage, error, identity) {
  const numeric = value => /^-?\d{1,12}$/.test(String(value ?? '')) ? String(value) : undefined;
  const facts = { stage: STAGES.has(stage) ? stage : 'ask', code: CODES.has(error?.code) ? error.code : 'hfc-operation-failed' };
  const providerCode = numeric(error?.providerCode ?? error?.response?.data?.code);
  if (providerCode) facts.providerCode = providerCode;
  const status = error?.response?.status ?? error?.status;
  if (Number.isInteger(status) && status >= 100 && status <= 599) facts.httpStatus = status;
  if (identity?.scope === 'runtime') facts.namespaceScope = 'runtime';
  if (identity?.source === 'runtime-random') facts.namespaceSource = 'runtime-random';
  if (['ready', 'unavailable'].includes(identity?.code)) facts.namespaceCode = identity.code;
  return Object.freeze(facts);
}
// Local persistence is best-effort: a stalled recorder must never hold turn cleanup.
export async function recordHfcDiagnostic({ stage, error, identity, logger, record }) {
  const facts = hfcDiagnosticFacts(stage, error, identity);
  try { logger?.warn?.('[dsh-feishu-hfc]', JSON.stringify(facts)); } catch {}
  if (typeof record !== 'function') return;
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => record(facts.stage,
        { code: facts.code, providerCode: facts.providerCode, status: facts.httpStatus },
        { scope: facts.namespaceScope, source: facts.namespaceSource, code: facts.namespaceCode })),
      new Promise(resolve => { timer = setTimeout(resolve, 250); }),
    ]);
  } catch {} finally { clearTimeout(timer); }
}

export function hfcIdentityError(namespaceMissing) {
  const error = new Error(namespaceMissing ? 'HFC runtime namespace unavailable' : 'HFC trusted identity unavailable');
  error.code = namespaceMissing ? 'HFC_RUNTIME_NAMESPACE_UNAVAILABLE' : 'HFC_IDENTITY_UNAVAILABLE';
  error.details = { reason: 'invalid-config', stage: 'runtime.prepare', submissionState: 'not-submitted' };
  return error;
}
