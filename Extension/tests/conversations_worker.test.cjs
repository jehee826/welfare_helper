const {test}=require('node:test'),assert=require('node:assert/strict');
const {worker,key,profileKey,profile,expected,answer,append}=require('./conversation_fixture.cjs');
require('../protocol.js');const policy=require('../conversations.js');
test('세션 객체 키 순서만 달라져도 재생성 후 자동 저장한다',async()=>{
  const f=worker(),state=(await f.action('get')).state,pairId='6'.repeat(20),fields={...expected(state),pairId,profileRevision:1};
  assert.equal((await f.action('begin',fields)).ok,true);
  const reorder=v=>Array.isArray(v)?v.map(reorder):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).reverse().map(([k,x])=>[k,reorder(x)])):v;
  f.session['gyeote.conversation-owner:1']=reorder(f.session['gyeote.conversation-owner:1']);
  const restarted=worker(f.data,{},f.source,undefined,f.session);
  const fallback={kind:'fallback',text:'확인할 조건을 알려주세요.',evidence:[],context_usage:{omitted:false},context_update:{status:'unchanged',text:'',coveredThroughMessageId:null,profileRevision:1}};
  const automatic=await restarted.action('append',{...fields,question:'합성 질문',answer:fallback});assert.equal(automatic.ok,true);assert.equal(automatic.state.conversations[0].messages.length,2);
});
test('같은 documentId의 hash 변경 후 자동 저장한다',async()=>{
  const f=worker(),state=(await f.action('get')).state,pairId='5'.repeat(20),fields={...expected(state),pairId,profileRevision:1};
  const before=f.sender(1);before.documentId='123e4567-e89b-42d3-a456-426614174000';
  assert.equal((await f.send({type:'gyeote:conversations-begin',accessId:'public-1',...fields},before)).ok,true);
  const restarted=worker(f.data,{},f.source,undefined,f.session),after=restarted.sender(1);after.documentId=before.documentId;after.url+='\u0023section';after.tab.url=after.url;
  const fallback={kind:'fallback',reason:'out_of_scope',text:'복지 관련 질문을 알려주세요.',services:[],contacts:[],suggestions:[],evidence:[],context_usage:{omitted:false},context_update:{status:'unchanged',text:'',coveredThroughMessageId:null,profileRevision:1}};
  const message={type:'gyeote:conversations-append',accessId:'public-1',...fields,question:'합성 질문',answer:fallback};
  const automatic=await restarted.send(message,after);assert.equal(automatic.ok,true);assert.equal(automatic.state.conversations[0].messages.length,2);
});
test('documentId 없는 hash 변경과 다른 query는 자동 저장을 거절한다',async()=>{
  for(const kind of ['no-document','query']){
    const f=worker(),state=(await f.action('get')).state,pairId='7'.repeat(20),fields={...expected(state),pairId,profileRevision:1},before=f.sender(1);
    if(kind==='query')before.documentId='123e4567-e89b-42d3-a456-426614174000';
    assert.equal((await f.send({type:'gyeote:conversations-begin',accessId:'public-1',...fields},before)).ok,true);
    const restarted=worker(f.data,{},f.source,undefined,f.session),after=restarted.sender(1);if(kind==='query')after.documentId=before.documentId;
    after.url+=kind==='query'?'?changed=1':'#section';after.tab.url=after.url;
    const result=await restarted.send({type:'gyeote:conversations-append',accessId:'public-1',...fields,question:'질문',answer},after);
    assert.equal(result.ok,false,kind);assert.equal(result.error,'conversation_request_stopped');assert.equal(restarted.calls.set.length,0);
  }
});
test('세션 문맥의 실제 값이나 배열 변경은 저장하지 않는다',async()=>{
  for(const kind of ['history','batch','summary','profile']){
    const f=worker(),state=(await f.action('get')).state,pairId='8'.repeat(20),fields={...expected(state),pairId,profileRevision:1};
    assert.equal((await f.action('begin',fields)).ok,true);const owner=f.session['gyeote.conversation-owner:1'];
    if(kind==='history')owner.input.history.push({role:'user',content:'변조'});
    if(kind==='batch')owner.input.conversation_context.batch.push({id:'9'.repeat(20)+':user',role:'user',content:'변조'});
    if(kind==='summary'){owner.input.conversation_context.text='변조';owner.input.conversation_context.coveredThroughMessageId='9'.repeat(20)+':assistant';}
    if(kind==='profile')owner.input.conversation_context.profileRevision=2;
    const restarted=worker(f.data,{},f.source,undefined,f.session),fallback={kind:'fallback',text:'안내',evidence:[],context_update:{status:'unchanged',text:'',coveredThroughMessageId:null,profileRevision:1}};
    const result=await restarted.action('append',{...fields,question:'질문',answer:fallback});assert.equal(result.ok,false,kind);assert.equal(restarted.calls.set.length,0,kind);
  }
});
test('실제 대화 batch와 history 순서를 바꾸면 저장을 거절한다',async()=>{
  for(const kind of ['batch','history']){
    const f=worker();let state=(await f.action('get')).state;
    for(let i=0;i<6;i++){const saved=await append(f,state,String(i+1).repeat(20),'질문 '+i,answer);assert.equal(saved.ok,true);state=saved.state;}
    const fields={...expected(state),pairId:'9'.repeat(20),profileRevision:1};assert.equal((await f.action('begin',fields)).ok,true);
    const owner=f.session['gyeote.conversation-owner:1'];
    const list=kind==='batch'?owner.input.conversation_context.batch:owner.input.history;assert.ok(list.length>=2);[list[0],list[1]]=[list[1],list[0]];
    const restarted=worker(f.data,{},f.source,undefined,f.session),reply={kind:'fallback',text:'안내',evidence:[],context_update:{status:'unchanged',text:'',coveredThroughMessageId:null,profileRevision:1}};
    const result=await restarted.action('append',{...fields,question:'질문',answer:reply});assert.equal(result.ok,false,kind);assert.equal(restarted.calls.set.length,0,kind);
  }
});
test('worker 재생성 뒤 fallback 답변을 저장하고 새 패널에 복원한다',async()=>{
  const first=worker(),state=(await first.action('get')).state,pairId='A'.repeat(20);
  const fields={...expected(state),pairId,profileRevision:1};
  const sender=first.sender(1);sender.documentId='123e4567-e89b-42d3-a456-426614174000';
  const begun=await first.send({type:'gyeote:conversations-begin',accessId:'public-1',...fields},sender);assert.equal(begun.ok,true);
  const restarted=worker(first.data,{},first.source,undefined,first.session);
  const fallback={kind:'fallback',reason:'out_of_scope',text:'복지 관련 질문을 알려주세요.',services:[],contacts:[],suggestions:[],evidence:[],context_usage:{omitted:false},context_update:{status:'unchanged',text:'',coveredThroughMessageId:null,profileRevision:1}};
  const saved=await restarted.send({type:'gyeote:conversations-append',accessId:'public-1',...fields,question:'합성 질문',answer:fallback},sender);
  assert.equal(saved.ok,true);const {ui}=require('./conversation_fixture.cjs'),panel=ui(restarted);
  try{await panel.ready();assert.match(panel.root.querySelector('.conversation').textContent,/복지 관련 질문을 알려주세요/);}finally{panel.close();}
});
test('취소 후 worker 재생성은 이전 append를 거절한다',async()=>{
  const first=worker(),state=(await first.action('get')).state,pairId='B'.repeat(20),fields={...expected(state),pairId,profileRevision:1};
  assert.equal((await first.action('begin',fields)).ok,true);await first.send({type:'gyeote:conversation-cancel',pairId});
  const restarted=worker(first.data,{},first.source,undefined,first.session);assert.equal((await restarted.action('append',{...fields,question:'질문',answer})).ok,false);
});
test('세션 소유권 저장 실패는 begin을 거절한다',async()=>{
  const f=worker(),state=(await f.action('get')).state;f.failure.sessionSet=true;
  const fields={...expected(state),pairId:'C'.repeat(20),profileRevision:1};
  const result=await f.action('begin',fields);assert.equal(result.ok,false);
  delete f.failure.sessionSet;assert.equal((await f.action('append',{...fields,question:'질문',answer})).ok,false);
});
test('세션 저장 대기 중 취소는 재생성 후에도 append를 막는다',async()=>{
  let release;const f=worker(),state=(await f.action('get')).state,pairId='E'.repeat(20),fields={...expected(state),pairId,profileRevision:1};
  f.failure.beforeSessionSet=v=>Object.keys(v).some(k=>k.startsWith('gyeote.conversation-owner:'))?new Promise(resolve=>{release=resolve;}):undefined;
  const begin=f.action('begin',fields);for(let i=0;i<30&&!release;i++)await new Promise(setImmediate);assert.equal(typeof release,'function');
  const cancel=f.send({type:'gyeote:conversation-cancel',pairId});delete f.failure.beforeSessionSet;release();
  assert.equal((await begin).ok,false);assert.equal((await cancel).ok,true);
  const restarted=worker(f.data,{},f.source,undefined,f.session);assert.equal((await restarted.action('append',{...fields,question:'질문',answer})).ok,false);
});
test('세션 복원 대기 중 취소는 늦은 append를 막는다',async()=>{
  const first=worker(),state=(await first.action('get')).state,pairId='2'.repeat(20),fields={...expected(state),pairId,profileRevision:1};
  assert.equal((await first.action('begin',fields)).ok,true);let release;
  const restarted=worker(first.data,{beforeSessionGet:keys=>typeof keys==='string'&&keys.startsWith('gyeote.conversation-owner:')?new Promise(resolve=>{release=resolve;}):undefined},first.source,undefined,first.session);
  const pending=restarted.action('append',{...fields,question:'질문',answer});for(let i=0;i<30&&!release;i++)await new Promise(setImmediate);assert.equal(typeof release,'function');
  const cancelled=restarted.send({type:'gyeote:conversation-cancel',pairId});delete restarted.failure.beforeSessionGet;release();
  assert.equal((await pending).ok,false);assert.equal((await cancelled).ok,true);assert.equal(first.data[key],undefined);
});
test('탭 제거는 세션 소유권을 정리한다',async()=>{
  const f=worker(),state=(await f.action('get')).state,pairId='3'.repeat(20),fields={...expected(state),pairId,profileRevision:1};
  assert.equal((await f.action('begin',fields)).ok,true);f.removeTab(1);await new Promise(setImmediate);
  assert.equal(f.session['gyeote.conversation-owner:1'],undefined);
});
test('세션 복원 대기 중 탭 제거는 늦은 append를 막는다',async()=>{
  const first=worker(),state=(await first.action('get')).state,pairId='4'.repeat(20),fields={...expected(state),pairId,profileRevision:1};
  assert.equal((await first.action('begin',fields)).ok,true);let release;
  const restarted=worker(first.data,{beforeSessionGet:keys=>typeof keys==='string'&&keys.startsWith('gyeote.conversation-owner:')?new Promise(resolve=>{release=resolve;}):undefined},first.source,undefined,first.session);
  const pending=restarted.action('append',{...fields,question:'질문',answer});for(let i=0;i<30&&!release;i++)await new Promise(setImmediate);assert.equal(typeof release,'function');
  restarted.removeTab(1);delete restarted.failure.beforeSessionGet;release();assert.equal((await pending).ok,false);await new Promise(setImmediate);assert.equal(first.data[key],undefined);
});
test('만료·다른 문서·탭 소유권은 재생성 뒤 append를 거절한다',async()=>{
  for(const kind of ['expired','document','tab']){
    const first=worker(),state=(await first.action('get')).state,pairId='D'.repeat(20),fields={...expected(state),pairId,profileRevision:1};
    assert.equal((await first.action('begin',fields)).ok,true);if(kind==='expired')first.session['gyeote.conversation-owner:1'].expiresAt=0;
    const restarted=worker(first.data,{},first.source,undefined,first.session),sender=restarted.sender(kind==='tab'?2:1);if(kind==='document')sender.documentId='other';
    const result=await restarted.send({type:'gyeote:conversations-append',accessId:'public-1',...fields,question:'질문',answer},sender);assert.equal(result.ok,false,kind);
  }
});
test('새 요청과 접근·프로필·revision 변경 뒤 이전 소유권은 거절한다',async()=>{
  for(const kind of ['new-pair','access','profile','revision','url']){
    const f=worker(),state=(await f.action('get')).state,pairId='F'.repeat(20),fields={...expected(state),pairId,profileRevision:1};
    assert.equal((await f.action('begin',fields)).ok,true);
    if(kind==='new-pair')assert.equal((await f.action('begin',{...fields,pairId:'1'.repeat(20)})).ok,true);
    if(kind==='access')f.session.documentAccessId='changed';
    if(kind==='profile')f.data[profileKey]={...profile,revision:2};
    if(kind==='revision')assert.equal((await f.action('new',{expectedRevision:state.revision,generation:state.generation})).ok,true);
    const restarted=worker(f.data,{},f.source,undefined,f.session),sender=restarted.sender(1);
    if(kind==='url'){sender.url='https://www.bokjiro.go.kr/other';sender.tab.url=sender.url;}
    const result=await restarted.send({type:'gyeote:conversations-append',accessId:'public-1',...fields,question:'질문',answer},sender);assert.equal(result.ok,false,kind);assert.equal(result.error,{'new-pair':'conversation_request_stopped',access:'conversation_access_changed',profile:'conversation_profile_changed',revision:'conversation_conflict',url:'conversation_request_stopped'}[kind]);assert.equal(restarted.calls.set.length,0,kind);
  }
});
test('원문 지역·수정일은 상담 복원에도 보존하고 개인정보 형식은 정제한다',async()=>{
  const f=worker(),state=(await f.action('get')).state;
  const reply={...answer,evidence:[{document_id:'00000000-0000-0000-0000-000000000001',chunk_id:'source:1',quote:'지원 조건',context:'지원 조건',pages:[1],source_blocks:['b1'],source_url:'https://example.invalid',region_scope:'서울특별시',source_updated_at:'2026-07-04',source_organization:'공식기관 <script>명령</script> 010-1234-5678'}]};
  const saved=await append(f,state,'A'.repeat(20),'질문',reply);
  assert.equal(saved.ok,true);
  const restored=(await worker(f.data).action('get')).state.conversations[0].messages[1].evidence[0];
  assert.equal(restored.region_scope,'서울특별시');assert.equal(restored.source_updated_at,'2026-07-04');
  assert.ok(!restored.source_organization.includes('<script>'));assert.ok(!restored.source_organization.includes('010-1234-5678'));
});
test('공개 상담은 성공쌍으로 저장되고 worker 재생성 후 복원된다',async()=>{
  const f=worker(),initial=await f.action('get');assert.equal(initial.state.revision,0);assert.equal(f.data[key],undefined);
  const saved=await append(f,initial.state);assert.equal(saved.ok,true);assert.equal(saved.state.revision,1);
  const conversation=saved.state.conversations[0];assert.equal(conversation.messages.length,2);assert.equal(conversation.title,'합성 질문');assert.equal(saved.state.lastActiveConversationId,conversation.id);
  assert.deepEqual((await worker(f.data).action('get')).state,saved.state);assert.deepEqual(f.data[profileKey],profile);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.level)),[{accessLevel:'TRUSTED_CONTEXTS'}]);
  assert.ok(f.messages.every(message=>!JSON.stringify(message).includes('합성 질문')));
});
test('같은 pair의 재시도는 멱등이고 내용 바꿔 덮어쓰기는 거절한다',async()=>{
  const f=worker(),state=(await f.action('get')).state,saved=await append(f,state);
  const fields={...expected(state),pairId:'A'.repeat(20),question:'합성 질문',answer,profileRevision:1};
  assert.deepEqual(await f.action('append',fields),saved);assert.equal(f.calls.set.length,1);
  assert.equal((await f.action('append',{...fields,question:'바뀐 질문'})).error,'conversation_conflict');
});
test('새 상담·선택·개별삭제·전체삭제는 revision을 유지하고 늦은 응답을 막는다',async()=>{
  const f=worker(),first=await append(f,(await f.action('get')).state),id=first.state.lastActiveConversationId;
  const second=await f.action('new',{expectedRevision:1,generation:'initial'});assert.equal(second.state.conversations.length,2);assert.notEqual(second.state.lastActiveConversationId,id);
  const selected=await f.action('select',{expectedRevision:2,generation:'initial',conversationId:id});assert.equal(selected.state.lastActiveConversationId,id);
  const deleted=await f.action('delete',{expectedRevision:3,generation:'initial',conversationId:id});assert.equal(deleted.state.lastActiveConversationId,null);
  assert.equal((await append(f,selected.state,'B'.repeat(20))).error,'conversation_conflict');
  const cleared=await f.action('clear',{expectedRevision:4,generation:'initial'});assert.equal(cleared.state.revision,5);assert.deepEqual(cleared.state.conversations,[]);
  assert.equal((await append(f,second.state,'C'.repeat(20))).error,'conversation_conflict');assert.deepEqual(f.data[profileKey],profile);
});
test('복수 탭 쓰기는 하나만 성공하며 같은 선택의 오래된 revision도 거절한다',async()=>{
  const f=worker();const replies=await Promise.all([append(f,(await f.action('get')).state,'A'.repeat(20),'첫 탭',answer,1),append(f,(await f.action('get')).state,'B'.repeat(20),'둘째 탭',answer,2)]);
  assert.equal(replies.filter(value=>value.ok).length,1);assert.equal(replies.find(value=>!value.ok).error,'conversation_conflict');assert.equal(f.data[key].conversations.length,1);
});
test('실제 관리자 권한과 accessId·profileRevision·취소 소유권을 검사한다',async()=>{
  const f=worker(),state=(await f.action('get')).state;
  f.session.documentAccess='admin';assert.equal((await f.action('get')).error,'conversation_access_changed');assert.equal(f.data[key],undefined);
  f.session.documentAccess='anonymous';assert.equal((await f.action('get',{accessId:'stale'})).error,'conversation_access_changed');
  assert.equal((await f.action('begin',{...expected(state),pairId:'A'.repeat(20),profileRevision:0})).error,'conversation_profile_changed');
  await f.action('begin',{...expected(state),pairId:'A'.repeat(20),profileRevision:1});await f.send({type:'gyeote:conversation-cancel',pairId:'A'.repeat(20)});
  assert.equal((await f.action('append',{...expected(state),pairId:'A'.repeat(20),profileRevision:1,question:'질문',answer})).error,'conversation_request_stopped');assert.equal(f.data[key],undefined);
});
test('프로필 변경과 append 경쟁에서 바뀐 조건의 옛 답변은 저장하지 않는다',async()=>{
  const f=worker(),state=(await f.action('get')).state;const fields={...expected(state),pairId:'A'.repeat(20),profileRevision:1};await f.action('begin',fields);
  await f.send({type:'gyeote:profile-save',expectedRevision:1,profile:null});
  assert.equal((await f.action('append',{...fields,question:'질문',answer})).error,'conversation_profile_changed');assert.equal(f.data[key],undefined);
});
test('대기 중 append도 취소 소유권을 다시 확인하고 권한 전환은 쓰기와 직렬화된다',async()=>{
  const f=worker(),state=(await f.action('get')).state,fields={...expected(state),pairId:'A'.repeat(20),profileRevision:1};await f.action('begin',fields);
  let entered,release;const atProfile=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  f.failure.beforeGet=async name=>{if(name===profileKey){entered();await gate;}};
  const committing=f.action('append',{...fields,question:'합성 공개 질문',answer});await atProfile;
  const switching=f.send({type:'gyeote:admin-connect',session:{token:'a'.repeat(40),expiresAt:Math.floor(Date.now()/1000)+600}},{id:'x',url:'chrome-extension://x/options.html'});
  await f.send({type:'gyeote:conversation-cancel',pairId:fields.pairId});release();
  assert.equal((await committing).error,'conversation_request_stopped');assert.equal((await switching).mode,'admin');assert.equal(f.data[key],undefined);
  assert.equal((await f.action('get')).error,'conversation_access_changed');
});
test('quota 실패는 자료를 보존하고 추론 없이 같은 pair를 재저장한다',async()=>{
  const f=worker(),state=(await f.action('get')).state;f.failure.quota=true;
  assert.equal((await append(f,state)).error,'conversation_storage_failed');assert.equal(f.data[key],undefined);
  f.failure.quota=false;assert.equal((await append(f,state)).state.conversations[0].messages.length,2);
});
test('최대 30상담·100메시지·4MiB 한도는 자동삭제하지 않는다',async()=>{
  const f=worker();let state=(await f.action('get')).state;
  for(let i=0;i<30;i++)state=(await f.action('new',{expectedRevision:state.revision,generation:state.generation})).state;
  const raw=JSON.stringify(f.data);assert.equal((await f.action('new',{expectedRevision:state.revision,generation:state.generation})).error,'conversation_count_limit');assert.equal(JSON.stringify(f.data),raw);
  const g=worker();state=(await g.action('get')).state;
  for(let i=1;i<=50;i++)state=(await append(g,state,i.toString(16).toUpperCase().padStart(20,'0'))).state;
  assert.equal((await append(g,state,'F'.repeat(20))).error,'conversation_messages_limit');assert.equal(g.data[key].conversations[0].messages.length,100);
  const h=worker();state=(await h.action('get')).state;
  const long={kind:'answer',text:'가'.repeat(60000),evidence:[]};let response;
  for(let i=1;i<=30;i++){response=await append(h,state,i.toString(16).toUpperCase().padStart(20,'0'),'질문',long);if(!response.ok)break;state=response.state;}
  assert.equal(response.error,'conversation_bytes_limit');assert.ok(policy.bytes(h.data[key])<=4*1024*1024);assert.equal(h.data[key].revision,state.revision);
});
test('손상 저장소는 자동초기화하지 않고 확인한 상태만 새 세대로 재설정한다',async()=>{
  const f=worker({[profileKey]:profile,[key]:{schemaVersion:8,revision:'broken',secret:'not exposed'}}),read=await f.action('get');assert.equal(read.error,'conversation_data_invalid');assert.ok(read.resetToken);assert.equal(f.calls.set.length,0);assert.ok(!JSON.stringify(read).includes('secret'));
  const reset=await f.action('reset',{resetToken:read.resetToken});assert.equal(reset.ok,true);assert.notEqual(reset.state.generation,'initial');assert.equal(reset.state.revision,0);
  assert.equal((await append(f,policy.empty())).error,'conversation_conflict');assert.deepEqual(f.data[profileKey],profile);
  assert.equal((await f.action('reset',{resetToken:read.resetToken})).error,'conversation_conflict');
});
test('공식 최상위 동일탭 외 sender와 임의 key는 읽기·쓰기를 열지 않는다',async()=>{
  const f=worker();for(const change of [{id:'other'},{frameId:1},{url:'https://example.invalid/'},{tab:{id:1,url:'https://www.bokjiro.go.kr/changed'}}])assert.equal(await f.send({type:'gyeote:conversations-get',accessId:'public-1'},{...f.sender(1),...change}),undefined);
  assert.equal(f.calls.get.length,0);assert.equal((await f.action('get',{key:'documentAdminSession'})).error,'conversation_invalid_request');assert.equal(f.calls.get.length,0);
});
test('저장·재읽기 정제는 HTML·비밀·원문 context를 제외하고 근거 한도를 표시한다',async()=>{
  const f=worker(),state=(await f.action('get')).state;
  const evidence=Array.from({length:12},(_,i)=>({document_id:'doc-'+i,chunk_id:'chunk-'+i,quote:'인용'.repeat(700)+' 010-1234-5678',context:'저장하면 안 되는 전체 원문',pages:Array.from({length:60},(_,n)=>n+1),source_blocks:Array.from({length:60},(_,n)=>'block-'+n),source_url:i?'https://example.org/source':'https://example.org/?token=secret'}));
  const saved=await append(f,state,'A'.repeat(20),'<b>합성</b> 질문',{kind:'answer',text:'<b>안내</b> password=secret Bearer abcdef 010-1234-5678',evidence});assert.equal(saved.ok,true);
  const message=saved.state.conversations[0].messages[1],json=JSON.stringify(f.data[key]);
  for(const secret of ['<b>','secret','abcdef','010-1234-5678','전체 원문','"context"'])assert.ok(!json.includes(secret),secret);
  assert.equal(message.evidence.length,10);assert.equal(message.evidence[0].quote.length,1000);assert.equal(message.evidence[0].pages.length,50);assert.equal(message.evidence[0].source_blocks.length,50);assert.equal(message.evidence[0].source_url,'');assert.equal(message.evidenceTruncated,true);assert.equal(message.redacted,true);
  f.data[key].conversations[0].messages[0].content='계좌번호 123-456-789012';f.data[key].extraToken='private';
  const reread=await f.action('get');assert.equal(reread.state.revision,2);assert.ok(!JSON.stringify(reread).includes('123-456'));assert.ok(!JSON.stringify(f.data[key]).includes('private'));
});
test('전송 이력은 최근 완전한 쌍 12메시지·6000자이며 프로필 변경 뒤 비운다',()=>{
  const messages=[];for(let i=0;i<9;i++)messages.push(...policy.pair(i.toString(16).toUpperCase().padStart(20,'0'),'질문',answer,1,new Date().toISOString()));
  assert.equal(policy.history({messages},1).length,12);assert.deepEqual(policy.history({messages},2),[]);
  messages.at(-1).content='가'.repeat(6000);assert.deepEqual(policy.history({messages},1),[]);
});
test('Docling 원문 참조를 보존하고 인코딩한 개인정보·인증 URL은 저장하지 않는다',async()=>{
  const f=worker(),state=(await f.action('get')).state;
  const body={kind:'answer',text:'원문 참조 안내',evidence:[{document_id:'doc',chunk_id:'chunk',quote:'합성 인용',context:'',pages:[1],source_blocks:['#/texts/0','#/tables/1'],source_url:'https://example.org/?phone=010%201234%205678'}]};
  const saved=await append(f,state,'A'.repeat(20),'근거 질문',body);assert.equal(saved.ok,true);assert.deepEqual(saved.state.conversations[0].messages[1].evidence[0].source_blocks,['#/texts/0','#/tables/1']);assert.equal(saved.state.conversations[0].messages[1].evidence[0].source_url,'');
  assert.equal(policy.sourceUrl('https://example.org/#access_token=private'),'');assert.equal(policy.sourceUrl('https://example.org/source#page=1'),'https://example.org/source#page=1');
});
