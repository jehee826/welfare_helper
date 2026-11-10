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
function fixture(data=seed()){
 const server=worker(data);return {...ui(server),server};
}
const button=f=>f.root.querySelector('.consultation-summary'),result=f=>f.root.querySelector('.consultation-summary-result'),run=f=>f.root.querySelector('.summary-run');
const reply=port=>({request_id:port.packet.requestId,text:'당시 상담한 서비스와 남은 확인사항입니다.',source_message_ids:port.packet.payload.messages.map(message=>message.id),partial:port.packet.payload.partial});
async function generate(f){button(f).click();await settle();run(f).click();await settle();}

test('요약 버튼은 내 정보 왼쪽에서 항상 창을 열고 생성은 창 안의 버튼으로 시작한다',async()=>{
 for(const data of [seed(),{[profileKey]:profile}]){
  const f=fixture(data);try{
   await f.ready();const summary=button(f),header=f.root.querySelector('.head');assert.equal(summary.parentElement,header);assert.equal(summary.nextElementSibling,f.root.querySelector('.profile-toggle'));assert.equal(summary.hidden,false);assert.equal(summary.disabled,false);assert.equal(f.root.querySelector('.summary-tools'),null);
   summary.click();await settle();assert.equal(result(f).hidden,false);assert.equal(f.ports.length,0);assert.equal(run(f).disabled,!data[key]);assert.equal(f.requests.some(m=>m.type==='gyeote:summary-capability'),false);
   await f.click('요약 창 닫기');assert.equal(result(f).hidden,true);await f.mode('screen');assert.equal(summary.disabled,false);summary.click();await settle();assert.equal(result(f).hidden,false);assert.equal(f.ports.length,0);
  }finally{f.close();}
 }
 const server=worker(seed());server.session.documentAccess='admin';server.session.documentAccessId='legacy';const f=ui(server);
 try{await f.ready();assert.equal(button(f).disabled,false);await generate(f);assert.equal(f.ports.at(-1).packet.documentAccess,'anonymous:anonymous:legacy');}finally{f.close();}
});

test('별도 요약 지원 조회 없이 보관 대화로 요청을 준비한다',async()=>{
 const urls=[],server=worker(seed(),{},undefined,async url=>{urls.push(url);throw Error('합성 공개 설정 조회 실패');}),f=ui(server);
 try{await f.ready();button(f).click();await settle();assert.equal(f.ports.length,0);run(f).click();await settle();assert.equal(f.ports.length,1);assert.equal(f.requests.some(m=>m.type==='gyeote:summary-capability'),false);assert.equal(urls.some(url=>url.endsWith('/conversation/summary')),false);await f.answer(reply(f.ports[0]));assert.ok(server.data[displayKey]);}finally{f.close();}
});

test('요약창 열기는 진행 중 질문과 초안을 취소하지 않고 실행 버튼도 다른 질문에 묶이지 않는다',async()=>{
 const f=fixture();try{await f.ready();await f.question('진행 중 질문');const documentPort=f.ports.at(-1),input=f.root.querySelector('#gyeote-question');input.value='다음 초안';button(f).click();await settle();assert.notEqual(documentPort.disconnected,true);assert.equal(input.value,'다음 초안');assert.equal(result(f).hidden,false);assert.equal(run(f).disabled,false);assert.equal(f.ports.length,1);}finally{f.close();}
});

test('준비 응답을 기다리다 취소하면 늦은 응답은 포트와 저장 요약을 만들지 않는다',async()=>{
 const f=fixture();let release;try{
  await f.ready();const send=f.w.chrome.runtime.sendMessage;f.w.chrome.runtime.sendMessage=message=>message.type==='gyeote:prepare'&&message.mode==='summary'?new Promise(resolve=>{release=()=>send(message).then(resolve);}):send(message);
  const input=f.root.querySelector('#gyeote-question');input.value='작성 중 초안';await generate(f);assert.equal(typeof release,'function');assert.equal(run(f).disabled,true);assert.equal(button(f).disabled,false);await f.click('요약 취소');release();release=null;await settle();assert.equal(f.ports.length,0);assert.equal(f.server.data[displayKey],undefined);assert.equal(input.value,'작성 중 초안');assert.equal(result(f).hidden,false);
 }finally{release?.();f.close();}
});

test('수동 요약은 주제 경계 앞뒤 전체 보관 문답을 보내며 표시 요약은 RAG에 넣지 않는다',async()=>{
 const data=seed(3),conversation=data[key].conversations[0];conversation.messages[3].topicStart=true;conversation.contextBoundary.startAfterPairId=id(2);const f=fixture(data);
 try{await f.ready();const original=JSON.stringify(data[key]);await generate(f);const port=f.ports.at(-1);assert.equal(port.packet.mode,'summary');assert.deepEqual(port.packet.payload.messages.map(message=>message.content),['질문 1','당시 안내 1','질문 2','당시 안내 2','질문 3','당시 안내 3']);assert.deepEqual(Object.keys(port.packet.payload).sort(),['messages','partial','request_id']);await f.answer(reply(port),port);assert.match(result(f).textContent,/당시 상담한 서비스/);assert.equal(JSON.stringify(data[key]),original);assert.doesNotMatch(f.root.querySelector('.conversation').textContent,/남은 확인사항/);await f.click('요약 창 닫기');await f.question('후속 질문');assert.doesNotMatch(JSON.stringify(f.ports.at(-1).packet.payload),/남은 확인사항/);}finally{f.close();}
});

test('요약 중 중복 생성과 질문을 막고 취소·창 닫기 뒤 늦은 결과를 버리며 초안을 보존한다',async()=>{
 const f=fixture();try{await f.ready();const input=f.root.querySelector('#gyeote-question');input.value='작성 중 초안';await generate(f);const port=f.ports.at(-1);assert.equal(f.root.querySelector('button[type=submit]').disabled,true);assert.equal(run(f).disabled,true);button(f).click();run(f).click();await settle();assert.equal(f.ports.length,1);input.closest('form').dispatchEvent(new f.w.Event('submit',{cancelable:true}));assert.equal(input.value,'작성 중 초안');await f.click('요약 취소');assert.equal(result(f).hidden,false);assert.equal(run(f).disabled,false);assert.equal(f.root.querySelector('button[type=submit]').disabled,false);await f.click('요약 창 닫기');await f.answer(reply(port),port);assert.equal(result(f).hidden,true);assert.equal(input.value,'작성 중 초안');assert.equal(f.server.data[displayKey],undefined);}finally{f.close();}
});

test('12000자 한도는 최근 완전쌍만 선택하고 한 쌍도 못 담으면 모델 포트를 열지 않는다',async()=>{
 for(const oversized of [false,true]){
  const data=seed(oversized?1:30),messages=data[key].conversations[0].messages;for(const message of messages)message.content=message.role==='user'?'가'.repeat(300):'나'.repeat(oversized?12001:1000);const f=fixture(data);
  try{await f.ready();await generate(f);if(oversized){assert.equal(f.ports.length,0);assert.match(result(f).textContent,/한 문답의 길이/);}else{const port=f.ports.at(-1),payload=port.packet.payload;assert.equal(payload.messages.length,18);assert.equal(payload.partial,true);assert.equal(payload.messages.reduce((sum,message)=>sum+message.content.length,0),11700);await f.answer(reply(port),port);assert.match(result(f).textContent,/보관된 최근 상담 일부 요약/);}}finally{f.close();}
 }
});

test('7일 지난 보관 문답도 수동 요약하며 자동 맥락의 마지막 전송 시간은 연장하지 않는다',async()=>{
 const data=seed(),c=data[key].conversations[0];c.contextBoundary.lastUserSubmittedAt=new Date(Date.now()-policy.limits.contextAge-1000).toISOString();const original=JSON.stringify(data[key]),f=fixture(data);
 try{await f.ready();await generate(f);assert.equal(f.ports.at(-1).packet.payload.messages.length,4);assert.equal(JSON.stringify(data[key]),original);}finally{f.close();}
});

for(const ending of ['profile','mode','delete','pagehide'])test(`요약 생성 중 ${ending} 변경은 늦은 결과를 표시·저장하지 않는다`,async()=>{
 const f=fixture();try{
  await f.ready();await generate(f);const port=f.ports.at(-1);
  if(ending==='profile')f.notify({type:'gyeote:profile-changed',revision:2});
  if(ending==='mode')await f.mode('screen');
  if(ending==='delete'){await f.click('요약 창 닫기');await f.click('내 정보');await f.click('전체 대화 삭제');await f.click('삭제 확인');}
  if(ending==='pagehide')f.w.dispatchEvent(new f.w.Event('pagehide'));
  await settle();await f.answer(reply(port),port);assert.doesNotMatch(result(f).textContent,/당시 상담한 서비스와 남은 확인사항/);assert.equal(f.server.data[displayKey]??null,null);
 }finally{f.close();}
});

test('마지막 성공 요약은 F5와 worker 재생성 뒤 창을 열면 서버 응답 없이 복원한다',async()=>{
 const f=fixture();let saved;try{await f.ready();await generate(f);await f.answer(reply(f.ports.at(-1)));saved=JSON.parse(JSON.stringify(f.server.data[displayKey]));}finally{f.close();}
 let release;const pending=new Promise(resolve=>{release=resolve;}),server=worker(f.server.data,{},undefined,async()=>{await pending;return new Response('{}',{status:404});}),restored=ui(server);
 try{await restored.ready();assert.equal(result(restored).hidden,true);button(restored).click();await settle();assert.equal(result(restored).hidden,false);assert.match(result(restored).textContent,/남은 확인사항/);assert.equal(restored.ports.length,0);assert.match(restored.root.querySelector('.conversation').textContent,/질문 1/);assert.deepEqual(server.data[displayKey],saved);assert.deepEqual(Object.keys(saved).sort(),['conversationId','generation','partial','revision','schemaVersion','text']);}finally{release();restored.close();}
});

test('창 닫기·다시 열기는 저장본을 유지하고 새 생성 성공만 마지막 요약을 교체한다',async()=>{
 const f=fixture();try{
  await f.ready();await generate(f);await f.answer({...reply(f.ports.at(-1)),text:'첫 성공 요약'});const saved=JSON.stringify(f.server.data[displayKey]);await f.click('요약 창 닫기');assert.equal(result(f).hidden,true);f.notify({type:'gyeote:display-summary-changed'});await settle();assert.equal(result(f).hidden,true);button(f).click();await settle();assert.match(result(f).textContent,/첫 성공/);assert.equal(f.ports.length,1);assert.equal(JSON.stringify(f.server.data[displayKey]),saved);
  run(f).click();await settle();await f.answer({...reply(f.ports.at(-1)),text:'다음 성공 요약'});assert.equal(f.server.data[displayKey].text,'다음 성공 요약');assert.equal(f.server.data[displayKey].revision,2);await f.mode('screen');await f.mode('document');assert.equal(result(f).hidden,true);button(f).click();await settle();assert.match(result(f).textContent,/다음 성공/);
 }finally{f.close();}
});

test('요약 취소·모델 오류·저장 실패는 이전 성공본을 덮지 않는다',async()=>{
 const f=fixture();try{await f.ready();await generate(f);await f.answer({...reply(f.ports.at(-1)),text:'유지할 성공 요약'});const saved=JSON.stringify(f.server.data[displayKey]);await generate(f);const old=f.ports.at(-1);await f.click('요약 취소');await f.answer(reply(old),old);assert.equal(JSON.stringify(f.server.data[displayKey]),saved);await generate(f);await f.answer({},f.ports.at(-1),'error');assert.equal(JSON.stringify(f.server.data[displayKey]),saved);await generate(f);f.server.failure.set=true;await f.answer({...reply(f.ports.at(-1)),text:'저장 실패한 새 요약'});assert.equal(JSON.stringify(f.server.data[displayKey]),saved);assert.match(f.root.querySelector('.status').textContent,/요약을 저장하지 못/);}finally{f.server.failure.set=false;f.close();}
});

test('두 탭의 늦은 요약은 먼저 저장된 새 성공본을 덮지 않는다',async()=>{
 const f=fixture(),other=ui(f.server,2);try{await f.ready();await other.ready();await generate(f);await generate(other);const old=f.ports.at(-1),latest=other.ports.at(-1);await other.answer({...reply(latest),text:'다른 탭에서 저장한 요약'},latest);await f.answer({...reply(old),text:'늦게 도착한 이전 요약'},old);assert.equal(f.server.data[displayKey].text,'다른 탭에서 저장한 요약');assert.equal(f.server.data[displayKey].revision,1);}finally{f.close();other.close();}
});

test('대화 삭제는 표시 요약을 함께 지우고 이전 세대의 늦은 요약을 저장하지 않는다',async()=>{
 const f=fixture();try{await f.ready();await generate(f);await f.answer(reply(f.ports.at(-1)));await generate(f);const old=f.ports.at(-1);await f.click('요약 창 닫기');await f.click('내 정보');await f.click('전체 대화 삭제');await f.click('삭제 확인');await f.answer(reply(old),old);assert.equal(f.server.data[displayKey],null);assert.equal(result(f).hidden,true);const restored=ui(f.server,2);try{await restored.ready();button(restored).click();await settle();assert.doesNotMatch(result(restored).textContent,/당시 상담한 서비스/);}finally{restored.close();}}finally{f.close();}
});

test('저장 요약은 다른 대화·세대에 섞지 않고 옛 관리자 선택에는 가리지 않는다',async()=>{
 const f=fixture();try{await f.ready();await generate(f);await f.answer(reply(f.ports.at(-1)));const saved=JSON.stringify(f.server.data[displayKey]);
  for(const field of ['generation','conversationId']){f.server.data[displayKey]={...JSON.parse(saved),[field]:'another'};const other=ui(f.server,2);try{await other.ready();button(other).click();await settle();assert.doesNotMatch(result(other).textContent,/남은 확인사항/);}finally{other.close();}}
  f.server.data[displayKey]=JSON.parse(saved);f.server.session.documentAccess='admin';f.server.session.documentAccessId='legacy';const restored=ui(f.server,3);try{await restored.ready();button(restored).click();await settle();assert.match(result(restored).textContent,/남은 확인사항/);assert.equal(restored.ports.length,0);}finally{restored.close();}
 }finally{f.close();}
});

test('prepare 응답이10초 기한 뒤 도착해도 요약 포트를 열거나 초안을 지우지 않는다',async()=>{
 const f=fixture();let deadline,release;try{
  await f.ready();const send=f.w.chrome.runtime.sendMessage,set=f.w.setTimeout.bind(f.w);f.w.setTimeout=(fn,ms,...args)=>ms===10000?(deadline=fn,999997):set(fn,ms,...args);f.w.chrome.runtime.sendMessage=message=>message.type==='gyeote:prepare'?new Promise(resolve=>{release=()=>send(message).then(resolve);}):send(message);
  const input=f.root.querySelector('#gyeote-question');input.value='작성 중 초안';await generate(f);assert.equal(typeof release,'function');deadline();release();release=null;await settle();assert.equal(f.ports.length,0);assert.equal(input.value,'작성 중 초안');assert.equal(f.root.querySelector('button[type=submit]').disabled,false);assert.match(result(f).textContent,/연결하지 못|확인하지 못/);
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

test('offscreen은 고정 공개 요약 경로로만 보내고 비익명 접근은 거절한다',async()=>{
  for(const admin of [false,true]){
    let connect,receive;const sent=[],calls=[];
    const chrome={runtime:{id:'x',onMessage:{addListener(){}},onConnect:{addListener(fn){connect=fn;}},sendMessage:async()=>({mode:admin?'admin':'anonymous',accessId:'public-1',origin:protocol.documentOrigin()})}};
    const input={request_id:id(100),messages:seed(1)[key].conversations[0].messages.map(({id,role,content})=>({id,role,content})),partial:false};
    vm.runInNewContext(source('offscreen.js'),{chrome,GyeoteProtocol:protocol,AbortController,setTimeout,clearTimeout,Uint8Array,TextDecoder,Blob,fetch:async(url,options)=>{
      calls.push({url,options});const body=JSON.parse(options.body);return new Response(JSON.stringify({request_id:body.request_id,text:'당시 상담 요약',source_message_ids:body.messages.map(message=>message.id),partial:false}));
    }});
    connect({name:'gyeote:guide',sender:{id:'x',frameId:0,url:'https://www.bokjiro.go.kr/',tab:{url:'https://www.bokjiro.go.kr/'}},postMessage:packet=>sent.push(packet),disconnect(){},onMessage:{addListener(fn){receive=fn;}},onDisconnect:{addListener(){}}});
    await receive({requestId:input.request_id,mode:'summary',payload:input,documentAccess:'anonymous:anonymous:public-1'});
    if(admin){assert.equal(calls.length,0);assert.equal(sent[0].error,'connection_failed');}
    else{assert.equal(calls.length,1);assert.equal(calls[0].url,protocol.documentOrigin()+'/api/v1/conversation/summary');assert.equal(calls[0].options.headers.Authorization,undefined);assert.equal(sent[0].type,'result');}
  }
});
