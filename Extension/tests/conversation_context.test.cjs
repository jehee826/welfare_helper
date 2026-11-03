const {test}=require('node:test'),assert=require('node:assert/strict');
const {worker,ui,key,profileKey,profile,expected,answer,append,settle}=require('./conversation_fixture.cjs');
const protocol=require('../protocol.js'),policy=require('../conversations.js');
const date='2026-11-01T00:00:00.000Z';
const pairId=i=>i.toString(16).toUpperCase().padStart(20,'0');
function seed(count=6,custom={}){
  const messages=[];
  for(let i=1;i<=count;i++)messages.push(...policy.pair(pairId(i),'사용자 주제 '+i,{...answer,text:custom[i]||'모델의 이전 설명 '+i},1,date));
  return {[profileKey]:profile,[key]:{...policy.empty(),revision:1,lastActiveConversationId:'conversation',conversations:[{id:'conversation',createdAt:date,updatedAt:date,title:messages[0]?.content.slice(0,60)||'새 상담',messages}]}};
}
const update=(input,status='updated',text='사용자는 합성 서비스의 신청처를 찾고 있음')=>({status,text:status==='updated'?text:input.text,coveredThroughMessageId:status==='updated'?input.batch.at(-1).id:input.coveredThroughMessageId,profileRevision:input.profileRevision});
async function begin(f,state,id=pairId(100),rev=1){return f.action('begin',{...expected(state),pairId:id,profileRevision:rev});}

test('첫6쌍의 오래된3쌍만 요약하고 이후3쌍 누적 때 연속 범위를 갱신한다',async()=>{
  const f=worker(seed());let state=(await f.action('get')).state;
  const first=await begin(f,state);assert.equal(first.input.conversation_context.batch.length,6);assert.equal(first.input.history.length,6);
  assert.deepEqual(first.input.conversation_context.batch.map(m=>m.id),state.conversations[0].messages.slice(0,6).map(m=>m.id));
  const saved=await f.action('append',{...expected(state),pairId:pairId(100),profileRevision:1,question:'7번째 질문',answer:{...answer,context_update:update(first.input.conversation_context)}});assert.equal(saved.ok,true);state=saved.state;
  assert.equal(state.conversations[0].summary.coveredThroughMessageId,pairId(3)+':assistant');
  assert.equal((await begin(f,state,pairId(101))).input.conversation_context.batch.length,0);
  state=(await append(f,state,pairId(101))).state;state=(await append(f,state,pairId(102))).state;
  const next=await begin(f,state,pairId(103));assert.equal(next.input.conversation_context.batch.length,6);assert.equal(next.input.conversation_context.batch[0].id,pairId(4)+':user');assert.equal(next.input.conversation_context.text,state.conversations[0].summary.text);
  const ids=new Set(next.input.conversation_context.batch.map(m=>m.id));assert.ok(!state.conversations[0].messages.slice(-next.input.history.length).some(m=>ids.has(m.id)));
});
test('기존schema1 무요약 상담을 초기화하지 않고 worker 재생성 후 요약과 경계를 복원한다',async()=>{
  const data=seed();data[key].schemaVersion=1;const f=worker(data),state=(await f.action('get')).state;assert.equal(f.calls.set.length,1);assert.equal(state.schemaVersion,2);
  const plan=await begin(f,state),body={...answer,context_update:update(plan.input.conversation_context)};
  const saved=await f.action('append',{...expected(state),pairId:pairId(100),profileRevision:1,question:'신청처',answer:body});
  const restored=await worker(data).action('get');assert.deepEqual(restored.state,saved.state);assert.equal(restored.state.conversations[0].messages.length,14);
});
test('임의 source ID·profileRevision·요약본문·출력 필드는 원자 저장을 막는다',async()=>{
  for(const changed of [{coveredThroughMessageId:pairId(5)+':assistant'},{profileRevision:2},{text:'010-1234-5678'},{text:'password=private'},{extra:'not allowed'}]){
    const f=worker(seed()),state=(await f.action('get')).state,plan=await begin(f,state),before=JSON.stringify(f.data[key]);
    const result=await f.action('append',{...expected(state),pairId:pairId(100),profileRevision:1,question:'질문',answer:{...answer,context_update:{...update(plan.input.conversation_context),...changed}}});
    assert.equal(result.ok,false);assert.equal(JSON.stringify(f.data[key]),before);
  }
});
test('큰 첫쌍을 건너뛰지 않고 omitted로 표시하며 들어가는 연속 prefix만 갱신한다',async()=>{
  const large=worker(seed(6,{1:'가'.repeat(6100)})),state=(await large.action('get')).state,plan=await begin(large,state);
  assert.equal(plan.input.conversation_context.batch.length,0);assert.equal(plan.input.conversation_context.omitted,true);assert.equal(plan.input.history.length,10);
  const partial=worker(seed(6,{1:'가'.repeat(2700),2:'나'.repeat(2700),3:'다'.repeat(1000)})),before=(await partial.action('get')).state,prefix=await begin(partial,before);
  assert.equal(prefix.input.conversation_context.batch.length,4);assert.equal(prefix.input.conversation_context.omitted,true);
  const saved=await partial.action('append',{...expected(before),pairId:pairId(100),profileRevision:1,question:'질문',answer:{...answer,context_update:update(prefix.input.conversation_context)}});
  assert.equal(saved.state.conversations[0].summary.coveredThroughMessageId,pairId(2)+':assistant');
});
test('요약 실패는 경계를 전진시키지 않고 다음 요청에 같은 batch를 다시 준비한다',async()=>{
  const f=worker(seed()),state=(await f.action('get')).state,plan=await begin(f,state);
  const saved=await f.action('append',{...expected(state),pairId:pairId(100),profileRevision:1,question:'질문',answer:{...answer,context_update:update(plan.input.conversation_context,'failed')}});
  assert.equal(saved.state.conversations[0].summary,undefined);assert.equal(saved.state.conversations[0].messages.length,14);
  const next=await begin(f,saved.state,pairId(101));assert.deepEqual(next.input.conversation_context.batch,plan.input.conversation_context.batch);
});
test('quota 뒤 답변과 요약을 추론 없이 함께 재저장하고 같은 pair의 다른 요약은 거절한다',async()=>{
  const f=worker(seed()),state=(await f.action('get')).state,plan=await begin(f,state),fields={...expected(state),pairId:pairId(100),profileRevision:1,question:'질문',answer:{...answer,context_update:update(plan.input.conversation_context)}};
  f.failure.quota=true;assert.equal((await f.action('append',fields)).ok,false);assert.equal(f.data[key].conversations[0].summary,undefined);assert.equal(f.data[key].conversations[0].messages.length,12);
  f.failure.quota=false;const saved=await f.action('append',fields);assert.equal(saved.ok,true);assert.equal(saved.state.conversations[0].messages.length,14);assert.ok(saved.state.conversations[0].summary);
  assert.deepEqual(await f.action('append',fields),saved);
  assert.equal((await f.action('append',{...fields,answer:{...fields.answer,context_update:{...fields.answer.context_update,text:'바뀐 요약'}}})).error,'conversation_conflict');
});
test('프로필 변경은 기존 대화 태그와 요약을 바꾸지 않는다',async()=>{
  const f=worker(seed()),state=(await f.action('get')).state,plan=await begin(f,state),saved=await f.action('append',{...expected(state),pairId:pairId(100),profileRevision:1,question:'질문',answer:{...answer,context_update:update(plan.input.conversation_context)}});
  await f.send({type:'gyeote:profile-save',expectedRevision:1,profile:{household:'single'}});
  const next=await begin(f,saved.state,pairId(101),1);assert.ok(next.input.history.length);assert.equal(next.input.conversation_context.text,f.data[key].conversations[0].summary.text);assert.equal(next.input.conversation_context.profileRevision,1);
});
test('요약 응답도 삭제·권한·소유권 변화 뒤 옛 대화를 되살리지 않는다',async()=>{
  for(const operation of ['clear','auth','cancel']){
    const f=worker(seed()),state=(await f.action('get')).state,plan=await begin(f,state);
    if(operation==='clear')await f.action(operation,{expectedRevision:state.revision,generation:state.generation});
    else if(operation==='auth'){f.session.documentAccess='admin';f.session.documentAccessId='changed';}
    else await f.send({type:'gyeote:conversation-cancel',pairId:pairId(100)});
    const before=JSON.stringify(f.data[key]);
    const result=await f.action('append',{...expected(state),pairId:pairId(100),profileRevision:1,question:'늦은 질문',answer:{...answer,context_update:update(plan.input.conversation_context)}});
    assert.equal(result.ok,false);assert.equal(JSON.stringify(f.data[key]),before);
  }
});
test('패널 복원 뒤 지시 대상 맥락과 summary 갱신 계약을 HTTP payload로 전달한다',async()=>{
  const server=worker(seed()),f=ui(server);try{
    await f.ready();await f.question('그 서비스 신청처는?');const packet=f.ports.at(-1).packet,input=packet.payload.conversation_context;
    assert.equal(input.batch.length,6);assert.equal(packet.payload.history.length,6);assert.equal(input.profileRevision,1);assert.equal(Object.hasOwn(packet,'profileRevision'),false);
    await f.answer({...answer,context_update:update(input)});assert.ok(server.data[key].conversations[0].summary);
  }finally{f.close();}
  const g=ui(server);try{await g.ready();await g.question('그 서비스는?');assert.equal(g.ports.at(-1).packet.payload.conversation_context.text,'사용자는 합성 서비스의 신청처를 찾고 있음');g.root.querySelector('button[type=submit]').click();}finally{g.close();}
});
test('미저장 요약 후보는 같은 대화 재저장 때 유지한다',async()=>{
    const server=worker(seed()),f=ui(server);try{
      await f.ready();await f.question('신청처는?');const input=f.ports.at(-1).packet.payload.conversation_context,ports=f.ports.length;
      server.failure.quota=true;await f.answer({...answer,context_update:update(input)});assert.equal(f.root.querySelector('.unsaved-conversation').hidden,false);server.failure.quota=false;
      await f.click('답변 저장 다시 시도');
      assert.equal(f.ports.length,ports);const saved=server.data[key].conversations.find(c=>c.id===server.data[key].lastActiveConversationId);
      assert.ok(saved.summary);assert.ok(saved.messages.at(-1).contextUpdate);
    }finally{f.close();}
});
test('손상 요약 재읽기는 자동 삭제하지 않고 개인정보 정제는 연속 경계를 보존한다',async()=>{
  const data=seed();data[key].conversations[0].summary={text:'사용자 연락처 010-1234-5678',coveredThroughMessageId:pairId(3)+':assistant',profileRevision:1};
  const f=worker(data),read=await f.action('get');assert.equal(read.ok,true);assert.ok(!JSON.stringify(read).includes('010-1234-5678'));assert.equal(read.state.conversations[0].summary.coveredThroughMessageId,pairId(3)+':assistant');
  data[key].conversations[0].summary.coveredThroughMessageId=pairId(99)+':assistant';const invalid=await f.action('get');assert.equal(invalid.error,'conversation_data_invalid');assert.ok(data[key].conversations[0].summary);
});
test('프로토콜은 summary 임의 필드·불완전 batch·화면 모드·응답 임의 ID를 차단한다',()=>{
  const input=policy.requestContext(seed()[key].conversations[0],1).conversation_context;
  assert.equal(protocol.documentRequest({query:'질문',conversation_context:input}).conversation_context.batch.length,6);
  for(const value of [{...input,extra:'no'},{...input,text:'<b>요약</b>'},{...input,batch:input.batch.slice(1)},{...input,batch:[{...input.batch[0],content:'계좌번호 123456789'},input.batch[1]]}])assert.throws(()=>protocol.documentRequest({query:'질문',conversation_context:value}));
  assert.throws(()=>protocol.request({conversation_context:input}));
  assert.throws(()=>protocol.documentReply({...answer,context_update:{...update(input),coveredThroughMessageId:pairId(99)+':assistant'}},input));
  assert.throws(()=>protocol.documentReply({...answer,context_update:update(input)},null));
  assert.throws(()=>protocol.documentReply({...answer,context_usage:{omitted:'true'}}));
  assert.throws(()=>protocol.documentReply({...answer,context_usage:{omitted:true,rawHistory:'no'}}));
});
test('요약 갱신 성공과 서버 맥락 제외를 함께 저장하고 새 패널에도 표시한다',async()=>{
  const server=worker(seed()),f=ui(server);try{
    await f.ready();await f.question('그 서비스는?');const input=f.ports.at(-1).packet.payload.conversation_context;assert.equal(input.omitted,false);
    await f.answer({...answer,context_update:update(input),context_usage:{omitted:true}});
    assert.ok(server.data[key].conversations[0].summary);assert.equal(server.data[key].conversations[0].messages.at(-1).contextUsage.omitted,true);assert.match(f.root.querySelector('.status').textContent,/일부 대화 맥락/);
  }finally{f.close();}
  const g=ui(server);try{await g.ready();assert.match(g.root.querySelector('.conversation').textContent,/입력 예산에 따라 일부 대화 맥락/);assert.match(g.root.querySelector('.conversation-warning').textContent,/일부 대화 맥락/);}finally{g.close();}
});
