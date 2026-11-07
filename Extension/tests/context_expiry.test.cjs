const {test}=require('node:test'),assert=require('node:assert/strict');
const {worker,ui,key,profileKey,profile,expected,answer}=require('./conversation_fixture.cjs');
require('../protocol.js');const policy=require('../conversations.js');
const timestamp=Date.parse('2026-11-08T00:00:00Z'),iso=value=>new Date(value).toISOString();
const pairId=value=>String(value).repeat(20),oldId=pairId(1),nextId=pairId(2);
function seed(last=iso(timestamp)){
  const messages=policy.pair(oldId,'어머니는 68세이고 부산에 살아요',{
    ...answer,evidence:[{document_id:'old-doc',chunk_id:'old-chunk',quote:'',context:'이전 자료',source_url:'',pages:[],source_blocks:[]}],
  },1,iso(timestamp));
  const conversation={id:'continuous',createdAt:iso(timestamp),updatedAt:iso(timestamp),messages,
    summary:{text:'과거 조건 요약',coveredThroughMessageId:oldId+':assistant',profileRevision:1},
    contextBoundary:{startedAt:iso(timestamp),startAfterPairId:null,lastUserSubmittedAt:last}};
  return {[profileKey]:profile,[key]:{...policy.empty(),revision:4,lastActiveConversationId:conversation.id,conversations:[conversation]}};
}
const create=(data,clock,failure={})=>worker(data,failure,undefined,undefined,null,()=>clock.value);
async function begin(f,state,id=nextId,tab=1){return f.action('begin',{...expected(state),pairId:id,profileRevision:1},tab);}
function noPast(input){
  assert.deepEqual(input.history,[]);const context=input.conversation_context;
  assert.equal(context.text,'');assert.equal(context.coveredThroughMessageId,null);
  for(const field of ['batch','userMessages','documentIds'])assert.deepEqual(context[field],[]);
}

for(const elapsed of [policy.limits.contextAge-1,policy.limits.contextAge,policy.limits.contextAge+1])test(`마지막 실제 전송 이후 ${elapsed}ms 경계를 적용하고 화면 기록은 보존한다`,async()=>{
  const clock={value:timestamp+elapsed},f=create(seed(),clock),read=await f.action('get');
  const result=await begin(f,read.state);assert.equal(result.ok,true);assert.equal(result.state.revision,read.state.revision+1);
  assert.equal(result.state.conversations[0].messages.length,2);
  assert.equal(result.state.conversations[0].contextBoundary.lastUserSubmittedAt,iso(clock.value));
  if(elapsed<policy.limits.contextAge){assert.equal(result.input.history.length,0);assert.equal(result.input.conversation_context.text,'과거 조건 요약');assert.deepEqual(result.input.conversation_context.documentIds,['old-doc']);}
  else noPast(result.input);
});

for(const last of [null,iso(timestamp+1)])test(`누락·미래 전송 시각 ${last}는 과거 자동 맥락을 제외한다`,async()=>{
  const f=create(seed(last),{value:timestamp}),result=await begin(f,(await f.action('get')).state);
  assert.equal(result.ok,true);noPast(result.input);assert.equal(result.state.conversations[0].messages.length,2);
});

test('단순 읽기·F5는 마지막 전송 시간을 갱신하지 않고 실패·취소 뒤 경계도 유지한다',async()=>{
  const data=seed(),clock={value:timestamp+policy.limits.contextAge},f=create(data,clock);
  for(let i=0;i<3;i++)await f.action('get');assert.equal(data[key].conversations[0].contextBoundary.lastUserSubmittedAt,iso(timestamp));
  const result=await begin(f,(await f.action('get')).state);noPast(result.input);
  await f.send({type:'gyeote:conversation-cancel',pairId:nextId});clock.value+=1000;
  const restored=create(data,clock),retry=await begin(restored,(await restored.action('get')).state,pairId(3));
  assert.equal(retry.ok,true);noPast(retry.input);
  const saved=await restored.action('append',{...expected(retry.state),pairId:pairId(3),profileRevision:1,question:'새 질문',answer});
  assert.equal(saved.ok,true);assert.equal(saved.state.conversations[0].messages.length,4);
  const followup=await begin(restored,saved.state,pairId(4));assert.deepEqual(followup.input.history.map(m=>m.content),['새 질문',answer.text]);
});

for(const version of [1,2])test(`v${version} 이관은 원본 메시지·근거를 보존하고 모르는 전송 시각을 추정하지 않는다`,async()=>{
  const data=seed();data[key].schemaVersion=version;delete data[key].conversations[0].contextBoundary;
  const original=JSON.stringify(data),f=create(data,{value:timestamp}),read=await f.action('get');
  assert.equal(read.state.schemaVersion,3);assert.equal(read.state.conversations[0].messages.length,2);
  assert.equal(read.state.conversations[0].messages[1].evidence[0].document_id,'old-doc');
  assert.equal(read.state.conversations[0].contextBoundary.lastUserSubmittedAt,null);
  if(version===2){assert.equal(read.state.conversations[0].id,'continuous');assert.equal(read.state.conversations[0].summary.text,'과거 조건 요약');}
  const result=await begin(f,read.state);assert.equal(result.ok,true);noPast(result.input);
  const failureData=JSON.parse(original),failed=create(failureData,{value:timestamp},{quota:true});
  assert.equal((await failed.action('get')).warning,'conversation_migration_unsaved');assert.equal(JSON.stringify(failureData),original);
});

test('만료 경계 저장 실패는 모델 호출 없이 기존 기록을 유지하고 재시도한다',async()=>{
  const data=seed(),clock={value:timestamp+policy.limits.contextAge},f=create(data,clock),panel=ui(f);
  try{
    await panel.ready();const original=JSON.stringify(data[key]);f.failure.quota=true;
    await panel.question('새 질문');assert.equal(panel.ports.length,0);assert.equal(JSON.stringify(data[key]),original);
    assert.match(panel.root.querySelector('.status').textContent,/저장|대화/);
    f.failure.quota=false;await panel.question('새 질문');assert.equal(panel.ports.length,1);
    noPast(panel.ports[0].packet.payload);await panel.answer(answer);assert.equal(data[key].conversations[0].messages.length,4);
  }finally{panel.close();}
});

test('두 탭의 오래된 begin과 응답은 새 revision을 덮어쓰지 않는다',async()=>{
  const f=create(seed(),{value:timestamp+policy.limits.contextAge}),state=(await f.action('get')).state;
  const first=await begin(f,state,nextId),other=await begin(f,state,pairId(3),2);
  assert.equal(first.ok,true);assert.equal(other.error,'conversation_conflict');
  const stale=await f.action('append',{...expected(state),pairId:nextId,profileRevision:1,question:'옛 revision',answer});
  assert.equal(stale.ok,false);assert.equal(f.data[key].revision,first.state.revision);
  const saved=await f.action('append',{...expected(first.state),pairId:nextId,profileRevision:1,question:'정상 revision',answer});
  assert.equal(saved.ok,true);
});

test('답변 저장만 재시도할 때는 마지막 사용자 전송 시각을 갱신하지 않는다',async()=>{
  const data=seed(),clock={value:timestamp},server=create(data,clock),panel=ui(server);
  try{
    await panel.ready();await panel.question('새 질문');server.failure.quota=true;await panel.answer(answer);
    const submitted=data[key].conversations[0].contextBoundary.lastUserSubmittedAt,ports=panel.ports.length;
    clock.value+=1000;server.failure.quota=false;await panel.click('답변 저장 다시 시도');
    assert.equal(data[key].conversations[0].messages.length,4);assert.equal(panel.ports.length,ports);
    assert.equal(data[key].conversations[0].contextBoundary.lastUserSubmittedAt,submitted);
  }finally{panel.close();}
});

test('지연된 옛 revision 통지는 새 요청을 취소하지 않는다',async()=>{
  const server=worker(),panel=ui(server);
  try{
    await panel.ready();await panel.question('첫 질문');await panel.answer(answer);
    const prior=server.data[key].revision;await panel.question('후속 질문');const port=panel.ports.at(-1);
    panel.notify({type:'gyeote:conversations-changed',revision:prior,generation:server.data[key].generation});
    await panel.ready();assert.notEqual(port.disconnected,true);await panel.answer(answer);
    assert.equal(server.data[key].conversations[0].messages.length,4);
  }finally{panel.close();}
});

test('남은 기록에 없는 경계 ID는 자동 맥락을 열지 않고 원본을 보존한다',async()=>{
  const data=seed();data[key].conversations[0].contextBoundary.startAfterPairId=pairId(9);
  const original=JSON.stringify(data),server=create(data,{value:timestamp});
  assert.equal((await server.action('get')).error,'conversation_data_invalid');assert.equal(JSON.stringify(data),original);
});

test('30쌍 보존에서 경계 쌍이 사라져도 이후 기록과 주제 경계를 함께 제한한다',()=>{
  const c=seed()[key].conversations[0];c.contextBoundary.startAfterPairId=oldId;
  for(let i=2;i<=32;i++)c.messages.push(...policy.pair(i.toString(16).toUpperCase().padStart(20,'0'),'새 질문 '+i,answer,1,iso(timestamp)));
  c.messages.at(-3).topicStart=true;policy.retain(c);
  assert.equal(c.contextBoundary.startAfterPairId,null);assert.equal(c.messages.length,60);
  assert.deepEqual(policy.requestContext(c,1).history.map(m=>m.content),['새 질문 31',answer.text,'새 질문 32',answer.text]);
});
