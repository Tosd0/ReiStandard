import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { deriveUserEncryptionKey, encryptForStorage } from '../src/server/lib/encryption.js';
import { createCloudGuardedAdapter } from '../src/server/lib/cloud-data-guard.js';
import { runScheduledTick } from '../src/server/lib/run-tick.js';
import { processMessagesByUuid } from '../src/server/lib/message-processor.js';
const userId='u',masterKey='task-lifecycle-key',owner={type:'character',id:'one'};
async function setup(){
 const raw=createTestD1();const db=createD1Adapter(raw);await db.initSchema();
 const key=await deriveUserEncryptionKey(userId,masterKey);
 const guarded=createCloudGuardedAdapter(db,{masterKey});
 await guarded.createTask({user_id:userId,uuid:'owned-task',next_send_at:new Date(Date.now()-1000).toISOString(),message_type:'auto',encrypted_payload:await encryptForStorage(JSON.stringify({owner,contactName:'A',messageType:'auto',completePrompt:'hello',apiUrl:'https://model.invalid/v1',apiKey:'secret',primaryModel:'test',recurrenceType:'none'}),key)});
 return {raw,db,guarded};
}
function lifecycle(row){return {status:row.status,retry_count:row.retry_count,next_send_at:row.next_send_at,encrypted_payload:row.encrypted_payload,last_error:row.last_error};}

test('retired tasks are rejected before a scheduler claim or lifecycle update',async()=>{
 const {raw,db,guarded}=await setup();
 try{
  const before=await db.getTaskByUuid('owned-task',userId);
  await db.setCloudOwnerActive(userId,owner,false);
  await runScheduledTick({db:guarded,masterKey,leaseHeartbeatMs:0});
  const after=await db.getTaskByUuid('owned-task',userId);
  assert.deepEqual(lifecycle(after),lifecycle(before));
  assert.equal(raw._raw.prepare('SELECT lease_until FROM scheduled_messages WHERE uuid=?').get('owned-task').lease_until,null);
 }finally{raw.close();}
});

for(const mode of ['scheduled','instant'])test(`${mode} retirement during generation cannot write a late failure/retry state after restore`,async()=>{
 const {raw,db,guarded}=await setup();const original=globalThis.fetch;let atRetirement;
 globalThis.fetch=async()=>{
  await db.setCloudOwnerActive(userId,owner,false);await db.setCloudOwnerActive(userId,owner,true);
  atRetirement=await db.getTaskByUuid('owned-task',userId);
  return {ok:true,json:async()=>({choices:[{message:{content:'late'}}]})};
 };
 try{
  const ctx={db:guarded,masterKey,leaseHeartbeatMs:0};
  if(mode==='scheduled')await runScheduledTick(ctx);
  else await processMessagesByUuid('owned-task',ctx,0,userId,masterKey);
  const after=await db.getTaskByUuid('owned-task',userId);
  assert.ok(atRetirement,'generation was reached');
  assert.ok(after,'revoked task remains for the cleanup operation');
  assert.deepEqual(lifecycle(after),lifecycle(atRetirement));
 }finally{globalThis.fetch=original;raw.close();}
});
