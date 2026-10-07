import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createD1Adapter} from '../src/server/adapters/d1.js';
import {createTestD1} from './helpers/sqlite-d1.mjs';
import {encryptForStorage} from '../src/server/lib/encryption.js';
import * as inventory from '../src/server/lib/cloud-data-inventory.js';
const key='ab'.repeat(32);
async function fresh(){const raw=createTestD1();const db=createD1Adapter(raw);await db.initSchema();return {db,raw};}
const encrypt=(value)=>encryptForStorage(value,key);

test('inventory retains bad ciphertext and acked rows, merges chunks, exposes orphan chunks without secrets',async()=>{
 const {db}=await fresh();
 await db.upsertClientState('u',[
  {namespace:'char:a',key:'context',value:'\u001famsg-chunked\u001fv1\u001f2',updatedAt:1},
  {namespace:'\u001famsg-chunks\u001fchar:a',key:'context\u001f0',value:await encrypt('secret'),updatedAt:1},
  {namespace:'\u001famsg-chunks\u001fchar:a',key:'context\u001f1',value:await encrypt('body'),updatedAt:1},
  {namespace:'\u001famsg-chunks\u001fchar:b',key:'missing\u001f0',value:await encrypt('orphan'),updatedAt:1},
  {namespace:'bad',key:'bad',value:'invalid cipher',updatedAt:1}
 ]);
 await db.appendOutboxMessages('u',[{message_id:'acked',payload:await encrypt(JSON.stringify({content:'message secret'})),created_at:1}]);
 await db.ackOutboxMessages('u',['acked'],2);
 const result=await inventory.buildCloudDataInventory({db,userId:'u',userKey:key,resolveOwner:({namespace})=>namespace?.startsWith('char:')?{owner:{type:'character',id:namespace.slice(5)},kind:'context'}:null});
 assert.equal(result.entries.length,4);
 assert.equal(result.entries.filter(e=>e.resource.type==='state').length,3);
 assert.equal(result.entries.find(e=>e.resource.owner?.id==='a').locator.rows.length,3);
 assert.equal(result.entries.find(e=>e.resource.type==='outbox').resource.status,'acked');
 assert.ok(result.entries.some(e=>e.resource.status==='unreadable'));
 assert.ok(result.entries.some(e=>e.resource.status==='orphan-chunks'));
 const publicJson=JSON.stringify(result.entries.map(e=>e.resource));
 assert.ok(!publicJson.includes('secret')); assert.ok(!publicJson.includes('invalid cipher')); assert.equal(result.complete,true);
});

test('inventory keeps explicit encrypted owner metadata and binds opaque resource IDs to users',async()=>{
 const {db}=await fresh();
 await db.upsertLlmCredentials('u',[{credId:'api',encryptedValue:await encrypt('{"apiKey":"TOPSECRET"}'),encryptedCloudMetadata:await encrypt(JSON.stringify({owner:{type:'character',id:'c',label:'Cherry'},kind:'chat-api'}))}]);
 await db.upsertLlmCredentials('other',[{credId:'api',encryptedValue:await encrypt('{}')}]);
 const a=await inventory.buildCloudDataInventory({db,userId:'u',userKey:key});
 const b=await inventory.buildCloudDataInventory({db,userId:'other',userKey:key});
 assert.equal(a.entries[0].resource.owner.label,'Cherry');
 assert.equal(a.entries[0].resource.kind,'chat-api');
 assert.notEqual(a.entries[0].resource.id,b.entries[0].resource.id);
 assert.ok(!JSON.stringify(a.entries.map(e=>e.resource)).includes('TOPSECRET'));
});

test('inventory reports missing physical sources as gaps rather than empty successful inventory',async()=>{
 const {db,raw}=await fresh(); raw._raw.exec('DROP TABLE message_outbox');
 const result=await inventory.buildCloudDataInventory({db,userId:'u',userKey:key});
 assert.equal(result.complete,false); assert.ok(result.gaps.some(g=>g.source==='outbox'));
});

test('cleanup refuses a preview whose encrypted ownership changed without row changes',async()=>{
 const {db}=await fresh();
 const entry={namespace:'n',key:'k',value:await encrypt('body'),updatedAt:1};
 await db.upsertClientState('u',[{...entry,encryptedCloudMetadata:await encrypt(JSON.stringify({owner:{type:'character',id:'first'}}))}]);
 const before=await inventory.buildCloudDataInventory({db,userId:'u',userKey:key});
 await db.upsertClientState('u',[{...entry,encryptedCloudMetadata:await encrypt(JSON.stringify({owner:{type:'character',id:'second'}}))}]);
 assert.deepEqual(await db.deleteCloudResourceRows('u',[before.entries[0].locator]),{deleted:0,changed:1});
 assert.equal((await db.getClientState('u','n')).length,1);
});

test('cleanup refuses an orphan chunk preview when its root appears afterward',async()=>{
 const {db}=await fresh();
 await db.upsertClientState('u',[{namespace:'\u001famsg-chunks\u001fn',key:'k\u001f0',value:await encrypt('body'),updatedAt:1}]);
 const before=await inventory.buildCloudDataInventory({db,userId:'u',userKey:key});
 await db.upsertClientState('u',[{namespace:'n',key:'k',value:'\u001famsg-chunked\u001fv1\u001f1',updatedAt:1}]);
 assert.deepEqual(await db.deleteCloudResourceRows('u',[before.entries[0].locator]),{deleted:0,changed:1});
 assert.equal((await db.getClientState('u','\u001famsg-chunks\u001fn')).length,1);
});

test('legacy tasks with null UUIDs each remain individually visible and removable',async()=>{
 const {db}=await fresh();
 for(let i=0;i<2;i++) await db.createTask({user_id:'u',uuid:null,encrypted_payload:await encrypt('{}'),next_send_at:'2020-01-01',message_type:'fixed'});
 const result=await inventory.buildCloudDataInventory({db,userId:'u',userKey:key});
 assert.equal(new Set(result.entries.map(e=>e.resource.id)).size,2);
 assert.deepEqual(await db.deleteCloudResourceRows('u',[result.entries[0].locator]),{deleted:1,changed:0});
 assert.equal((await db.listCloudResourceRows('u')).task.length,1);
});

test('resource labels distinguish different keys belonging to the same named owner',async()=>{
 const {db}=await fresh();
 for(const name of ['context','log']) await db.upsertClientState('u',[{namespace:'character',key:name,value:await encrypt('secret'),updatedAt:1,encryptedCloudMetadata:await encrypt(JSON.stringify({owner:{type:'character',id:'one',label:'Cherry'}}))}]);
 const result=await inventory.buildCloudDataInventory({db,userId:'u',userKey:key});
 assert.deepEqual(result.entries.map(e=>e.resource.label).sort(),['character/context','character/log']);
 assert.ok(result.entries.every(e=>e.resource.owner.label==='Cherry'));
});

test('latest cloud owner label fills missing labels across resource types without replacing explicit snapshots',async()=>{
 const {db}=await fresh();
 await db.upsertClientState('u',[
  {namespace:'char:one',key:'tool_pack',value:await encrypt('label'),updatedAt:20},
  {namespace:'char:one',key:'fire_pack',value:await encrypt('body'),updatedAt:30},
  {namespace:'char:one',key:'older',value:await encrypt('older'),updatedAt:10}
 ]);
 await db.upsertLlmCredentials('u',[{credId:'char:one/chat',encryptedValue:await encrypt('{}')}]);
 const result=await inventory.buildCloudDataInventory({db,userId:'u',userKey:key,resolveOwner:({type,key:stateKey})=>({owner:{type:'character',id:'one',...(stateKey==='tool_pack'?{label:'Current name'}:stateKey==='older'?{label:'Old name'}:{})},kind:type})});
 assert.equal(result.entries.find(e=>e.resource.label==='char:one/fire_pack').resource.owner.label,'Current name');
 assert.equal(result.entries.find(e=>e.resource.type==='credential').resource.owner.label,'Current name');
 assert.equal(result.entries.find(e=>e.resource.label==='char:one/older').resource.owner.label,'Old name');
});
