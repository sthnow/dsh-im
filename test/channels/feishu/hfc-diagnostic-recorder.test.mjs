import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHfcDiagnosticRecorder} from '../../../plugin-src/host/channels/feishu/hfc-diagnostic-recorder.mjs';
test('bounded HFC file serializes, caps and sanitizes previous and current diagnostics',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'hfc-safe-diag-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=join(dir,'hfc-diagnostics.json');await writeFile(file,JSON.stringify([{stage:'identity',code:'PRIVATE_SECRET',extra:'SECRET',at:'PRIVATE'}]));
 const record=createHfcDiagnosticRecorder(file,{limit:4});
 await Promise.all(Array.from({length:10},()=>record('card.patch',Object.assign(Error('PRIVATE_PROMPT'),{providerCode:230099}),{scope:'runtime',source:'runtime-random',code:'ready',runtimeNamespace:'SECRET_NAMESPACE'})));
 const text=await readFile(file,'utf8');assert.doesNotMatch(text,/PRIVATE|SECRET/);const rows=JSON.parse(text);assert.equal(rows.length,4);assert.equal(rows[3].providerCode,'230099');
});
test('diagnostic IO failure is swallowed instead of changing delivery',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'hfc-safe-diag-fail-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const blocker=join(dir,'file');await writeFile(blocker,'x');const record=createHfcDiagnosticRecorder(join(blocker,'impossible.json'));
 await assert.doesNotReject(record('identity',{code:'HFC_RUNTIME_NAMESPACE_UNAVAILABLE'}));
});
