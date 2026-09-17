import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import test from 'node:test';
import {runRequirementsHook} from '../dist/requirements_hook.js';
import {acknowledgeRequirements, readRequirementSession} from '../dist/requirements_session.js';
import {readRequirements, updateRequirements} from '../dist/requirements.js';

const content = '# Requirements\n\n## Hosting MFA\n- Scope: Hosting customer and administrator workflows.\n- Source: User, task example, 2026-09-17.\n- Decision: Do not enable or require MFA unless the user explicitly changes this direction.\n';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'orchestration-hooks-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const cwd=join(root,'project'); await mkdir(cwd);
  await writeFile(join(cwd,'REQUIREMENTS.md'),content);
  return {root,cwd,input:{session_id:'test-session',cwd,turn_id:'turn-one',permission_mode:'default'}};
}
test('fresh, resumed, compacted and subagent contexts contain the MFA prohibition',async t=>{
  const {root,input}=await fixture(t);
  for(const event of ['SessionStart','SubagentStart']) for(const source of ['startup','resume','compact']) {
    const result=await runRequirementsHook({...input,hook_event_name:event,source},root);
    assert.match(result.hookSpecificOutput.additionalContext,/Do not enable or require MFA/);
  }
});
test('stale ordinary task is blocked before its pending tool, then receives current requirements',async t=>{
  const {root,cwd,input}=await fixture(t);
  await runRequirementsHook({...input,hook_event_name:'SessionStart'},root);
  const old=await readRequirements(cwd,{testRoot:root});
  await updateRequirements(cwd,{expected_fingerprint:old.fingerprint,content:content.replace('Do not enable or require MFA','MFA stays disabled')},{testRoot:root});
  const blocked=await runRequirementsHook({...input,hook_event_name:'PreToolUse',tool_name:'Bash'},root);
  assert.equal(blocked.hookSpecificOutput.permissionDecision,'deny');
  assert.match(blocked.hookSpecificOutput.permissionDecisionReason,/MFA stays disabled/);
  assert.deepEqual(await runRequirementsHook({...input,hook_event_name:'PreToolUse',tool_name:'Bash'},root),{});
});
test('managed assignment prompts stay read-only while current requirements still guard tools',async t=>{
  const {root,cwd,input}=await fixture(t);
  const env={SYMPHONY_MANAGED_WORKER:'1'};
  const submitted=await runRequirementsHook({...input,hook_event_name:'UserPromptSubmit',prompt:'Implement assigned hardening'},root,env);
  assert.match(submitted.hookSpecificOutput.additionalContext,/Do not update requirements/);
  assert.equal((await readRequirementSession(input.session_id,root)).pendingTurn,undefined);
  assert.deepEqual(await runRequirementsHook({...input,hook_event_name:'Stop'},root,env),{});
  const old=await readRequirements(cwd,{testRoot:root});
  await updateRequirements(cwd,{expected_fingerprint:old.fingerprint,content:content.replace('Do not enable or require MFA','MFA stays disabled')},{testRoot:root});
  const blocked=await runRequirementsHook({...input,hook_event_name:'PreToolUse',tool_name:'Bash'},root,env);
  assert.equal(blocked.hookSpecificOutput.permissionDecision,'deny');
  assert.match(blocked.hookSpecificOutput.permissionDecisionReason,/MFA stays disabled/);
});
test('capture checkpoint keeps original turn through generated reminder and compaction',async t=>{
  const {root,cwd,input}=await fixture(t);
  await runRequirementsHook({...input,hook_event_name:'UserPromptSubmit',prompt:'Harden hosting'},root);
  const stop=await runRequirementsHook({...input,hook_event_name:'Stop'},root);
  assert.equal(stop.decision,'block');
  await runRequirementsHook({...input,turn_id:'generated-turn',hook_event_name:'UserPromptSubmit',prompt:stop.reason},root);
  await runRequirementsHook({...input,hook_event_name:'SessionStart',source:'compact'},root);
  assert.equal((await readRequirementSession(input.session_id,root)).pendingTurn,input.turn_id);
  const current=await readRequirements(cwd,{testRoot:root});
  await assert.rejects(()=>acknowledgeRequirements(input.session_id,{cwd,turn_id:'wrong',fingerprint:current.fingerprint,outcome:'unchanged'},root),{code:'requirements_turn_mismatch'});
  await acknowledgeRequirements(input.session_id,{cwd,turn_id:input.turn_id,fingerprint:current.fingerprint,outcome:'unchanged'},root);
  assert.deepEqual(await runRequirementsHook({...input,hook_event_name:'Stop'},root),{});
});
test('plan mode does not demand a persistence write; failed capture cannot loop',async t=>{
  const {root,input}=await fixture(t);
  await runRequirementsHook({...input,permission_mode:'plan',hook_event_name:'UserPromptSubmit'},root);
  assert.deepEqual(await runRequirementsHook({...input,permission_mode:'plan',hook_event_name:'Stop'},root),{});
  await runRequirementsHook({...input,hook_event_name:'UserPromptSubmit'},root);
  assert.match((await runRequirementsHook({...input,hook_event_name:'Stop',stop_hook_active:true},root)).systemMessage,/incomplete/);
});
test('missing configured requirements is visible and blocks a supported tool',async t=>{
  const {root,cwd,input}=await fixture(t);
  await mkdir(join(root,'config'),{recursive:true});
  await writeFile(join(root,'config','requirements.json'),JSON.stringify({version:1,roots:{[cwd]:join(root,'missing')}}));
  const failed=await runRequirementsHook({...input,hook_event_name:'PreToolUse',tool_name:'Bash'},root);
  assert.equal(failed.hookSpecificOutput.permissionDecision,'deny');
  assert.match(failed.hookSpecificOutput.permissionDecisionReason,/could not be loaded/);
});
test('packaged hook executes as a real process from a path containing spaces without Symphony',async t=>{
  const {root,cwd,input}=await fixture(t);
  const hook=join(process.cwd(),'mcp','requirements-hook.mjs');
  const config=JSON.parse(await readFile(join(process.cwd(),'hooks','hooks.json'),'utf8'));
  const command=config.hooks.SessionStart[0].hooks[0].command;
  // Execute exactly the bundled node -e payload; its environment lookup avoids shell-specific expansion.
  assert.ok(command.startsWith('node -e "'));
  const child=spawn(process.execPath,['-e',command.slice(9,-1)],{cwd,env:{...process.env,PLUGIN_ROOT:process.cwd(),LOCALAPPDATA:root},windowsHide:true});
  let stdout='',stderr=''; child.stdout.on('data',c=>stdout+=c); child.stderr.on('data',c=>stderr+=c);
  child.stdin.end(JSON.stringify({...input,hook_event_name:'SessionStart'}));
  const exit=await new Promise(resolve=>child.on('exit',resolve));
  assert.equal(exit,0,stderr); assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext,/Do not enable or require MFA/);
});
