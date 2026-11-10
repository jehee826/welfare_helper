const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {worker,ui,key,profileKey,profile,expected,answer,append,source,settle}=require('./conversation_fixture.cjs');
const protocol=require('../protocol.js'),policy=require('../conversations.js');
const usageKey='gyeote.profileUsage',values={age:72,income:'under50',household:'single',region:'부산광역시',disability:false};
const savedProfile={...profile,profile:values};
const id=value=>value.toString(16).toUpperCase().padStart(20,'0');
const supported=async url=>{assert.ok([protocol.documentOrigin()+'/api/v1/chat/capabilities',protocol.documentOrigin()+'/api/v1/conversation/summary'].includes(url));return new Response(JSON.stringify({profile_context_supported:true,available:true,version:1}));};
const server=(data={[profileKey]:savedProfile},failure={})=>worker(data,failure,undefined,supported);
const get=f=>f.send({type:'gyeote:profile-usage-get'});
const set=(f,expectedRevision,enabled,profileRevision=1)=>f.send({type:'gyeote:profile-usage-set',expectedRevision,enabled,profileRevision:enabled?profileRevision:null});
const consent=revision=>({enabled:true,consent_revision:revision,profile_revision:1,profile:values});
function readDeadlines(w){
  const nativeSet=w.setTimeout.bind(w),nativeClear=w.clearTimeout.bind(w),pending=new Map();let next=-1;
  w.setTimeout=(fn,ms,...args)=>{if(ms!==5000)return nativeSet(fn,ms,...args);const id=next--;pending.set(id,()=>fn(...args));return id;};
  w.clearTimeout=id=>{if(!pending.delete(id))nativeClear(id);};
  return ()=>{const callbacks=[...pending.values()];pending.clear();callbacks.forEach(fn=>fn());};
}

test('기본 OFF는 저장 프로필을 첨부하지 않고 ON은 별도 동의 revision과 허용 필드만 제공한다',async()=>{
  const f=server(),panel=ui(f);
  try{
    await panel.ready();assert.deepEqual((await get(f)).state,{schemaVersion:1,revision:0,enabled:false,profileRevision:null});
    await panel.question('복지 제도를 알려주세요');assert.equal(Object.hasOwn(panel.ports.at(-1).packet.payload,'profile_context'),false);await panel.answer(answer);
    assert.equal((await set(f,0,true)).ok,true);await settle();await panel.question('지원 조건을 알려주세요');
    assert.deepEqual(panel.ports.at(-1).packet.payload.profile_context,consent(1));assert.equal(Object.hasOwn(panel.ports.at(-1).packet.payload,'profile'),false);
    assert.deepEqual(f.data[profileKey],savedProfile);
  }finally{panel.close();}
});

test('OFF 전환은 요약·원문 조건·문서 참조를 함께 끊고 화면 기록·프로필·F5 선택은 보존한다',async()=>{
  const f=server();let state=(await f.action('get')).state;
  const ref={document_id:'old-doc',chunk_id:'old-chunk',quote:'',context:'이전 안내',source_url:'',pages:[],source_blocks:[]};
  for(let index=1;index<=6;index++)state=(await append(f,state,id(index),'과거 조건 '+index,{...answer,evidence:[ref]})).state;
  f.data[key].conversations[0].summary={text:'저장 정보에서 파생된 과거 요약',coveredThroughMessageId:id(3)+':assistant',profileRevision:1};
  await set(f,0,true);const panel=ui(f);
  try{
    await panel.ready();const originalMessages=JSON.stringify(f.data[key].conversations[0].messages),last=f.data[key].conversations[0].contextBoundary.lastUserSubmittedAt;
    assert.equal((await set(f,1,false)).ok,true);await settle();
    assert.equal(JSON.stringify(f.data[key].conversations[0].messages),originalMessages);assert.equal(f.data[key].conversations[0].contextBoundary.lastUserSubmittedAt,last);
    await panel.question('새 상담');const payload=panel.ports.at(-1).packet.payload;
    assert.equal(Object.hasOwn(payload,'profile_context'),false);assert.deepEqual(payload.history,[]);
    assert.equal(payload.conversation_context.text,'');for(const name of ['batch','userMessages','documentIds'])assert.deepEqual(payload.conversation_context[name],[]);
    assert.match(panel.root.querySelector('.conversation').textContent,/과거 조건/);assert.deepEqual(f.data[profileKey],savedProfile);
  }finally{panel.close();}
  const restored=ui(f);try{await restored.ready();assert.equal(restored.root.querySelector('.profile-usage-toggle').checked,false);}finally{restored.close();}
});

test('ON 동의는 프로필 revision 변경 뒤 무효이며 새 프로필 재동의는 이전 자동 맥락을 끊는다',async()=>{
  const f=server();await set(f,0,true);let state=(await f.action('get')).state;
  state=(await append(f,state,id(1),'기존 상담')).state;
  await f.send({type:'gyeote:profile-save',expectedRevision:1,profile:{...values,age:40}});
  const fields={...expected(state),pairId:id(2),profileRevision:1},begun=await f.action('begin',fields);
  assert.equal(begun.ok,true);assert.equal(Object.hasOwn(begun,'profileContext'),false);
  assert.equal((await get(f)).valid,false);assert.equal((await set(f,1,true,1)).error,'profile_changed');
  assert.equal((await set(f,1,true,2)).ok,true);
  const next=await f.action('begin',{...expected((await f.action('get')).state),pairId:id(3),profileRevision:1});
  assert.equal(next.profileContext.profile.age,40);assert.equal(next.profileContext.profile_revision,2);assert.deepEqual(next.input.history,[]);
});

test('OFF의 프로필 변경은 진행 요청을 유지하고 ON의 늦은 응답 저장은 거절한다',async()=>{
  for(const enabled of [false,true]){
    const f=server();if(enabled)await set(f,0,true);
    const begun=await f.action('begin',{...expected((await f.action('get')).state),pairId:id(1),profileRevision:0});
    await f.send({type:'gyeote:profile-save',expectedRevision:1,profile:{...values,age:40}});
    const result=await f.action('append',{...expected(begun.state),pairId:id(1),profileRevision:0,question:'질문',answer});
    assert.equal(result.ok,!enabled);if(enabled){assert.equal(result.error,'conversation_profile_changed');assert.deepEqual(f.data[key].conversations[0].messages,[]);}
  }
});

test('동의 저장 실패와 OFF 경계 저장 실패는 상태를 일부만 바꾸지 않는다',async()=>{
  const f=server();f.failure.set=true;assert.equal((await set(f,0,true)).ok,false);assert.equal(f.data[usageKey],undefined);
  f.failure.set=false;await set(f,0,true);await append(f,(await f.action('get')).state,id(1));
  const original=JSON.stringify(f.data);f.failure.set=true;assert.equal((await set(f,1,false)).ok,false);assert.equal(JSON.stringify(f.data),original);
});

test('다른 탭 선택 경쟁은 revision으로 거절하고 공식 top-frame 외 쓰기는 허용하지 않는다',async()=>{
  const f=server();const results=await Promise.all([set(f,0,true),set(f,0,true)]);
  assert.equal(results.filter(result=>result.ok).length,1);assert.equal(results.find(result=>!result.ok).error,'profile_usage_conflict');
  const original=JSON.stringify(f.data);
  for(const change of [{id:'other'},{frameId:1},{url:'https://example.invalid/'},{tab:{id:-1,url:'https://www.bokjiro.go.kr/'}}]){
    assert.equal(await f.send({type:'gyeote:profile-usage-set',expectedRevision:1,enabled:false,profileRevision:null},{...f.sender(1),...change}),undefined);
  }
  assert.equal(JSON.stringify(f.data),original);
});

test('손상된 동의와 서버 미지원에서는 저장 정보를 보내지 않고 원본을 보존한다',async()=>{
  for(const invalid of [false,true]){
    const data={[profileKey]:savedProfile,[usageKey]:invalid?{schemaVersion:9,revision:4,enabled:true,profileRevision:1}:{schemaVersion:1,revision:1,enabled:true,profileRevision:1}};
    const f=invalid?server(data):worker(data,{},undefined,async()=>new Response('{}',{status:404}));const original=JSON.stringify(data[usageKey]);
    const result=await f.action('begin',{...expected((await f.action('get')).state),pairId:id(1),profileRevision:0});
    assert.equal(result.ok,true);assert.equal(Object.hasOwn(result,'profileContext'),false);assert.equal(JSON.stringify(data[usageKey]),original);
  }
});

test('ON/OFF UI는 저장 성공 상태만 표시하고 새 패널에서도 선택을 복원한다',async()=>{
  const f=server(),panel=ui(f);
  try{
    await panel.ready();const toggle=panel.root.querySelector('.profile-usage-toggle');assert.equal(toggle.disabled,false);assert.equal(toggle.checked,false);
    const section=toggle.closest('.profile-usage'),compose=panel.root.querySelector('.compose-row');
    assert.equal(section.nextElementSibling,compose);assert.equal(panel.root.querySelectorAll('.profile-usage-toggle').length,1);assert.equal(section.closest('.profile-slot'),null);
    await panel.click('내 정보');assert.equal(toggle.disabled,false);assert.equal(section.closest('[inert]')!==null,true);
    await panel.click('내 정보 수정');await panel.click('설정 닫기');assert.equal(toggle.disabled,false);
    toggle.checked=true;toggle.dispatchEvent(new panel.w.Event('change'));await settle();assert.equal(toggle.checked,true);assert.equal(f.data[usageKey].enabled,true);
    f.failure.set=true;toggle.checked=false;toggle.dispatchEvent(new panel.w.Event('change'));await settle();assert.equal(toggle.checked,true);assert.match(panel.root.querySelector('.profile-usage-status').textContent,/저장하지 못/);
    f.failure.set=false;
  }finally{panel.close();}
  const restored=ui(f);try{await restored.ready();assert.equal(restored.root.querySelector('.profile-usage-toggle').checked,true);}finally{restored.close();}
});

test('입력란의 정보 사용 선택은 화면 안내에서 숨기고 복지 상담으로 돌아오면 복원한다',async()=>{
  const panel=ui(server());try{
    await panel.ready();const section=panel.root.querySelector('.profile-usage');assert.equal(section.hidden,false);
    await panel.mode('screen');assert.equal(section.hidden,true);
    await panel.mode('document');assert.equal(section.hidden,false);assert.equal(panel.root.querySelector('.profile-slot').hidden,true);
  }finally{panel.close();}
});

for(const capability of ['unsupported','404','offline'])test(`서버 지원 ${capability} 상태에서도 로컬 사용 선택은 명시 ON으로 저장한다`,async()=>{
 let calls=0;const f=worker({[profileKey]:savedProfile},{},undefined,async()=>{calls++;if(capability==='offline')throw Error('격리 통신 실패');return new Response(JSON.stringify({profile_context_supported:false}),{status:capability==='404'?404:200});}),panel=ui(f);
 try{await panel.ready();const section=panel.root.querySelector('.profile-usage'),toggle=section.querySelector('input'),before=calls;assert.equal(section.hidden,false);assert.equal(toggle.disabled,false);assert.equal(toggle.checked,false);assert.equal(f.data[usageKey],undefined);toggle.click();await settle();assert.equal(f.data[usageKey].enabled,true);assert.equal(f.data[usageKey].profileRevision,1);assert.equal(toggle.checked,true);assert.equal(calls,before);assert.equal(panel.ports.length,0);}finally{panel.close();}
});

test('서버 지원 응답 대기 중에도 ON을 로컬에 저장하며 지원 조회를 추가하지 않는다',async()=>{
 let release,calls=0;const pending=new Promise(resolve=>{release=resolve;}),f=worker({[profileKey]:savedProfile},{},undefined,async()=>{calls++;await pending;return new Response(JSON.stringify({profile_context_supported:true}));}),panel=ui(f);
 try{await panel.ready();const section=panel.root.querySelector('.profile-usage'),toggle=section.querySelector('input'),before=calls;assert.equal(toggle.disabled,false);assert.equal(f.data[usageKey],undefined);toggle.click();await settle();assert.equal(f.data[usageKey].enabled,true);assert.equal(toggle.checked,true);assert.equal(toggle.getAttribute('aria-checked'),'true');assert.equal(section.querySelector('.profile-usage-value').textContent,'ON');assert.equal(calls,before);}finally{release();panel.close();}
});

test('질문 모드의 사용 선택은 프로필 미등록·설정 읽기 실패를 숨기지 않는다',async()=>{
  for(const failed of [false,true]){
    const f=server({[profileKey]:profile},failed?{get:true}:{}),panel=ui(f);
    try{
      await panel.ready();if(panel.root.querySelector('.profile-toggle').getAttribute('aria-expanded')==='true')await panel.click('내 정보');
      const section=panel.root.querySelector('.profile-usage');assert.equal(section.hidden,false);assert.equal(section.querySelector('input').disabled,true);
      assert.match(section.querySelector('.profile-usage-status').textContent,failed?/읽지 못|확인하지 못/:/저장된 내 정보가 없습니다/);
      assert.equal(panel.ports.length,0);
    }finally{panel.close();}
  }
});

test('옛 관리자 선택은 저장한 명시 ON을 막거나 새 동의로 바꾸지 않는다',async()=>{
 const record={schemaVersion:1,revision:1,enabled:true,profileRevision:1},f=server({[profileKey]:savedProfile,[usageKey]:record});f.session.documentAccess='admin';f.session.documentAccessId='legacy';const panel=ui(f);
 try{await panel.ready();const section=panel.root.querySelector('.profile-usage'),toggle=section.querySelector('input');assert.equal(section.hidden,false);assert.equal(toggle.disabled,false);assert.equal(toggle.checked,true);assert.deepEqual(f.data[usageKey],record);assert.equal(panel.ports.length,0);}finally{panel.close();}
});

test('지원 확인이 안 된 기존 ON도 끄고 다시 명시 ON으로 저장할 수 있다',async()=>{
 const f=worker({[profileKey]:savedProfile,[usageKey]:{schemaVersion:1,revision:1,enabled:true,profileRevision:1}},{},undefined,async()=>new Response('{}',{status:404})),panel=ui(f);
 try{await panel.ready();const section=panel.root.querySelector('.profile-usage'),toggle=section.querySelector('input');assert.equal(toggle.checked,true);assert.equal(toggle.disabled,false);toggle.click();await settle();assert.equal(f.data[usageKey].enabled,false);assert.equal(toggle.checked,false);assert.equal(toggle.disabled,false);toggle.click();await settle();assert.equal(f.data[usageKey].enabled,true);assert.equal(toggle.checked,true);assert.equal(section.hidden,false);assert.equal(panel.ports.length,0);}finally{panel.close();}
});

for(const stage of ['loading','failed'])test(`사용 설정 ${stage} 상태에서도 클릭은 최신 로컬 설정을 읽고 명시 ON을 저장한다`,async()=>{
 const f=server();let expire,release,reads=0;const panel=ui(f,1,w=>{expire=readDeadlines(w);const send=w.chrome.runtime.sendMessage;w.chrome.runtime.sendMessage=message=>message.type==='gyeote:profile-usage-get'&&++reads===1?new Promise(resolve=>{release=resolve;}):send(message);});
 try{await panel.ready();if(stage==='failed'){expire();await settle();}const toggle=panel.root.querySelector('.profile-usage-toggle');assert.equal(toggle.disabled,false);assert.equal(f.data[usageKey],undefined);toggle.click();await settle();assert.equal(f.data[usageKey].enabled,true);assert.equal(f.data[usageKey].revision,1);assert.equal(toggle.checked,true);release({ok:true,state:{schemaVersion:1,revision:0,enabled:false,profileRevision:null},valid:false});await settle();assert.equal(toggle.checked,true);assert.equal(f.data[usageKey].enabled,true);}finally{release?.();panel.close();}
});

test('질문 모드의 사용 선택은 긴 대화·접기와 다른 탭 동의 변경 뒤에도 표시·상태를 유지한다',async()=>{
  const f=server();let state=(await f.action('get')).state;state=(await append(f,state,id(1),'긴 대화',{...answer,text:'합성 안내 '.repeat(150)})).state;
  const panel=ui(f);try{
    await panel.ready();const section=panel.root.querySelector('.profile-usage'),toggle=section.querySelector('input');
    assert.equal(section.hidden,false);assert.match(panel.root.querySelector('.conversation').textContent,/합성 안내/);
    toggle.click();await settle();assert.equal(section.querySelector('.profile-usage-value').textContent,'ON');
    panel.root.querySelector('.collapse').click();panel.root.querySelector('.collapse').click();await settle();
    assert.equal(section.closest('[hidden]'),null);assert.equal(section.hidden,false);assert.equal(toggle.checked,true);
    assert.equal((await set(f,1,false)).ok,true);await settle();assert.equal(section.hidden,false);assert.equal(toggle.checked,false);assert.equal(section.querySelector('.profile-usage-value').textContent,'OFF');
    assert.equal(panel.ports.length,0);
  }finally{panel.close();}
});

test('로컬 정보 없음은 서버 지원 응답을 기다리지 않고 안내하며 동의를 덮지 않는다',async()=>{
  let release;const pending=new Promise(resolve=>{release=resolve;}),data={[profileKey]:profile,[usageKey]:{schemaVersion:1,revision:1,enabled:true,profileRevision:1}};
  const f=worker(data,{},undefined,async()=>{await pending;return new Response(JSON.stringify({profile_context_supported:true}));}),panel=ui(f);
  try{
    await panel.ready();const section=panel.root.querySelector('.profile-usage');
    assert.match(section.querySelector('.profile-usage-status').textContent,/저장된 내 정보가 없습니다/);assert.doesNotMatch(section.textContent,/확인 중/);
    assert.equal(section.querySelector('input').checked,false);assert.equal(section.querySelector('input').disabled,true);assert.equal(data[usageKey].enabled,true);
  }finally{release();panel.close();}
});

test('유실된 정보 사용 응답은5초 실패·재확인으로 회복하고 지연 응답과 저장ON을 보존한다',async()=>{
  const record={schemaVersion:1,revision:1,enabled:true,profileRevision:1},f=server({[profileKey]:savedProfile,[usageKey]:record});let expire,release,lost=true;
  const panel=ui(f,1,w=>{expire=readDeadlines(w);const send=w.chrome.runtime.sendMessage;w.chrome.runtime.sendMessage=message=>message.type==='gyeote:profile-usage-get'&&lost?new Promise(resolve=>{release=resolve;}):send(message);});
  try{
    await panel.ready();const section=panel.root.querySelector('.profile-usage'),status=section.querySelector('.profile-usage-status');assert.match(status.textContent,/확인 중/);
    await panel.question('정보 없이 보낼 합성 질문');assert.equal(Object.hasOwn(panel.ports.at(-1).packet.payload,'profile_context'),false);
    expire();await settle();assert.doesNotMatch(status.textContent,/확인 중/);assert.match(status.textContent,/시간|응답/);
    const error=status.textContent;release({ok:true,state:record,supported:true,valid:true});await settle();assert.equal(status.textContent,error);assert.deepEqual(f.data[usageKey],record);
    await panel.click('다시 확인');assert.match(status.textContent,/확인 중/);assert.equal(section.querySelector('.profile-usage-retry').disabled,true);
    release({ok:true,state:record,supported:true,valid:true});await settle();assert.equal(section.querySelector('.profile-usage-retry').hidden,true);assert.equal(section.querySelector('input').checked,true);assert.deepEqual(f.data[usageKey],record);
  }finally{panel.close();}
});

test('로컬 정보 읽기 응답 유실은 없음으로 오인하지 않고 재조회 뒤 옛 응답을 버린다',async()=>{
  const f=server();let expire,release,lost=true;
  const panel=ui(f,1,w=>{expire=readDeadlines(w);const send=w.chrome.runtime.sendMessage;w.chrome.runtime.sendMessage=message=>message.type==='gyeote:profile-get'&&lost?new Promise(resolve=>{release=resolve;}):send(message);});
  try{
    await panel.ready();expire();await settle();const status=panel.root.querySelector('.profile-usage-status');
    assert.doesNotMatch(status.textContent,/확인 중|저장된 내 정보가 없습니다/);assert.match(status.textContent,/내 정보.*확인하지 못/);
    lost=false;await panel.click('최신 정보 다시 불러오기');release({ok:true,state:{...savedProfile,profile:{...values,age:10}}});await settle();
    assert.match(panel.root.querySelector('.profile-panel').textContent,/72세/);assert.doesNotMatch(panel.root.querySelector('.profile-panel').textContent,/10세/);
    await panel.click('설정 닫기');assert.equal(panel.root.querySelector('.profile-usage-toggle').disabled,false);assert.deepEqual(f.data[profileKey],savedProfile);
  }finally{panel.close();}
});

test('지연 지원 확인 중 등록·삭제 통지가 오면 최신 로컬 없음 상태를 바로 표시한다',async()=>{
  let release;const pending=new Promise(resolve=>{release=resolve;}),f=worker({[profileKey]:profile},{},undefined,async()=>{await pending;return new Response(JSON.stringify({profile_context_supported:true}));}),panel=ui(f);
  try{
    await panel.ready();const status=panel.root.querySelector('.profile-usage-status');assert.match(status.textContent,/저장된 내 정보가 없습니다/);
    assert.equal((await f.send({type:'gyeote:profile-save',expectedRevision:1,profile:values})).ok,true);await settle();assert.doesNotMatch(status.textContent,/저장된 내 정보가 없습니다/);
    assert.equal((await f.send({type:'gyeote:profile-clear',expectedRevision:2})).ok,true);await settle();assert.match(status.textContent,/저장된 내 정보가 없습니다/);
    release();await settle();assert.match(status.textContent,/저장된 내 정보가 없습니다/);assert.equal(panel.ports.length,0);
  }finally{release();panel.close();}
});

test('ON DTO는 동의·revision·허용 프로필 없이는 만들지 않으며 원래 profile 필드는 계속 무시한다',()=>{
  assert.deepEqual(protocol.documentRequest({query:'질문',profile_context:consent(1)}).profile_context,consent(1));
  assert.equal(Object.hasOwn(protocol.documentRequest({query:'질문',profile:values}),'profile_context'),false);
  for(const change of [{enabled:false},{consent_revision:-1},{profile_revision:true},{profile:{...values,name:'이름'}},{profile:null}])assert.throws(()=>protocol.documentRequest({query:'질문',profile_context:{...consent(1),...change}}));
});

test('offscreen은 전송 전과 표시 전 동의를 다시 확인하고 변경 뒤 원래 답변을 내보내지 않는다',async()=>{
  for(const stage of ['valid','before','after']){
    let connect,receive,reads=0;const sent=[],calls=[],context=consent(1);
    const chrome={runtime:{id:'x',onMessage:{addListener(){}},onConnect:{addListener(fn){connect=fn;}},sendMessage:async message=>{
      if(message.type==='gyeote:profile-context'){reads++;return {ok:true,context:stage==='before'||stage==='after'&&reads>1?null:context};}
      return {mode:'anonymous',accessId:'public-1',origin:protocol.documentOrigin()};
    }}};
    vm.runInNewContext(source('offscreen.js'),{chrome,GyeoteProtocol:protocol,AbortController,setTimeout,clearTimeout,Uint8Array,TextDecoder,Blob,fetch:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(answer));}});
    connect({name:'gyeote:guide',sender:{id:'x',frameId:0,url:'https://www.bokjiro.go.kr/',tab:{url:'https://www.bokjiro.go.kr/'}},postMessage:value=>sent.push(value),disconnect(){},onMessage:{addListener(fn){receive=fn;}},onDisconnect:{addListener(){}}});
    await receive({requestId:id(1),mode:'document',documentAccess:'anonymous:anonymous:public-1',payload:{query:'질문',profile_context:context}});
    if(stage==='valid'){assert.equal(sent[0].type,'result');assert.deepEqual(JSON.parse(calls[0].options.body).profile_context,context);}
    else{assert.equal(sent[0].error,'profile_changed');assert.equal(calls.length,stage==='before'?0:1);}
  }
});

test('저장된 ON·OFF는 capabilities가 미응답이어도 즉시 표시하며 새 동의를 만들지 않는다',async()=>{
 for(const enabled of [false,true]){
  let release,calls=0;const pending=new Promise(resolve=>{release=resolve;});
  const usage={schemaVersion:1,revision:2,enabled,profileRevision:enabled?1:null},data={[profileKey]:savedProfile,[usageKey]:usage};
  const f=worker(data,{},undefined,async url=>{if(url.endsWith('/api/v1/chat/capabilities')){calls++;await pending;}return new Response(JSON.stringify({profile_context_supported:true,available:true,version:1}));}),panel=ui(f);
  try{
   await panel.ready();const toggle=panel.root.querySelector('.profile-usage-toggle');assert.equal(toggle.checked,enabled);assert.equal(toggle.disabled,false);assert.equal(panel.root.querySelector('.profile-usage-value').textContent,enabled?'ON':'OFF');
   assert.deepEqual(data[usageKey],usage);assert.equal((await get(f)).valid,enabled);const before=calls;
   await get(f);await get(f);assert.equal(calls,before);assert.equal(f.calls.set.some(value=>usageKey in value),false);
  }finally{release();panel.close();}
 }
});
