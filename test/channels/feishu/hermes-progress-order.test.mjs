import test from 'node:test';
import assert from 'node:assert/strict';
import { HermesCardProgress } from '../../../src/channels/feishu/hermes-progress.mjs';

const flatten = p => p.blocks().flatMap(b => b.lines.map(line => [b.kind, line]));

test('process entries follow newest observed update across kinds', () => {
  const p = new HermesCardProgress();
  p.consume({ type: 'reasoning', step: 0, text: 'think A' });
  p.consume({ type: 'text', step: 0, text: 'note A' });
  p.consume({ type: 'tool', callId: 'a', name: 'tool A' });
  p.consume({ type: 'reasoning', step: 1, text: 'think B' });
  assert.deepEqual(flatten(p).map(([kind]) => kind), ['reasoning', 'tools', 'notes', 'reasoning']);
  p.consume({ type: 'tool-result', callId: 'a', isError: true, error: 'failure' });
  assert.match(flatten(p)[0][1], /❌ tool A[\s\S]*failure/);
  assert.deepEqual(flatten(p).map(([kind]) => kind), ['tools', 'reasoning', 'notes', 'reasoning']);
  p.finish('stopped');
  assert.equal(p.status, 'stopped');
  assert.match(flatten(p)[0][1], /❌/);
});

test('archiving preserves draft event order; late note correction and retraction stay aligned', () => {
  const p = new HermesCardProgress();
  p.consume({ type: 'text', step: 1, text: 'draft' });
  p.consume({ type: 'reasoning', step: 1, text: 'thinking after draft' });
  p.consume({ type: 'tool', callId: 'x', name: 'read' });
  p.consume({ type: 'text', step: 2, text: 'new draft' });
  assert.deepEqual(flatten(p).map(([kind]) => kind), ['tools', 'reasoning', 'notes']);
  p.consume({ type: 'assistant-message', step: 1, text: 'corrected' });
  assert.deepEqual(flatten(p)[0], ['notes', 'corrected']);
  p.consume({ type: 'text', step: 1, text: '' });
  assert.ok(!flatten(p).some(([kind]) => kind === 'notes'));
  assert.equal(p.draft, 'new draft');
});

test('oversized newest entry remains visible and reports older omitted entries', () => {
  const p = new HermesCardProgress();
  p.consume({ type: 'tool', callId: 'old', name: 'old tool' });
  p.consume({ type: 'tool', callId: 'big', name: '😀'.repeat(3000) });
  const block = p.blocks().find(b => b.kind === 'tools');
  assert.equal(block.omitted, 1);
  assert.equal(block.lines.length, 1);
  assert.match(block.lines[0], /^⏳ .*…$/u);
  assert.ok(Buffer.byteLength(JSON.stringify(block.lines[0]), 'utf8') <= 6000);
  assert.equal(p.tools.get('big').name, '😀'.repeat(3000));
});
