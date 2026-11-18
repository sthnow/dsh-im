# Candidate HFC display boundary

This candidate vendors the unmodified transitive relative-import closure of HFC
v5.0.25 `events`, `session`, and `render` (23 modules). `assets/hfc/upstream/MANIFEST.json`
records SHA-256 for every vendored file, including the MIT license. No HFC server,
config loader, execution registry, bot setup, or network client is imported.

The bridge supplies an explicit Python executable. Each turn owns one `HfcWorker`,
started with `-I -S -B`, minimal credential-free environment and bounded JSONL.
Source imports locate `../../../../assets/hfc/worker.py`; bundled `lib/index.js`
locates `../assets/hfc/worker.py`. Runtime needs Python 3.10+ with standard library.

`DshHfcAdapter` takes a complete six-field trusted route and a DSH sink with strict
`create`, `patch`, and `native(text)` methods. Receipts need a nonempty message ID;
partial, unknown, failed, cancelled or incomplete receipts are not success. A
patch failure must not be implemented as a new create. One terminal attempt is
allowed. Native delivery uses the complete DSH finish text (not v5.0.25's empty
`primary_text`). No old delivery-chain fallback may also send it. Delivery error
or unknown outcome permanently prevents automatic re-send. Renderer or budget
failure can instead hand complete terminal text to that same owner's native sink.

Supported upstream dispositions: `card`, `deferred_native`, and terminal `native`.
Deferred only updates the placeholder; no early native body. Segmented output is
explicitly rejected; this candidate does not silently ignore continuation cards.
Draft text/reasoning patches coalesce within 500ms, with no timer or orphan job;
interaction and terminal events always flush. Records, pending queue, replay work,
input/output and interaction entry count are bounded. Hard failures poison worker
state; no same-turn automatic respawn.

Card values are display output, never authority. Six route fields must match the
trusted transport actor. Empty values are allowed only on exact currently-rendered
native form names/tokens; an explicit wrong profile is rejected. Execution uses
the existing DSH approval queue / original question respond closure. Successful
RPC consumption is committed before display I/O; stale cards cannot resubmit it.

Focused tests: `DSH_HFC_TEST_PYTHON=<python> node --test test/channels/feishu/hfc-adapter.test.mjs`.
Tests skip actual Python cases only when that explicit test environment variable is
absent. No bot or network service is started by this test suite.
