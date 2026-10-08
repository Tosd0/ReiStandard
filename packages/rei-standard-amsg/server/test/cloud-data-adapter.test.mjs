import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';

async function fresh() { const raw = createTestD1(); const db = createD1Adapter(raw); await db.initSchema(); return { db, raw }; }
const owner = {type:'character',id:'one'};
const task = (uuid, user_id = 'u') => ({user_id,uuid,encrypted_payload:'secret',next_send_at:'2020-01-01',message_type:'fixed'});

test('cloud inventory reads all 201 state namespaces and acked outbox while isolating users', async () => {
 const {db} = await fresh();
 await db.upsertClientState('u', Array.from({length:201}, (_,i)=>({namespace:`n${i}`,key:'a',value:'ciphertext',updatedAt:1})));
 await db.upsertClientState('other', [{namespace:'foreign',key:'a',value:'foreign',updatedAt:1}]);
 await db.appendOutboxMessages('u',[{message_id:'m',payload:'ciphertext',created_at:1}]);
 await db.ackOutboxMessages('u',['m'],2);
 const rows = await db.listCloudResourceRows('u');
 assert.equal(rows.state.length,201); assert.equal(rows.outbox[0].acked_at,2); assert.equal(rows.gaps.length,0);
});

test('cloud persisted operations are user-scoped and idempotency keys recover original operation', async () => {
 const {db} = await fresh();
 await db.putCloudDataRecord('u','operation','one','encrypted1',{idempotencyKey:'same',createOnly:true});
 const second = await db.putCloudDataRecord('u','operation','two','encrypted2',{idempotencyKey:'same',createOnly:true});
 assert.equal(second.id,'one'); assert.equal(second.data,'encrypted1');
 assert.equal(await db.getCloudDataRecord('other','operation','one'),null);
 assert.equal((await db.listCloudDataRecordsAcrossUsers('operation')).length,1);
});

test('retired owner blocks task/state/credential/outbox writes atomically; restoring rejects old generation', async () => {
 const {db} = await fresh();
 const guard = {owner,generation:0};
 await db.createTask(task('before'),guard);
 const retired = await db.setCloudOwnerActive('u',owner,false);
 assert.equal(retired.generation,1); assert.equal(retired.active,false);
 await assert.rejects(db.createTask(task('after'),guard), /owner/i);
 await assert.rejects(db.upsertClientState('u',[{namespace:'n',key:'k',value:'x',updatedAt:1}],[],Date.now(),guard), /owner/i);
 await assert.rejects(db.upsertLlmCredentials('u',[{credId:'c',encryptedValue:'x'}],guard), /owner/i);
 await assert.rejects(db.appendOutboxMessages('u',[{message_id:'m',payload:'x',created_at:1}],guard), /owner/i);
 const restored = await db.setCloudOwnerActive('u',owner,true);
 await assert.rejects(db.createTask(task('stale'),guard),/owner/i);
 await db.createTask(task('fresh'),{owner,generation:restored.generation});
 assert.equal((await db.listCloudResourceRows('u')).task.length,2);
});

test('conditional cleanup does not delete a changed resource or another user row',async()=>{
 const {db} = await fresh();
 await db.upsertClientState('u',[{namespace:'n',key:'k',value:'old',updatedAt:1}]);
 const rows=await db.listCloudResourceRows('u');
 const locators=[{type:'state',rows:rows.state}];
 await db.upsertClientState('u',[{namespace:'n',key:'k',value:'new',updatedAt:2}]);
 assert.deepEqual(await db.deleteCloudResourceRows('u',locators),{deleted:0,changed:1});
 assert.equal((await db.getClientState('u','n'))[0].value,'new');
 assert.deepEqual(await db.deleteCloudResourceRows('other',locators),{deleted:0,changed:1});
});

test('retirement blocks late task updates and claims without modifying prior content',async()=>{
 const {db}=await fresh(); const guard={owner,generation:0};
 const row=await db.createTask(task('late'),guard);
 await db.setCloudOwnerActive('u',owner,false);
 await assert.rejects(db.updateTaskById(row.id,{encrypted_payload:'late'},guard), /owner/i);
 await assert.rejects(db.updateTaskByUuid('late','u','late',{},guard), /owner/i);
 await assert.rejects(db.claimTask(row.id,row.next_send_at,new Date(Date.now()+10000),null,guard), /owner/i);
 assert.equal((await db.getTaskByUuid('late','u')).encrypted_payload,'secret');
});

test('guard failure rolls back state chunk cleanup and replacing tasks',async()=>{
 const {db}=await fresh();
 await db.upsertClientState('u',[{namespace:'n',key:'k',value:'original',updatedAt:1}]);
 await db.createTask(task('prior'));
 await db.setCloudOwnerActive('u',owner,false);
 const guard={owner,generation:0};
 await assert.rejects(db.upsertClientState('u',[],[{namespace:'n',key:'k',updatedAt:2}],Date.now(),guard),/owner/i);
 await assert.rejects(db.createTaskSuperseding(task('replacement'),'prior',guard),/owner/i);
 assert.equal((await db.getClientState('u','n'))[0].value,'original');
 assert.ok(await db.getTaskByUuid('prior','u'));
});

test('metadata follows only successful state writes and guards block metadata changes',async()=>{
 const {db}=await fresh();
 await db.upsertClientState('u',[{namespace:'n',key:'k',value:'newer',updatedAt:10,encryptedCloudMetadata:'new-owner'}],[],20);
 await db.upsertClientState('u',[{namespace:'n',key:'k',value:'older',updatedAt:5,encryptedCloudMetadata:'old-owner'}],[],20);
 const raw=await db.listCloudResourceRows('u');
 assert.equal(raw.metadata[0].encrypted_value,'new-owner');
 await db.setCloudOwnerActive('u',owner,false);
 await assert.rejects(db.upsertClientState('u',[{namespace:'n',key:'k',value:'retired',updatedAt:15,encryptedCloudMetadata:'retired-owner'}],[],20,{owner,generation:0}),/owner/i);
 assert.equal((await db.listCloudResourceRows('u')).metadata[0].encrypted_value,'new-owner');
});

test('expired management records are pruned without deleting active leases or another kind',async()=>{
 const {db,raw}=await fresh();
 await db.putCloudDataRecord('u','plan','old','cipher');
 await db.putCloudDataRecord('u','operation','run','cipher');
 raw._raw.exec('UPDATE cloud_data_records SET updated_at=1');
 await db.claimCloudDataRecord('u','plan','old',60000);
 assert.equal(await db.cleanupCloudDataRecords('plan',10),0);
 await db.releaseCloudDataRecord('u','plan','old');
 assert.equal(await db.cleanupCloudDataRecords('plan',10),1);
 assert.ok(await db.getCloudDataRecord('u','operation','run'));
 assert.equal(await db.deleteCloudDataRecord('other','operation','run'),false);
 assert.equal(await db.deleteCloudDataRecord('u','operation','run'),true);
});

test('metadata maintenance preserves live rows and rootless chunks while clearing orphan sidecars',async()=>{
 const {db,raw}=await fresh();
 await db.upsertClientState('u',[{namespace:'n',key:'live',value:'x',updatedAt:1,encryptedCloudMetadata:'live-meta'}, {namespace:'n',key:'gone',value:'x',updatedAt:1,encryptedCloudMetadata:'gone-meta'}]);
 await db.upsertClientState('u',[],[{namespace:'n',key:'gone',updatedAt:2}]);
 raw._raw.prepare('INSERT INTO cloud_resource_metadata VALUES (?,?,?)').run('u','["state","n","gone"]','gone-meta');
 assert.equal(await db.cleanupCloudResourceMetadata('u'),1);
 assert.equal((await db.listCloudResourceRows('u')).metadata[0].encrypted_value,'live-meta');
});

test('owner restoration compare-and-set cannot override a newer retirement fence',async()=>{
 const {db}=await fresh();
 await db.setCloudOwnerActive('u',owner,false);
 const observed=await db.getCloudOwner('u',owner);
 await db.setCloudOwnerActive('u',owner,false);
 await assert.rejects(db.setCloudOwnerActive('u',owner,true,observed.generation),{code:'CLOUD_OWNER_CHANGED'});
 assert.equal((await db.getCloudOwner('u',owner)).active,false);
 const restored=await db.setCloudOwnerActive('u',owner,true,2);
 assert.equal(restored.active,true); assert.equal(restored.generation,3);
});

test('ownership metadata compare-and-set rejects concurrent reassignment without changing content',async()=>{
 const {db}=await fresh();
 const entry={namespace:'n',key:'k',value:'first',updatedAt:1,encryptedCloudMetadata:'first-owner'};
 await db.upsertClientState('u',[entry]);
 await db.upsertClientState('u',[{...entry,value:'second',updatedAt:2,encryptedCloudMetadata:'second-owner',expectedCloudMetadata:'first-owner'}]);
 await assert.rejects(db.upsertClientState('u',[{...entry,value:'late',updatedAt:3,encryptedCloudMetadata:'stale-owner',expectedCloudMetadata:'first-owner'}]),{code:'CLOUD_RESOURCE_CHANGED'});
 assert.equal((await db.getClientState('u','n'))[0].value,'second');
 assert.equal(await db.getCloudResourceMetadata('u','["state","n","k"]'),'second-owner');
});

test('expired cleanup workers cannot save or release a successor lease',async()=>{
 const {db,raw}=await fresh();
 await db.putCloudDataRecord('u','operation','op','initial');
 assert.equal(await db.claimCloudDataRecord('u','operation','op',60000,'first'),true);
 raw._raw.exec('UPDATE cloud_data_records SET lease_until=0');
 assert.equal(await db.claimCloudDataRecord('u','operation','op',60000,'second'),true);
 await assert.rejects(db.putCloudDataRecord('u','operation','op','stale',{leaseToken:'first'}),{code:'CLOUD_LEASE_LOST'});
 await db.releaseCloudDataRecord('u','operation','op','first');
 assert.equal(await db.claimCloudDataRecord('u','operation','op',60000,'third'),false);
 assert.equal(await db.renewCloudDataRecordLease('u','operation','op',60000,'second'),true);
 assert.equal(await db.renewCloudDataRecordLease('u','operation','op',60000,'first'),false);
 await db.putCloudDataRecord('u','operation','op','current',{leaseToken:'second'});
 assert.equal((await db.getCloudDataRecord('u','operation','op')).data,'current');
});

test('deletion-only state writes reject stale ownership metadata before removing rows',async()=>{
 const {db}=await fresh();
 await db.upsertClientState('u',[{namespace:'n',key:'k',value:'body',updatedAt:1,encryptedCloudMetadata:'owner-new'}]);
 await assert.rejects(db.upsertClientState('u',[],[{namespace:'n',key:'k',updatedAt:2,cloudMetadataKey:'["state","n","k"]',expectedCloudMetadata:'owner-old'}]),{code:'CLOUD_RESOURCE_CHANGED'});
 assert.equal((await db.getClientState('u','n')).length,1);
});

test('large encrypted management snapshots are chunked atomically and fully reclaimed',async()=>{
 const {db,raw}=await fresh();
 const large='a'.repeat(700000);
 await db.putCloudDataRecord('u','plan','large',large,{idempotencyKey:'idem'});
 const stored=raw._raw.prepare('SELECT data FROM cloud_data_records WHERE id=?').get('large');
 assert.ok(stored.data.length<100);
 assert.equal((await db.getCloudDataRecord('u','plan','large')).data,large);
 assert.equal((await db.listCloudDataRecords('u','plan'))[0].data,large);
 const recovered=await db.putCloudDataRecord('u','plan','other','b'.repeat(800000),{idempotencyKey:'idem'});
 assert.equal(recovered.data,large); assert.equal(recovered.id,'large');
 await db.putCloudDataRecord('u','plan','large','small');
 assert.equal(raw._raw.prepare('SELECT COUNT(*) AS n FROM cloud_data_record_chunks').get().n,0);
 await db.putCloudDataRecord('u','plan','large',large);
 raw._raw.exec('UPDATE cloud_data_records SET updated_at=1');
 assert.equal(await db.cleanupCloudDataRecords('plan',10),1);
 assert.equal(raw._raw.prepare('SELECT COUNT(*) AS n FROM cloud_data_record_chunks').get().n,0);
});

test('incomplete management record chunks fail explicitly instead of returning a partial plan',async()=>{
 const {db,raw}=await fresh();
 await db.putCloudDataRecord('u','operation','large','a'.repeat(500000));
 raw._raw.exec('DELETE FROM cloud_data_record_chunks WHERE chunk_index=1');
 await assert.rejects(db.getCloudDataRecord('u','operation','large'),{code:'CLOUD_RECORD_INCOMPLETE'});
});

test('owner registry remains discoverable after operations expire and never lists another user',async()=>{
 const {db}=await fresh();
 await db.setCloudOwnerActive('u',owner,false);
 await db.setCloudOwnerActive('other',{type:'character',id:'private'},false);
 const owners=await db.listCloudOwners('u');
 assert.deepEqual(owners.map(row=>({owner:row.owner,active:row.active,generation:row.generation})),[{owner,active:false,generation:1}]);
});

test('dropSchema removes management snapshots and owner registry with other user data',async()=>{
 const {db}=await fresh();
 await db.putCloudDataRecord('u','operation','one','a'.repeat(500000));
 await db.setCloudOwnerActive('u',owner,false);
 await db.dropSchema();
 assert.deepEqual((await db.describeSchema()).tables,{});
});

test('resource deletion checks the operation lease inside its transaction',async()=>{
 const {db,raw}=await fresh();
 await db.upsertClientState('u',[{namespace:'n',key:'k',value:'keep',updatedAt:1}]);
 const snapshot={type:'state',rows:(await db.listCloudResourceRows('u')).state};
 await db.putCloudDataRecord('u','operation','op','state');
 await db.claimCloudDataRecord('u','operation','op',60000,'first');
 raw._raw.exec('UPDATE cloud_data_records SET lease_until=0');
 await db.claimCloudDataRecord('u','operation','op',60000,'second');
 await assert.rejects(db.deleteCloudResourceRows('u',[snapshot],{operationId:'op',leaseToken:'first'}),{code:'CLOUD_LEASE_LOST'});
 assert.equal((await db.getClientState('u','n')).length,1);
 assert.deepEqual(await db.deleteCloudResourceRows('u',[snapshot],{operationId:'op',leaseToken:'second'}),{deleted:1,changed:0});
});

test('listing isolates one corrupt snapshot and exact idempotency lookup finds healthy operations',async()=>{
 const {db,raw}=await fresh();
 await db.putCloudDataRecord('u','operation','broken','a'.repeat(500000),{idempotencyKey:'bad'});
 await db.putCloudDataRecord('u','operation','healthy','good',{idempotencyKey:'good'});
 raw._raw.exec("DELETE FROM cloud_data_record_chunks WHERE id='broken' AND chunk_index=1");
 const listed=await db.listCloudDataRecords('u','operation');
 assert.equal(listed.find(row=>row.id==='broken').error,'CLOUD_RECORD_INCOMPLETE');
 assert.equal(listed.find(row=>row.id==='healthy').data,'good');
 assert.equal((await db.listCloudDataRecordsAcrossUsers('operation')).length,2);
 assert.equal((await db.getCloudDataRecordByIdempotency('u','operation','good')).id,'healthy');
 assert.equal(await db.getCloudDataRecordByIdempotency('other','operation','good'),null);
 await assert.rejects(db.getCloudDataRecord('u','operation','broken'),{code:'CLOUD_RECORD_INCOMPLETE'});
});

test('a task heartbeat cannot extend a retired owner generation',async()=>{
 const {db}=await fresh(); const guard={owner,generation:0};
 const row=await db.createTask(task('heartbeat'),guard);
 await db.claimTask(row.id,row.next_send_at,new Date(Date.now()+60000),null,guard);
 await db.setCloudOwnerActive('u',owner,false);
 await assert.rejects(db.renewTaskLease(row.id,new Date(Date.now()+120000),guard),{code:'CLOUD_OWNER_RETIRED'});
});

test('global metadata maintenance reclaims deleted sidecars across users and preserves owner fences',async()=>{
 const {db,raw}=await fresh();
 for(const user of ['u','other']) {
   await db.upsertClientState(user,[{namespace:'n',key:'gone',value:'x',updatedAt:1,encryptedCloudMetadata:'private-name'}]);
   await db.upsertClientState(user,[],[{namespace:'n',key:'gone',updatedAt:2}]);
   await db.setCloudOwnerActive(user,owner,false);
   raw._raw.prepare('INSERT INTO cloud_resource_metadata VALUES (?,?,?)').run(user,'["state","n","gone"]','private-name');
 }
 assert.equal(await db.cleanupCloudResourceMetadata('u'),1);
 assert.equal((await db.listCloudResourceRows('other')).metadata.length,1);
 assert.equal(await db.cleanupCloudResourceMetadata(),1);
 assert.equal((await db.listCloudResourceRows('other')).metadata.length,0);
 assert.equal((await db.getCloudOwner('other',owner)).active,false);
});
