import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { deriveUserEncryptionKey, decryptFromStorage } from '../src/server/lib/encryption.js';
import { cloudInventory, makeCleanupPlan, startCleanup, readCloudRecord, resumeCloudDataCleanups } from '../src/server/lib/cloud-data-cleanup.js';
const masterKey = 'cleanup-integrity-key';
async function setup(count = 1) {
  const raw = createTestD1(); const db = createD1Adapter(raw); await db.initSchema();
  const key = await deriveUserEncryptionKey('u', masterKey); const ctx = { db, masterKey };
  await db.upsertClientState('u', Array.from({length:count}, (_,i) => ({ namespace:'n', key:String(i), value:`secret-original-${i}`, updatedAt:1 })));
  const inventory = await cloudInventory(ctx, db, 'u', key);
  const plan = await makeCleanupPlan(ctx,db,'u',key,{ mode:'purge',resourceIds:inventory.entries.map(e=>e.resource.id) });
  return {raw,db,key,ctx,plan};
}

test('completed cleanup erases consumed plan and private resource snapshots but keeps retry identity', async () => {
  const {raw,db,key,ctx,plan}=await setup();
  try {
    const op=await startCleanup(ctx,db,'u',key,{planId:plan.id,idempotencyKey:'once'});
    assert.equal(op.status,'completed');
    assert.equal(await db.getCloudDataRecord('u','plan',plan.id),null);
    const saved=await readCloudRecord(db,'u',key,'operation',op.id);
    assert.deepEqual(saved.entries,[]);
    assert.ok(!JSON.stringify(saved).includes('secret-original'));
    assert.equal((await startCleanup(ctx,db,'u',key,{planId:plan.id,idempotencyKey:'once'})).id,op.id);
  } finally {raw.close();}
});

test('partial failure saves accurate remaining count and discards already deleted bytes', async () => {
  const {raw,db,key,ctx,plan}=await setup(2);
  const original=db.deleteCloudResourceRows.bind(db);let calls=0;
  db.deleteCloudResourceRows=async (...args)=>{if(++calls===2)throw new Error('temporary');return original(...args);};
  try {
    const op=await startCleanup(ctx,db,'u',key,{planId:plan.id,idempotencyKey:'partial'});
    assert.equal(op.status,'pending');
    assert.deepEqual(op.counts.find(c=>c.type==='state'),{type:'state',deleted:1,remaining:1,failed:0});
    const saved=await readCloudRecord(db,'u',key,'operation',op.id);
    assert.equal(saved.entries[0].locator,undefined);
    assert.equal(saved.entries[1].locator,undefined);
    assert.ok(saved.entries[1].version);
  } finally {raw.close();}
});

test('recreated purge resource fails the old operation instead of looping or deleting the new content', async () => {
  const {raw,db,key,ctx,plan}=await setup();
  const original=db.deleteCloudResourceRows.bind(db);
  db.deleteCloudResourceRows=async (...args)=>{const result=await original(...args);await db.upsertClientState('u',[{namespace:'n',key:'0',value:'new content',updatedAt:2}]);return result;};
  try {
    const op=await startCleanup(ctx,db,'u',key,{planId:plan.id,idempotencyKey:'recreated'});
    assert.equal(op.status,'failed');
    assert.equal(op.errors[0].code,'CLOUD_PLAN_CHANGED');
    assert.equal((await db.getClientState('u','n'))[0].value,'new content');
  } finally {raw.close();}
});

test('idempotency conflict found only at insertion never executes another plan', async () => {
  const {raw,db,key,ctx,plan}=await setup(2);
  try {
    const inventory=await cloudInventory(ctx,db,'u',key);
    const first=await makeCleanupPlan(ctx,db,'u',key,{mode:'purge',resourceIds:[inventory.entries[0].resource.id]});
    await startCleanup(ctx,db,'u',key,{planId:first.id,idempotencyKey:'same'});
    const second=await makeCleanupPlan(ctx,db,'u',key,{mode:'purge',resourceIds:[inventory.entries[1].resource.id]});
    db.listCloudDataRecords=async()=>[]; // Reproduce the pre-insert view before the other request won.
    await assert.rejects(startCleanup(ctx,db,'u',key,{planId:second.id,idempotencyKey:'same'}),{code:'IDEMPOTENCY_CONFLICT'});
    assert.equal((await db.getClientState('u','n')).length,1);
  } finally {raw.close();}
});

test('one corrupt operation cannot block unrelated pending cleanup jobs in cron', async () => {
  const {raw,db,key,ctx,plan}=await setup(26);
  try {
    const op=await startCleanup(ctx,db,'u',key,{planId:plan.id,idempotencyKey:'many'});
    assert.equal(op.status,'pending');
    await db.putCloudDataRecord('u','operation','corrupt','not-ciphertext');
    const records=await db.listCloudDataRecordsAcrossUsers('operation');
    db.listCloudDataRecordsAcrossUsers=async()=>records.sort((a,b)=>a.id==='corrupt'?-1:b.id==='corrupt'?1:0);
    await resumeCloudDataCleanups(ctx);
    assert.equal((await readCloudRecord(db,'u',key,'operation',op.id)).status,'completed');
  } finally {raw.close();}
});

test('retirement remembers legacy outbox ownership after deleting its source task between batches', async () => {
  const {raw,db,key,ctx}=await setup();
  const {encryptForStorage}=await import('../src/server/lib/encryption.js');
  const owner={type:'character',id:'legacy'};
  ctx.cloudData={resolveOwner:({payload,task})=>payload?.owner||task?.owner?{owner:payload?.owner||task?.owner}:null};
  try {
    await db.createTask({user_id:'u',uuid:'source-task',encrypted_payload:await encryptForStorage(JSON.stringify({owner}),key),next_send_at:'2020-01-01',message_type:'fixed'});
    await db.appendOutboxMessages('u',await Promise.all(Array.from({length:30},async(_,i)=>({message_id:`legacy-${i}`,task_uuid:'source-task',payload:await encryptForStorage(JSON.stringify({message:'secret'}),key),created_at:1}))));
    const plan=await makeCleanupPlan(ctx,db,'u',key,{mode:'retire-owner',owner});
    const original=db.deleteCloudResourceRows.bind(db);
    db.deleteCloudResourceRows=async(...args)=>{const result=await original(...args);await db.deleteTaskByUuid('source-task','u');return result;};
    const op=await startCleanup(ctx,db,'u',key,{planId:plan.id,idempotencyKey:'legacy'});
    assert.equal(op.status,'pending');
    await resumeCloudDataCleanups(ctx);
    assert.equal((await readCloudRecord(db,'u',key,'operation',op.id)).status,'completed');
    assert.equal((await db.listCloudResourceRows('u')).outbox.length,0);
    assert.equal((await db.getClientState('u','n')).length,1);
  }finally{raw.close();}
});
