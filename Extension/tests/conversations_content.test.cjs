const {test}=require('node:test'),assert=require('node:assert/strict');
const {worker,ui,key,profileKey,profile,answer,settle}=require('./conversation_fixture.cjs');

test('요청 빈도 제한은 질문 옆에 안전하게 표시하고 다시 보낼 수 있다',async()=>{
 const server=worker(),f=ui(server);try{
  await f.ready();await f.question('합성 질문');const port=f.ports.at(-1);
  await port.receive({type:'error',requestId:port.packet.requestId,error:'chat_rate_limited'});await settle();
  assert.match(f.root.querySelector('.request-outcome').textContent,/질문 요청이 많습니다/);
  assert.equal(f.root.querySelector('#gyeote-question').closest('form').querySelector('[type=submit]').disabled,false);
  assert.equal(f.ports.length,1);assert.equal(server.data[key],undefined);
 }finally{f.close();}
});

test('맥락 불일치 저장 오류는 전용 안내와 미저장 답변을 보존한다',async()=>{
 const server=worker(),f=ui(server);try{
  await f.ready();await f.question('합성 질문');const original=f.w.chrome.runtime.sendMessage;
  f.w.chrome.runtime.sendMessage=m=>m.type==='gyeote:conversations-append'?Promise.resolve({ok:false,error:'conversation_context_conflict'}):original(m);
  await f.answer(answer);const text=f.root.querySelector('.unsaved-conversation').textContent;
  assert.match(text,/요청 당시 대화 맥락과 현재 기록이 달라 자동 저장하지 않았습니다/);
  assert.doesNotMatch(text,/상담 저장소에 접근하지 못했습니다/);assert.match(text,/합성 복지 안내/);
  assert.equal(f.root.querySelector('.unsaved-conversation').hidden,false);assert.equal(f.ports.length,1);assert.equal(server.data[key],undefined);
 }finally{f.close();}
});

test('서버 fallback DTO는 저장 뒤 새 패널에 복원된다',async()=>{
  const server=worker(),f=ui(server);try{
    await f.ready();await f.question('합성 질문');
    await f.answer({kind:'fallback',reason:'out_of_scope',text:'복지 관련 질문을 알려주세요.',services:[],contacts:[],suggestions:[],evidence:[],context_usage:{omitted:false},context_update:{status:'unchanged',text:'',coveredThroughMessageId:null,profileRevision:1}});
    assert.equal(server.data[key].conversations[0].messages.length,2);
    assert.equal(f.root.querySelector('.status').textContent,'');
  }finally{f.close();}
  const restored=ui(server);try{await restored.ready();assert.match(restored.root.querySelector('.conversation').textContent,/복지 관련 질문을 알려주세요/);}finally{restored.close();}
});

test('오류 수신은 프로필 확인이 응답하지 않아도 즉시 종료한다',async()=>{
  const server=worker(),f=ui(server);try{
    await f.ready();await f.question('합성 질문');const port=f.ports.at(-1),original=f.w.chrome.runtime.sendMessage;
    f.w.chrome.runtime.sendMessage=m=>m.type==='gyeote:profile-get'?new Promise(()=>{}):original(m);
    await port.receive({type:'error',requestId:port.packet.requestId,error:'generation_failed'});await settle();
    assert.match(f.root.querySelector('.status').textContent,/문서 검색이나 답변 처리에 실패/);
    assert.match(f.root.querySelector('.request-outcome').textContent,/문서 검색이나 답변 처리에 실패/);
    assert.equal(server.data[key],undefined);
    assert.equal(f.root.querySelector('#gyeote-question').closest('form').querySelector('[type=submit]').disabled,false);
    assert.equal(f.root.querySelector('button[type=submit]').getAttribute('aria-label'),'질문 보내기');assert.equal(port.disconnected,true);
  }finally{f.close();}
});

for(const ending of ['cancel','deadline'])test('문서 '+ending+' 결과를 질문에 남기되 상담에 저장하지 않는다',async()=>{
  let deadline;const server=worker(),f=ui(server,1,w=>{
    const set=w.setTimeout.bind(w),clear=w.clearTimeout.bind(w);
    w.setTimeout=(fn,ms,...args)=>ms>10000?(deadline=fn,999998):set(fn,ms,...args);
    w.clearTimeout=id=>id===999998?undefined:clear(id);
  });try{
    await f.ready();await f.question('합성 질문');assert.equal(f.ports.length,1);
    if(ending==='cancel')f.root.querySelector('button[type=submit]').click();else{assert.equal(typeof deadline,'function');deadline();}
    await settle();assert.ok(f.root.querySelector('.request-outcome')?.textContent);
    assert.equal(f.root.querySelector('#gyeote-question').closest('form').querySelector('[type=submit]').disabled,false);
    assert.equal(server.data[key],undefined);assert.equal(f.ports[0].disconnected,true);
  }finally{f.close();}
});

test('저장 확인 10초 초과는 미저장 답변을 보존하고 늦은 응답은 화면을 덮지 않는다',async()=>{
  let deadline,resolveAppend;const server=worker(),f=ui(server,1,w=>{
    const set=w.setTimeout.bind(w),clear=w.clearTimeout.bind(w);
    w.setTimeout=(fn,ms,...args)=>ms===10000?(deadline=fn,999999):set(fn,ms,...args);
    w.clearTimeout=id=>id===999999?undefined:clear(id);
  });try{
    await f.ready();await f.question('합성 질문');const port=f.ports.at(-1),original=f.w.chrome.runtime.sendMessage;
    f.w.chrome.runtime.sendMessage=m=>m.type==='gyeote:conversations-append'?new Promise(resolve=>{resolveAppend=resolve;}):original(m);
    const pending=port.receive({type:'result',requestId:port.packet.requestId,body:answer});await settle();
    assert.equal(typeof deadline,'function');assert.equal(typeof resolveAppend,'function');deadline();await pending;await settle();
    assert.equal(f.root.querySelector('#gyeote-question').closest('form').querySelector('[type=submit]').disabled,false);
    assert.equal(f.root.querySelector('button[type=submit]').getAttribute('aria-label'),'질문 보내기');assert.equal(f.root.querySelector('.unsaved-conversation').hidden,false);
    assert.match(f.root.querySelector('.unsaved-conversation').textContent,/저장 확인이 필요한 답변/);
    assert.match(f.root.querySelector('.unsaved-conversation').textContent,/대화를 다시 불러/);
    await f.mode('screen');const before=f.root.querySelector('.conversation').textContent,status=f.root.querySelector('.status').textContent;
    resolveAppend({ok:true,state:{}});await settle();
    assert.equal(f.root.querySelector('.conversation').textContent,before);assert.equal(f.root.querySelector('.status').textContent,status);assert.equal(f.ports.length,1);
    await f.mode('document');assert.equal(f.root.querySelector('.unsaved-conversation').hidden,false);
  }finally{f.close();}
});

test('저장 확인 초과 뒤 동일 쌍의 실제 지연 저장은 통지로 확인된다',async()=>{
  let deadline,release;const server=worker(),f=ui(server,1,w=>{
    const set=w.setTimeout.bind(w),clear=w.clearTimeout.bind(w);
    w.setTimeout=(fn,ms,...args)=>ms===10000?(deadline=fn,999999):set(fn,ms,...args);
    w.clearTimeout=id=>id===999999?undefined:clear(id);
  });try{
    await f.ready();await f.question('합성 질문');server.failure.beforeSet=value=>key in value?new Promise(resolve=>{release=resolve;}):undefined;
    const port=f.ports.at(-1),pending=port.receive({type:'result',requestId:port.packet.requestId,body:answer});await settle();
    assert.equal(typeof release,'function');deadline();await pending;await settle();
    assert.equal(f.root.querySelector('.unsaved-conversation').hidden,false);
    delete server.failure.beforeSet;release();await settle();
    assert.equal(server.data[key].conversations[0].messages.length,2);
    assert.equal(f.root.querySelector('.unsaved-conversation').hidden,true);assert.equal(f.ports.length,1);
  }finally{f.close();}
});

test('지연 저장과 모드 전환 경쟁에서 기록을 덮지 않는다',async()=>{
  let deadline,release;const server=worker(),f=ui(server,1,w=>{
    const set=w.setTimeout.bind(w),clear=w.clearTimeout.bind(w);
    w.setTimeout=(fn,ms,...args)=>ms===10000?(deadline=fn,999999):set(fn,ms,...args);
    w.clearTimeout=id=>id===999999?undefined:clear(id);
  });try{
    await f.ready();await f.question('기존 질문');server.failure.beforeSet=value=>key in value?new Promise(resolve=>{release=resolve;}):undefined;
    const port=f.ports.at(-1),pending=port.receive({type:'result',requestId:port.packet.requestId,body:answer});await settle();
    assert.equal(typeof release,'function');deadline();await pending;await settle();
    await f.mode('screen');
    delete server.failure.beforeSet;release();await settle();
    const state=server.data[key];assert.equal(state.conversations.length,1);
    assert.equal(state.conversations[0].messages.length,2);
  }finally{f.close();}
});

test('성공 대화를 새 패널에서 복원하고 제한 이력을 계속 전송한다',async()=>{
  const server=worker(),f=ui(server);try{
    await f.ready();await f.question('신청 방법은?');assert.equal(f.ports.length,1);assert.deepEqual(f.ports[0].packet.payload.history,[]);
    await f.answer(answer);assert.equal(server.data[key].conversations.length,1);assert.equal(f.root.querySelector('.status').textContent,'');assert.equal(f.root.querySelector('.request-outcome'),null);
    await f.question('필요 서류는?');assert.deepEqual(f.ports.at(-1).packet.payload.history,[{role:'user',content:'신청 방법은?'},{role:'assistant',content:answer.text}]);
    f.root.querySelector('button[type=submit]').click();
  }finally{f.close();}
  const g=ui(server);try{await g.ready();assert.match(g.root.querySelector('.conversation').textContent,/신청 방법은/);assert.match(g.root.querySelector('.conversation').textContent,/현재 유효성은 다시 확인하지 않았습니다/);assert.equal(server.data[key].conversations[0].messages.length,2);}finally{g.close();}
});
test('전체 대화 삭제는 확인 후 실행하고 프로필을 보존한다',async()=>{
  const server=worker(),f=ui(server);try{
    await f.ready();await f.question('첫 상담');await f.answer(answer);
    await f.click('전체 대화 삭제');assert.equal(server.data[key].conversations.length,1);await f.click('취소');assert.equal(server.data[key].conversations.length,1);
    await f.click('전체 대화 삭제');await f.click('삭제 확인');assert.equal(server.data[key].conversations.length,0);assert.deepEqual(server.data[profileKey],profile);
  }finally{f.close();}
});
test('quota 실패 답변은 미저장으로 남고 재저장은 모델 포트를 만들지 않는다',async()=>{
  const server=worker(),f=ui(server);try{
    await f.ready();await f.question('합성 질문');server.failure.quota=true;await f.answer(answer);
    assert.equal(server.data[key],undefined);assert.equal(f.root.querySelector('.unsaved-conversation').hidden,false);assert.match(f.root.querySelector('.unsaved-conversation').textContent,/저장되지 않은 답변/);
    const count=f.ports.length;server.failure.quota=false;await f.click('답변 저장 다시 시도');assert.equal(f.ports.length,count);assert.equal(server.data[key].conversations[0].messages.length,2);assert.equal(f.root.querySelector('.unsaved-conversation').hidden,true);
  }finally{f.close();}
});
test('미저장 답변은 삭제 후에도 보존되지만 재삽입은 차단한다',async()=>{
  const server=worker(),f=ui(server);try{
    await f.ready();await f.question('기존 상담');await f.answer(answer);await f.question('보관할 질문');server.failure.quota=true;await f.answer({kind:'answer',text:'보관할 미저장 본문',evidence:[]});
    const ports=f.ports.length;await f.question('다음 질문 초안');assert.equal(f.ports.length,ports);assert.equal(f.root.querySelector('#gyeote-question').value,'다음 질문 초안');
    assert.match(f.root.querySelector('.unsaved-conversation').textContent,/보관할 미저장 본문/);
    server.failure.quota=false;await f.click('전체 대화 삭제');await f.click('삭제 확인');assert.equal(server.data[key].conversations.length,0);assert.match(f.root.querySelector('.unsaved-conversation').textContent,/보관할 미저장 본문/);
    const retry=f.button('답변 저장 다시 시도');assert.equal(retry.disabled,true);assert.equal(f.ports.length,ports);assert.equal(server.data[key].conversations.length,0);
  }finally{f.close();}
});
test('전송 중 전체 삭제 뒤 늦은 응답은 표시·저장하지 않는다',async()=>{
  const server=worker(),f=ui(server);try{
    await f.ready();await f.question('첫 상담');await f.answer(answer);await f.question('늦은 질문');const old=f.ports.at(-1);
    await f.click('전체 대화 삭제');await f.click('삭제 확인');await f.answer({kind:'answer',text:'지연된 비정상 답변',evidence:[]},old);
    assert.ok(old.disconnected);assert.ok(!JSON.stringify(server.data[key]).includes('지연된'));assert.doesNotMatch(f.root.querySelector('.conversation').textContent,/지연된/);
  }finally{f.close();}
});
test('다른 탭 삭제는 전송을 중지하며 작성 중 질문은 유지한다',async()=>{
  const server=worker(),f=ui(server),g=ui(server,2);try{
    await settle();await f.question('첫 상담');await f.answer(answer);await settle();
    await f.question('지연될 질문');const old=f.ports.at(-1);const draft=f.root.querySelector('#gyeote-question');draft.value='작성 중 초안';
    await g.click('전체 대화 삭제');await g.click('삭제 확인');await settle();await f.answer({kind:'answer',text:'삭제 뒤 늦은 답변',evidence:[]},old);
    assert.equal(server.data[key].conversations.length,0);assert.equal(draft.value,'작성 중 초안');assert.doesNotMatch(f.root.querySelector('.conversation').textContent,/삭제 뒤/);
  }finally{f.close();g.close();}
});
test('동일 revision 늦은 통지는 새 질문을 취소하지 않는다',async()=>{
  const server=worker(),f=ui(server);try{
    await f.ready();await f.question('첫 질문');await f.answer(answer);await f.question('계속 질문');const port=f.ports.at(-1),state=server.data[key];
    f.notify({type:'gyeote:conversations-changed',revision:state.revision,generation:state.generation});await settle();assert.ok(!port.disconnected);
    await f.answer({kind:'fallback',text:'근거가 부족합니다.',evidence:[]},port);assert.equal(server.data[key].conversations[0].messages.length,4);
  }finally{f.close();}
});
test('프로필 변경은 이전 요청만 중지하고 저장 대화는 보존하며 후속 이력을 비운다',async()=>{
  const server=worker(),f=ui(server);try{
    await f.ready();await f.question('이전 조건 질문');await f.answer(answer);await f.question('곧 바뀔 조건');const old=f.ports.at(-1);
    await server.send({type:'gyeote:profile-save',expectedRevision:1,profile:{age:60}});await settle();await f.answer({kind:'answer',text:'이전 조건 답변',evidence:[]},old);
    assert.equal(server.data[key].conversations[0].messages.length,2);await f.question('새 조건 질문');assert.deepEqual(f.ports.at(-1).packet.payload.history,[]);
    f.root.querySelector('button[type=submit]').click();
  }finally{f.close();}
});
test('권한 전환은 공개 요청을 중지하고 관리자 답변은 영구저장하지 않는다',async()=>{
  const server=worker(),f=ui(server);try{
    await f.ready();await f.question('공개 질문');await f.answer(answer);const persisted=JSON.stringify(server.data[key]);await f.question('전환 전 질문');const old=f.ports.at(-1);
    await server.send({type:'gyeote:admin-connect',session:{token:'a'.repeat(40),expiresAt:Math.floor(Date.now()/1000)+600,origin:require('../protocol.js').documentOrigin()}},{id:'x',url:'chrome-extension://x/options.html'});await settle();
    await f.answer({kind:'answer',text:'권한 전환 뒤 늦은 공개 응답',evidence:[]},old);assert.equal(f.root.querySelector('.saved-slot').hidden,true);
    await f.question('관리자 합성 문서');assert.equal(f.ports.at(-1).packet.conversationContext,undefined);await f.answer({kind:'answer',text:'합성 관리자 전용 응답',evidence:[]});assert.equal(JSON.stringify(server.data[key]),persisted);
    await server.send({type:'gyeote:admin-logout'},{id:'x',url:'chrome-extension://x/options.html'});await settle();assert.doesNotMatch(f.root.querySelector('.conversation').textContent,/관리자 전용/);assert.match(f.root.querySelector('.conversation').textContent,/공개 질문/);
  }finally{f.close();}
});
test('인증 통지를 놓쳐도 전송 직전 접근 확인이 관리자 이력의 공개 혼입을 막는다',async()=>{
  const server=worker();server.session.documentAccess='admin';server.session.documentAdminSession={token:'a'.repeat(40),expiresAt:Math.floor(Date.now()/1000)+600,origin:require('../protocol.js').documentOrigin()};
  const f=ui(server);try{
    await f.ready();await f.question('관리자 질문');await f.answer({kind:'answer',text:'관리자 전용 합성 답변',evidence:[]});assert.equal(server.data[key],undefined);
    server.session.documentAccess='anonymous';server.session.documentAccessId='public-new';server.session.documentAdminSession=null;
    await f.question('공개 질문');assert.deepEqual(f.ports.at(-1).packet.payload.history,[]);assert.equal(f.ports.at(-1).packet.documentAccess,'anonymous:anonymous:public-new');assert.doesNotMatch(f.root.querySelector('.conversation').textContent,/관리자 전용/);
    await f.answer(answer);assert.ok(!JSON.stringify(server.data[key]).includes('관리자 전용'));
  }finally{f.close();}
});
test('접근 확인과 prepare 사이 권한이 바뀌면 익명으로 내려 보내지 않고 중지한다',async()=>{
  const server=worker();server.session.documentAccess='admin';server.session.documentAdminSession={token:'a'.repeat(40),expiresAt:Math.floor(Date.now()/1000)+600,origin:require('../protocol.js').documentOrigin()};
  const f=ui(server);try{
    await f.ready();await f.question('관리자 질문');await f.answer({kind:'answer',text:'관리자 전용 이전 응답',evidence:[]});const count=f.ports.length;
    const send=f.w.chrome.runtime.sendMessage;f.w.chrome.runtime.sendMessage=message=>{
      if(message.type==='gyeote:prepare'){server.session.documentAccess='anonymous';server.session.documentAccessId='public-changed';server.session.documentAdminSession=null;}
      return send(message);
    };
    await f.question('준비 중 전환 질문');assert.equal(f.ports.length,count);assert.equal(server.data[key],undefined);assert.doesNotMatch(f.root.querySelector('.conversation').textContent,/관리자 전용/);
  }finally{f.close();}
});
test('화면 전환은 문서요청을 취소하고 임시 화면대화가 저장소에 섞이지 않는다',async()=>{
  const server=worker(),f=ui(server);try{
    await f.ready();await f.question('문서 질문');await f.answer(answer);const raw=JSON.stringify(server.data[key]);await f.question('문서 지연');const old=f.ports.at(-1);
    await f.mode('screen');await f.answer({kind:'answer',text:'늦은 문서 답변',evidence:[]},old);assert.equal(f.root.querySelector('.saved-slot').hidden,true);
    await f.question('공개 메뉴');const port=f.ports.at(-1);assert.equal(port.packet.mode,'screen');assert.equal(port.packet.payload.profile,undefined);
    await f.answer({reply:{snapshot_id:port.packet.payload.snapshot_id,kind:'설명',answer:'공개 기능 설명입니다.',targets:[]}},port);assert.equal(JSON.stringify(server.data[key]),raw);
    await f.mode('document');assert.doesNotMatch(f.root.querySelector('.conversation').textContent,/공개 기능 설명/);assert.match(f.root.querySelector('.conversation').textContent,/문서 질문/);
  }finally{f.close();}
});
test('손상 저장소의 명시 초기화는 프로필을 보존하고 HTML 없는 제한 근거를 복원한다',async()=>{
  const server=worker({[profileKey]:profile,[key]:'broken'}),f=ui(server);try{
    await f.ready();assert.match(f.root.querySelector('.conversation-settings').textContent,/형식을 확인하지 못했습니다/);await f.click('대화 저장소 재설정');assert.equal(server.data[key],'broken');await f.click('삭제 확인');assert.equal(server.data[key].conversations.length,0);assert.deepEqual(server.data[profileKey],profile);
    await f.question('안내 질문');await f.answer({kind:'answer',text:'합성 답변',evidence:[{document_id:'doc',chunk_id:'chunk',quote:'<script>합성</script>',context:'별도 전체 원문',pages:[1],source_blocks:['block'],source_url:'javascript:alert(1)'}]});
    assert.equal(f.root.querySelector('.conversation script'),null);assert.equal(f.root.querySelector('.conversation a'),null);assert.match(f.root.querySelector('.conversation').textContent,/일부 인용·참조만 저장/);assert.ok(!JSON.stringify(server.data[key]).includes('별도 전체 원문'));
  }finally{f.close();}
});
