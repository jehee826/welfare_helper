const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {worker,ui,key,profileKey,profile,answer,activeBoundary,source,settle}=require('./conversation_fixture.cjs');
const protocol=require('../protocol.js'),policy=require('../conversations.js');
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

test('현재 주제·시간 경계 뒤 완전 문답만 보내며 요약은 상담 저장·다음 RAG에 넣지 않는다',async()=>{
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

test('요약 결과는 F5 뒤 사라지고 원래 문답은 복원한다',async()=>{
  const f=fixture();try{await f.ready();button(f).click();await settle();await f.answer(reply(f.ports.at(-1)));assert.equal(result(f).hidden,false);}finally{f.close();}
  const restored=ui(f.server);try{await restored.ready();assert.equal(result(restored).hidden,true);assert.match(restored.root.querySelector('.conversation').textContent,/질문 1/);}finally{restored.close();}
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
