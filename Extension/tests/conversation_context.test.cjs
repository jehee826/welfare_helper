const {test}=require('node:test'),assert=require('node:assert/strict');
const {worker,ui,key,profileKey,profile,expected,answer,append,settle,activeBoundary}=require('./conversation_fixture.cjs');
const protocol=require('../protocol.js'),policy=require('../conversations.js');
const date='2026-11-01T00:00:00.000Z';
const pairId=i=>i.toString(16).toUpperCase().padStart(20,'0');
function seed(count=6,custom={}){
  const messages=[];
  for(let i=1;i<=count;i++)messages.push(...policy.pair(pairId(i),'사용자 주제 '+i,{...answer,text:custom[i]||'모델의 이전 설명 '+i},1,date));
  return {[profileKey]:profile,[key]:{...policy.empty(),revision:1,lastActiveConversationId:'conversation',conversations:[{id:'conversation',createdAt:date,updatedAt:date,title:messages[0]?.content.slice(0,60)||'새 상담',messages,contextBoundary:activeBoundary()}]}};
}
const update=(input,status='updated',text='사용자는 합성 서비스의 신청처를 찾고 있음')=>({status,text:status==='updated'?text:input.text,coveredThroughMessageId:status==='updated'?input.batch.at(-1).id:input.coveredThroughMessageId,profileRevision:input.profileRevision});
async function begin(f,state,id=pairId(100),rev=1){const result=await f.action('begin',{...expected(state),pairId:id,profileRevision:rev});if(result.ok)Object.assign(state,result.state);return result;}

test('새 주제 표식은 저장과 worker 재생성 뒤 이전 맥락을 제외하고 화면 기록은 보존한다',async()=>{
  const f=worker(seed(2)),state=(await f.action('get')).state,plan=await begin(f,state),ctx=plan.input.conversation_context;
  assert.equal(ctx.supportsTopicBoundary,true);
  const u={status:'unchanged',text:ctx.text,coveredThroughMessageId:ctx.coveredThroughMessageId,profileRevision:1,resetTopic:true};
  const saved=await f.action('append',{...expected(state),pairId:pairId(100),profileRevision:1,question:'방과후 수업비가 부담돼요',answer:{...answer,context_update:u}});
  assert.equal(saved.ok,true);assert.equal(saved.state.conversations[0].messages.length,6);
  assert.equal(saved.state.conversations[0].messages.at(-1).topicStart,true);
  const restored=worker(f.data),read=await restored.action('get'),next=await begin(restored,read.state,pairId(101)),n=next.input.conversation_context;
  assert.deepEqual(next.input.history.map(m=>m.content),['방과후 수업비가 부담돼요',answer.text]);
  assert.deepEqual(n.userMessages.map(m=>m.content),['방과후 수업비가 부담돼요']);
  assert.equal(n.text,'');assert.equal(n.coveredThroughMessageId,null);
});

test('주제 표식은 오래된 요약 경계 유실 뒤에도 보존된다',()=>{
  const data=seed(2),c=data[key].conversations[0],m=c.messages;
  m.at(-1).topicStart=true;m.at(-1).contextUpdate={status:'updated',text:'이전 요약',coveredThroughMessageId:pairId(99)+':assistant',profileRevision:1};
  policy.retain(c);
  assert.equal(c.messages.at(-1).contextUpdate,undefined);assert.equal(c.messages.at(-1).topicStart,true);
  const ctx=policy.requestContext(c,1);
  assert.deepEqual(ctx.history.map(x=>x.content),[m.at(-2).content,m.at(-1).content]);
});

test('주제 경계 capability와 응답 표식의 형식 및 지원 여부를 검증한다',()=>{
  const input=policy.requestContext(seed()[key].conversations[0],1).conversation_context;
  assert.throws(()=>protocol.conversationContext({...input,supportsTopicBoundary:'true'}));
  const base={status:'unchanged',text:input.text,coveredThroughMessageId:input.coveredThroughMessageId,profileRevision:1};
  assert.throws(()=>protocol.contextUpdate({...base,resetTopic:'true'}));
  assert.throws(()=>protocol.documentReply({...answer,context_update:{...base,resetTopic:true}},{...input,supportsTopicBoundary:false}));
});

test('주제 전환 저장 실패와 삭제 뒤 늦은 응답은 표식을 저장하지 않는다',async()=>{
  const f=worker(seed(2)),state=(await f.action('get')).state,plan=await begin(f,state),ctx=plan.input.conversation_context;
  const fields={...expected(state),pairId:pairId(100),profileRevision:1,question:'새 주제',answer:{...answer,context_update:{status:'unchanged',text:ctx.text,coveredThroughMessageId:ctx.coveredThroughMessageId,profileRevision:1,resetTopic:true}}};
  const before=JSON.stringify(f.data[key]);f.failure.quota=true;
  assert.equal((await f.action('append',fields)).ok,false);assert.equal(JSON.stringify(f.data[key]),before);
  f.failure.quota=false;await f.action('clear',{expectedRevision:state.revision,generation:state.generation});
  assert.equal((await f.action('append',fields)).ok,false);assert.equal(f.data[key].conversations.length,0);
});

test('30쌍 유지로 주제 표식이 잘리면 남은 최근 메시지만 사용한다',()=>{
  const messages=[];for(let i=1;i<=31;i++)messages.push(...policy.pair(pairId(i),'주제 '+i,answer,1,date));
  messages[1].topicStart=true;const c={messages};policy.retain(c);
  assert.equal(c.messages.length,60);assert.ok(!c.messages.some(m=>m.topicStart));
  const result=policy.requestContext(c,1);assert.ok(result.conversation_context.userMessages.every(m=>m.id!==pairId(1)+':user'));
});

test('이전 요약과 메모가 있어도 전환 뒤 후속 저장은 새 주제 범위만 재구성한다',async()=>{
  const data=seed(6),old=data[key].conversations[0];
  old.summary={text:'이전 산모 요약',coveredThroughMessageId:pairId(3)+':assistant',profileRevision:1};
  old.messages.at(-1).contextUpdate={status:'unchanged',...old.summary,userMessageIds:[pairId(1)+':user']};
  old.messages.at(-1).evidence=[{document_id:'old-doc',chunk_id:'old-chunk',quote:'',source_url:'',pages:[],source_blocks:[]}];
  const f=worker(data);let state=(await f.action('get')).state,plan=await begin(f,state),ctx=plan.input.conversation_context;
  const u={status:'unchanged',text:ctx.text,coveredThroughMessageId:ctx.coveredThroughMessageId,profileRevision:1,resetTopic:true};
  let saved=await f.action('append',{...expected(state),pairId:pairId(100),profileRevision:1,question:'학교 지원',answer:{...answer,context_update:u}});
  assert.equal(saved.ok,true);state=saved.state;
  const school={...answer,evidence:[{document_id:'new-doc',chunk_id:'new-chunk',quote:'',context:'학교 자료',source_url:'',pages:[],source_blocks:[]}]};
  for(let i=101;i<=105;i++){saved=await append(f,state,pairId(i),'학교 후속 '+i,school);assert.equal(saved.ok,true);state=saved.state;}
  const restored=worker(f.data),read=await restored.action('get'),next=await begin(restored,read.state,pairId(106)),n=next.input.conversation_context;
  assert.equal(n.text,'');assert.equal(n.coveredThroughMessageId,null);assert.deepEqual(n.documentIds,['new-doc']);
  assert.ok(n.userMessages.every(m=>m.content.startsWith('학교')));
  assert.equal(n.batch.length,6);assert.equal(next.input.history.length,6);
  assert.ok(n.batch.every(m=>m.content.includes('학교')||m.content===answer.text));
  assert.ok(next.input.history.every(m=>m.content.includes('학교')||m.content===answer.text));
  assert.equal(read.state.conversations[0].messages.length,24);
});

test('주제 표식은 assistant의 불리언만 저장할 수 있다',()=>{
  for(const [index,value] of [[0,true],[1,'true']]){
    const c=seed(1)[key];c.conversations[0].messages[index].topicStart=value;
    assert.throws(()=>policy.record(c));
  }
});

test('전송 원문 목록은 사용자 메시지만 포함하며 구형 자유문 요약을 보존한다',async()=>{
  const data=seed(),old={text:'이전 자유문 요약',coveredThroughMessageId:pairId(3)+':assistant',profileRevision:1};data[key].conversations[0].summary=old;
  const f=worker(data),state=(await f.action('get')).state,plan=await begin(f,state),ctx=plan.input.conversation_context;
  assert.deepEqual(ctx.userMessages.map(x=>x.id),state.conversations[0].messages.filter(x=>x.role==='user').map(x=>x.id));
  assert.ok(ctx.userMessages.every(x=>x.role==='user'&&x.content.startsWith('사용자 주제')));
  assert.equal(ctx.text,old.text);assert.equal(ctx.coveredThroughMessageId,old.coveredThroughMessageId);
});

test('응답이 제출하지 않은 원문 ID를 선택하면 저장을 거절한다',async()=>{
  const f=worker(seed()),state=(await f.action('get')).state,plan=await begin(f,state),before=JSON.stringify(f.data[key]);
  const update={status:'unchanged',text:plan.input.conversation_context.text,coveredThroughMessageId:plan.input.conversation_context.coveredThroughMessageId,profileRevision:1,userMessageIds:[pairId(999)+':user']};
  const result=await f.action('append',{...expected(state),pairId:pairId(100),profileRevision:1,question:'질문',answer:{...answer,context_update:update}});
  assert.equal(result.ok,false);assert.equal(JSON.stringify(f.data[key]),before);
});

test('정정 뒤 원문 ID 메모를 저장하면 다음 요청은 해당 원문과 최신 발화를 복원한다',async()=>{
  const data=seed(2);data[key].conversations[0].messages[0].content='어머니는 68세이고 월세입니다';
  const f=worker(data),state=(await f.action('get')).state,plan=await begin(f,state),ctx=plan.input.conversation_context;
  const selected=ctx.userMessages.at(-1).id,update={status:'unchanged',text:ctx.text,coveredThroughMessageId:ctx.coveredThroughMessageId,profileRevision:1,userMessageIds:[selected]};
  const saved=await f.action('append',{...expected(state),pairId:pairId(100),profileRevision:1,question:'월세가 아니라 자가입니다',answer:{...answer,context_update:update}});
  assert.equal(saved.ok,true);const next=await begin(f,saved.state,pairId(101));
  assert.ok(next.input.conversation_context.userMessages.some(m=>m.id===selected));
  assert.ok(next.input.conversation_context.userMessages.some(m=>m.id===pairId(100)+':user'&&m.content==='월세가 아니라 자가입니다'));
  assert.equal(next.input.conversation_context.text,ctx.text);assert.equal(next.input.conversation_context.coveredThroughMessageId,ctx.coveredThroughMessageId);
});

test('일반 질문에서 빈 메모를 저장해도 다음 요청에 앞선 사용자 나이를 보존한다',async()=>{
  const data=seed(2);data[key].conversations[0].messages[0].content='어머니는 68세입니다';
  const f=worker(data),state=(await f.action('get')).state,plan=await begin(f,state),ctx=plan.input.conversation_context;
  const update={status:'unchanged',text:ctx.text,coveredThroughMessageId:ctx.coveredThroughMessageId,profileRevision:1,userMessageIds:[]};
  const saved=await f.action('append',{...expected(state),pairId:pairId(100),profileRevision:1,question:'일반 신청 방법은?',answer:{...answer,context_update:update}});
  assert.equal(saved.ok,true);const next=await begin(f,saved.state,pairId(101));
  assert.ok(next.input.conversation_context.userMessages.some(m=>m.id===pairId(1)+':user'&&m.content==='어머니는 68세입니다'));
});

test('6000자 제한에서는 선택된 오래된 원문 ID를 우선 보존한다',async()=>{
  const data=seed(25),messages=data[key].conversations[0].messages;
  for(let i=0;i<messages.length;i+=2)messages[i].content='가나다라마'[(i/2)%5].repeat(300);
  messages.at(-1).contextUpdate={status:'unchanged',text:'',coveredThroughMessageId:null,profileRevision:1,userMessageIds:[pairId(1)+':user']};
  const f=worker(data),state=(await f.action('get')).state,plan=await begin(f,state),ctx=plan.input.conversation_context;
  assert.ok(ctx.userMessages.some(m=>m.id===pairId(1)+':user'));
  assert.ok(ctx.userMessages.reduce((n,m)=>n+m.content.length,0)<=6000);assert.equal(ctx.omitted,true);
  assert.deepEqual(ctx.userMessages.map(m=>m.id),[...ctx.userMessages].map(m=>m.id).sort());
});
test('31번째 저장으로 메모 원문이 잘리면 다음 요청은 추정 없이 누락을 표시한다',async()=>{
  const f=worker(seed(30)),state=(await f.action('get')).state,plan=await begin(f,state),ctx=plan.input.conversation_context;
  const update={status:'unchanged',text:ctx.text,coveredThroughMessageId:ctx.coveredThroughMessageId,profileRevision:1,userMessageIds:[pairId(1)+':user']};
  const saved=await f.action('append',{...expected(state),pairId:pairId(100),profileRevision:1,question:'새 질문',answer:{...answer,context_update:update}});
  assert.equal(saved.ok,true);assert.equal(saved.state.conversations[0].messages.length,60);
  const next=await begin(f,saved.state,pairId(101)),nextContext=next.input.conversation_context;
  assert.equal(nextContext.omitted,true);assert.ok(!nextContext.userMessages.some(m=>m.id===pairId(1)+':user'));
});

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
test('기존schema1 기록은 보존하고 모르는 전송 시각의 자동 맥락은 이관 뒤 제외한다',async()=>{
  const data=seed();data[key].schemaVersion=1;const f=worker(data),state=(await f.action('get')).state;assert.equal(f.calls.set.length,1);assert.equal(state.schemaVersion,3);
  const plan=await begin(f,state),body={...answer,context_update:update(plan.input.conversation_context,'unchanged')};
  assert.deepEqual(plan.input.history,[]);assert.deepEqual(plan.input.conversation_context.userMessages,[]);
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
test('큰 이전 답변이 있어도 사용자 원문이 모두 있으면 누락 없이 보존한다',async()=>{
  const large=worker(seed(6,{1:'가'.repeat(6100)})),state=(await large.action('get')).state,plan=await begin(large,state);
  assert.equal(plan.input.conversation_context.batch.length,0);assert.equal(plan.input.conversation_context.omitted,false);assert.equal(plan.input.conversation_context.userMessages.length,6);assert.equal(plan.input.history.length,10);
  const partial=worker(seed(6,{1:'가'.repeat(2700),2:'나'.repeat(2700),3:'다'.repeat(1000)})),before=(await partial.action('get')).state,prefix=await begin(partial,before);
  assert.equal(prefix.input.conversation_context.batch.length,4);assert.equal(prefix.input.conversation_context.omitted,false);assert.equal(prefix.input.conversation_context.userMessages.length,6);
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
test('요약 응답도 삭제·접근 ID·소유권 변화 뒤 옛 대화를 되살리지 않는다',async()=>{
  for(const operation of ['clear','auth','cancel']){
    const f=worker(seed()),state=(await f.action('get')).state,plan=await begin(f,state);
    if(operation==='clear')await f.action(operation,{expectedRevision:state.revision,generation:state.generation});
    else if(operation==='auth')f.session.documentAccessId='changed';
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
test('자동 요약과 맥락 제외는 내부 저장하되 복원 화면에 기술 안내를 덧붙이지 않는다',async()=>{
  const server=worker(seed()),f=ui(server);try{
    await f.ready();await f.question('그 서비스는?');const input=f.ports.at(-1).packet.payload.conversation_context;assert.equal(input.omitted,false);
    await f.answer({...answer,context_update:update(input),context_usage:{omitted:true}});
    assert.ok(server.data[key].conversations[0].summary);assert.equal(server.data[key].conversations[0].messages.at(-1).contextUsage.omitted,true);assert.match(f.root.querySelector('.status').textContent,/일부 대화 맥락/);
  }finally{f.close();}
  const g=ui(server);try{await g.ready();assert.doesNotMatch(g.root.querySelector('.conversation').textContent,/입력 예산에 따라 일부 대화 맥락/);assert.equal(g.root.querySelector('.conversation-warning').textContent,'');assert.equal(server.data[key].conversations[0].messages.at(-1).contextUsage.omitted,true);}finally{g.close();}
});
