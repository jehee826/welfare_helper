const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {worker,ui,key,profileKey,profile,answer,activeBoundary,source,settle}=require('./conversation_fixture.cjs');
const protocol=require('../protocol.js'),policy=require('../conversations.js');
const displayKey='gyeote.displaySummary';
const id=value=>value.toString(16).toUpperCase().padStart(20,'0');
function seed(count=2){
  const date=new Date().toISOString(),messages=[];
  for(let index=1;index<=count;index++)messages.push(...policy.pair(id(index),'질문 '+index,{...answer,text:'당시 안내 '+index},0,date));
  return {[profileKey]:profile,[key]:{...policy.empty(),revision:1,lastActiveConversationId:'continuous',conversations:[{id:'continuous',createdAt:date,updatedAt:date,messages,contextBoundary:activeBoundary()}]}};
}
function fixture(data=seed(),available=true){
  const server=worker(data,{},undefined,async url=>{
    assert.equal(url,protocol.documentOrigin()+'/api/v1/conversation/summary');
    return new Response(JSON.stringify({available,version:1}),{status:available?200:404});
  });
  return {...ui(server),server};
}
const button=f=>f.root.querySelector('.consultation-summary'),result=f=>f.root.querySelector('.consultation-summary-result');
const reply=port=>({request_id:port.packet.requestId,text:'당시 상담한 서비스와 남은 확인사항입니다.',source_message_ids:port.packet.payload.messages.map(message=>message.id),partial:port.packet.payload.partial});

test('서버 지원 확인 뒤 공개 상담에만 요약을 제공하고 이전 서버·빈 상담에서는 실행하지 않는다',async()=>{
  for(const available of [false,true]){
    const f=fixture(undefined,available);
    try{await f.ready();assert.equal(button(f).parentElement.hidden,!available);if(available){await f.mode('screen');assert.equal(button(f).parentElement.hidden,true);}}
    finally{f.close();}
  }
  const f=fixture({[profileKey]:profile});try{await f.ready();assert.equal(button(f).disabled,true);button(f).click();await settle();assert.equal(f.ports.length,0);}finally{f.close();}
});

test('현재 주제·시간 경계 뒤 완전 문답만 보내며 표시 요약을 RAG에 넣지 않는다',async()=>{
  const data=seed(3),conversation=data[key].conversations[0];conversation.messages[3].topicStart=true;conversation.contextBoundary.startAfterPairId=id(2);
  const f=fixture(data);
  try{
    await f.ready();const original=JSON.stringify(data[key]);button(f).click();await settle();const port=f.ports.at(-1);assert.equal(port.packet.mode,'summary');
    assert.deepEqual(port.packet.payload.messages.map(message=>message.content),['질문 3','당시 안내 3']);
    assert.deepEqual(Object.keys(port.packet.payload).sort(),['messages','partial','request_id']);
    await f.answer(reply(port),port);assert.equal(result(f).hidden,false);assert.match(result(f).textContent,/이전 상담 요약/);
    assert.equal(JSON.stringify(data[key]),original);assert.equal(f.root.querySelector('.conversation').textContent.includes('남은 확인사항'),false);
    await f.question('후속 질문');assert.equal(result(f).hidden,true);assert.doesNotMatch(JSON.stringify(f.ports.at(-1).packet.payload),/남은 확인사항/);
  }finally{f.close();}
});

test('요약 중 질문·중복 클릭을 막되 초안을 보존하고 닫은 뒤 늦은 결과는 폐기한다',async()=>{
  const f=fixture();
  try{
    await f.ready();const input=f.root.querySelector('#gyeote-question');input.value='작성 중 초안';button(f).click();await settle();const port=f.ports.at(-1);
    assert.equal(f.root.querySelector('button[type=submit]').disabled,true);button(f).click();await settle();assert.equal(f.ports.length,1);
    input.closest('form').dispatchEvent(new f.w.Event('submit',{cancelable:true}));assert.equal(input.value,'작성 중 초안');
    await f.click('요약 취소');assert.equal(result(f).hidden,true);assert.equal(f.root.querySelector('button[type=submit]').disabled,false);
    await f.answer(reply(port),port);assert.equal(result(f).hidden,true);assert.equal(input.value,'작성 중 초안');
  }finally{f.close();}
});

test('12000자 한도는 최근 완전쌍만 선택하고 한 쌍도 못 담으면 모델 포트를 열지 않는다',async()=>{
  for(const oversized of [false,true]){
    const data=seed(oversized?1:30),messages=data[key].conversations[0].messages;
    for(const message of messages)message.content=message.role==='user'?'가'.repeat(300):'나'.repeat(oversized?12001:1000);
    const f=fixture(data);
    try{
      await f.ready();button(f).click();await settle();
      if(oversized){assert.equal(f.ports.length,0);assert.match(result(f).textContent,/한 문답의 길이/);}
      else{
        const port=f.ports.at(-1),payload=port.packet.payload;assert.equal(payload.messages.length,18);assert.equal(payload.partial,true);
        assert.equal(payload.messages.reduce((sum,message)=>sum+message.content.length,0),11700);
        await f.answer(reply(port),port);assert.match(result(f).textContent,/보관된 최근 상담 일부 요약/);
      }
    }finally{f.close();}
  }
});

test('7일 경계를 지난 요약은 과거 문답을 전송하거나 사용자 전송 시간을 연장하지 않는다',async()=>{
  const data=seed(),c=data[key].conversations[0];c.contextBoundary.lastUserSubmittedAt=new Date(Date.now()-policy.limits.contextAge-1000).toISOString();
  const original=JSON.stringify(data[key]),f=fixture(data);
  try{await f.ready();button(f).click();await settle();assert.equal(f.ports.length,0);assert.match(result(f).textContent,/7일 이상/);assert.equal(JSON.stringify(data[key]),original);}
  finally{f.close();}
});

for(const ending of ['profile','mode','delete','pagehide'])test(`요약 생성 중 ${ending} 변경은 늦은 결과를 표시하지 않는다`,async()=>{
  const f=fixture();
  try{
    await f.ready();button(f).click();await settle();const port=f.ports.at(-1);
    if(ending==='profile')f.notify({type:'gyeote:profile-changed',revision:2});
    if(ending==='mode')await f.mode('screen');
    if(ending==='delete'){await f.click('전체 대화 삭제');await f.click('삭제 확인');}
    if(ending==='pagehide')f.w.dispatchEvent(new f.w.Event('pagehide'));
    await settle();await f.answer(reply(port),port);assert.equal(result(f).hidden,true);
    assert.notEqual(f.root.querySelector('.conversation').textContent,'당시 상담한 서비스와 남은 확인사항입니다.');
  }finally{f.close();}
});

test('마지막 성공 요약은 F5와 worker 재생성 뒤 서버 응답과 무관하게 복원한다',async()=>{
  const f=fixture();let saved;
  try{await f.ready();button(f).click();await settle();await f.answer(reply(f.ports.at(-1)));assert.equal(result(f).hidden,false);saved=JSON.parse(JSON.stringify(f.server.data[displayKey]));}
  finally{f.close();}
  let release;const pending=new Promise(resolve=>{release=resolve;});
  const server=worker(f.server.data,{},undefined,async()=>{await pending;return new Response('{}',{status:404});}),restored=ui(server);
  try{
    await restored.ready();assert.equal(result(restored).hidden,false);assert.match(result(restored).textContent,/남은 확인사항/);
    assert.match(restored.root.querySelector('.conversation').textContent,/질문 1/);assert.deepEqual(server.data[displayKey],saved);
    assert.deepEqual(Object.keys(saved).sort(),['conversationId','generation','partial','revision','schemaVersion','text']);
  }finally{release();restored.close();}
});

test('요약 닫기는 저장본을 유지하고 새 성공만 마지막 요약을 교체한다',async()=>{
  const f=fixture();
  try{
    await f.ready();button(f).click();await settle();await f.answer({...reply(f.ports.at(-1)),text:'첫 성공 요약'});
    const saved=JSON.stringify(f.server.data[displayKey]);await f.click('요약 닫기');assert.equal(result(f).hidden,true);assert.equal(JSON.stringify(f.server.data[displayKey]),saved);
    f.notify({type:'gyeote:display-summary-changed'});await settle();assert.equal(result(f).hidden,true);
    button(f).click();await settle();await f.answer({...reply(f.ports.at(-1)),text:'다음 성공 요약'});
    assert.equal(f.server.data[displayKey].text,'다음 성공 요약');assert.equal(f.server.data[displayKey].revision,2);
    await f.mode('screen');await f.mode('document');assert.equal(result(f).hidden,false);assert.match(result(f).textContent,/다음 성공/);
  }finally{f.close();}
});

test('요약 취소·모델 오류·저장 실패는 이전 성공본을 덮지 않는다',async()=>{
  const f=fixture();
  try{
    await f.ready();button(f).click();await settle();await f.answer({...reply(f.ports.at(-1)),text:'유지할 성공 요약'});
    const saved=JSON.stringify(f.server.data[displayKey]);
    button(f).click();await settle();const old=f.ports.at(-1);await f.click('요약 취소');await f.answer(reply(old),old);assert.equal(JSON.stringify(f.server.data[displayKey]),saved);
    button(f).click();await settle();await f.answer({},f.ports.at(-1),'error');assert.equal(JSON.stringify(f.server.data[displayKey]),saved);
    button(f).click();await settle();f.server.failure.set=true;await f.answer({...reply(f.ports.at(-1)),text:'저장 실패한 새 요약'});
    assert.equal(JSON.stringify(f.server.data[displayKey]),saved);assert.match(f.root.querySelector('.status').textContent,/요약을 저장하지 못/);
  }finally{f.server.failure.set=false;f.close();}
});

test('두 탭의 늦은 요약은 먼저 저장된 새 성공본을 덮지 않는다',async()=>{
  const f=fixture(),other=ui(f.server,2);
  try{
    await f.ready();await other.ready();button(f).click();button(other).click();await settle();
    const old=f.ports.at(-1),latest=other.ports.at(-1);
    await other.answer({...reply(latest),text:'다른 탭에서 저장한 요약'},latest);
    await f.answer({...reply(old),text:'늦게 도착한 이전 요약'},old);
    assert.equal(f.server.data[displayKey].text,'다른 탭에서 저장한 요약');assert.equal(f.server.data[displayKey].revision,1);
  }finally{f.close();other.close();}
});

test('대화 삭제는 표시 요약을 함께 지우고 이전 세대의 늦은 요약을 저장하지 않는다',async()=>{
  const f=fixture();
  try{
    await f.ready();button(f).click();await settle();await f.answer(reply(f.ports.at(-1)));
    button(f).click();await settle();const old=f.ports.at(-1);
    await f.click('전체 대화 삭제');await f.click('삭제 확인');await f.answer(reply(old),old);
    assert.equal(f.server.data[displayKey],null);assert.equal(result(f).hidden,true);
    const restored=ui(f.server,2);try{await restored.ready();assert.equal(result(restored).hidden,true);}finally{restored.close();}
  }finally{f.close();}
});

test('저장 요약은 다른 대화·세대와 관리자 접근에 노출하지 않는다',async()=>{
  const f=fixture();
  try{
    await f.ready();button(f).click();await settle();await f.answer(reply(f.ports.at(-1)));
    const saved=JSON.stringify(f.server.data[displayKey]);f.server.data[displayKey].generation='another-generation';
    const other=ui(f.server,2);try{await other.ready();assert.equal(result(other).hidden,true);}finally{other.close();}
    f.server.data[displayKey]=JSON.parse(saved);f.server.session.documentAccess='admin';f.server.session.documentAccessId='admin';
    const admin=ui(f.server,3);try{await admin.ready();assert.equal(result(admin).hidden,true);assert.equal(admin.ports.length,0);}finally{admin.close();}
  }finally{f.close();}
});

test('준비 응답이 10초 기한 뒤 도착해도 요약 포트를 열거나 초안을 지우지 않는다',async()=>{
  const f=fixture();let deadline,release;
  try{
    await f.ready();const send=f.w.chrome.runtime.sendMessage,set=f.w.setTimeout.bind(f.w);
    f.w.setTimeout=(fn,ms,...args)=>ms===10000?(deadline=fn,999997):set(fn,ms,...args);
    f.w.chrome.runtime.sendMessage=message=>message.type==='gyeote:prepare'?new Promise(resolve=>{release=()=>send(message).then(resolve);}):send(message);
    const input=f.root.querySelector('#gyeote-question');input.value='작성 중 초안';button(f).click();await settle();assert.equal(typeof release,'function');
    deadline();release();await settle();assert.equal(f.ports.length,0);assert.equal(input.value,'작성 중 초안');
    assert.equal(f.root.querySelector('button[type=submit]').disabled,false);assert.match(result(f).textContent,/연결하지 못|확인하지 못/);
  }finally{release?.();f.close();}
});

test('요약 응답은 요청 ID·완전쌍 source IDs·부분 표시·출력 한도를 검증한다',()=>{
  const input=protocol.summaryRequest({request_id:id(100),messages:seed()[key].conversations[0].messages.map(({id,role,content})=>({id,role,content})),partial:false});
  const good={request_id:input.request_id,text:'이전 상담 요약',source_message_ids:input.messages.map(message=>message.id),partial:false};
  assert.deepEqual(protocol.summaryReply(good,input),good);
  for(const change of [{request_id:id(101)},{source_message_ids:['invented']},{source_message_ids:good.source_message_ids.slice(1)},{text:'가'.repeat(1201)}])assert.throws(()=>protocol.summaryReply({...good,...change},input));
  assert.throws(()=>protocol.summaryRequest({...input,profile:{age:70}}));
  assert.throws(()=>protocol.summaryRequest({...input,messages:[{...input.messages[0],content:'010-0000-0000'},input.messages[1]]}));
});

test('offscreen은 고정 공개 요약 경로로만 보내고 관리자 세션에서는 전송하지 않는다',async()=>{
  for(const admin of [false,true]){
    let connect,receive;const sent=[],calls=[];
    const chrome={runtime:{id:'x',onMessage:{addListener(){}},onConnect:{addListener(fn){connect=fn;}},sendMessage:async()=>({mode:admin?'admin':'anonymous',accessId:'public-1',origin:protocol.documentOrigin()})}};
    const input={request_id:id(100),messages:seed(1)[key].conversations[0].messages.map(({id,role,content})=>({id,role,content})),partial:false};
    vm.runInNewContext(source('offscreen.js'),{chrome,GyeoteProtocol:protocol,AbortController,setTimeout,clearTimeout,Uint8Array,TextDecoder,Blob,fetch:async(url,options)=>{
      calls.push({url,options});const body=JSON.parse(options.body);return new Response(JSON.stringify({request_id:body.request_id,text:'당시 상담 요약',source_message_ids:body.messages.map(message=>message.id),partial:false}));
    }});
    connect({name:'gyeote:guide',sender:{id:'x',frameId:0,url:'https://www.bokjiro.go.kr/',tab:{url:'https://www.bokjiro.go.kr/'}},postMessage:packet=>sent.push(packet),disconnect(){},onMessage:{addListener(fn){receive=fn;}},onDisconnect:{addListener(){}}});
    await receive({requestId:input.request_id,mode:'summary',payload:input,documentAccess:'anonymous:anonymous:public-1'});
    if(admin){assert.equal(calls.length,0);assert.equal(sent[0].error,'summary_public_only');}
    else{assert.equal(calls.length,1);assert.equal(calls[0].url,protocol.documentOrigin()+'/api/v1/conversation/summary');assert.equal(calls[0].options.headers.Authorization,undefined);assert.equal(sent[0].type,'result');}
  }
});
