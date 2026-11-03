const {test}=require('node:test'),assert=require('node:assert/strict');
const {worker,ui,key,profileKey,profile,answer,settle}=require('./conversation_fixture.cjs');
require('../protocol.js');const policy=require('../conversations.js');
function speech(){
  const instances=[];
  return {instances,setup:w=>{w.SpeechRecognition=class{constructor(){this.aborts=0;instances.push(this);}start(){}abort(){this.aborts++;}};},
    result:text=>({resultIndex:0,results:[Object.assign([{transcript:text}],{isFinal:true})]})};
}
const suggestions=f=>[...f.root.querySelectorAll('.question-suggestions button')];
test('이미지 입력과 고정 전송 안내는 제공하지 않는다',async()=>{const f=ui(worker());try{await f.ready();await f.mode('screen');assert.equal(f.root.querySelector('.image-option'),null);assert.equal(f.root.querySelector('.send-notice'),null);}finally{f.close();}});
test('음성 overlay는 패널만 비활성화하고 Escape로 정리한다',async()=>{const voice=speech(),f=ui(worker(),1,voice.setup);try{await f.ready();const root=f.root,mic=root.querySelector('.voice-start');assert.equal(mic.getAttribute('aria-label'),'음성 입력');assert.equal(mic.parentElement,root.querySelector('.compose-row'));assert.equal(mic.nextElementSibling.type,'submit');mic.click();await settle();const overlay=root.querySelector('.listening-overlay');assert.equal(overlay.hidden,false);assert.match(overlay.textContent,/듣고 있습니다/);assert.match(overlay.textContent,/외부 인식 서비스/);assert.equal(root.querySelector('.head').inert,true);assert.equal(root.querySelector('.body').inert,true);assert.equal(root.activeElement,overlay.querySelector('.voice-cancel'));assert.match([...root.querySelectorAll('style')].map(s=>s.textContent).join(''),/prefers-reduced-motion:reduce/);const late=voice.instances[0].onresult;f.w.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Escape'}));assert.equal(overlay.hidden,true);assert.equal(root.querySelector('.body').inert,false);assert.equal(voice.instances[0].aborts,1);late(voice.result('오래된 음성'));assert.equal(root.querySelector('#gyeote-question').value,'');assert.equal(f.ports.length,0);}finally{f.close();}});
test('음성 최종 결과는 overlay를 닫고 전송 없이 초안에 남긴다',async()=>{const voice=speech(),f=ui(worker(),1,voice.setup);try{await f.ready();await f.click('음성 입력');voice.instances[0].onresult(voice.result('합성 음성 초안'));assert.equal(f.root.querySelector('#gyeote-question').value,'합성 음성 초안');assert.equal(f.root.querySelector('.listening-overlay').hidden,true);assert.equal(f.root.querySelector('.head').inert,false);assert.equal(f.ports.length,0);}finally{f.close();}});
function seed(){
  const date='2026-11-02T00:00:00.000Z',messages=[],pair=i=>i.toString(16).toUpperCase().padStart(20,'0');
  for(let i=1;i<=9;i++)messages.push(...policy.pair(pair(i),'합성 상담 질문 '+i,answer,1,date));
  const summary={text:'사용자는 합성 상담의 신청 방법을 찾고 있음',coveredThroughMessageId:pair(3)+':assistant',profileRevision:1};
  return {[profileKey]:{...profile,profile:{age:70,income:'unknown',household:'single',region:'서울특별시',disability:false}},
    [key]:{...policy.empty(),revision:1,lastActiveConversationId:'conversation',conversations:[{id:'conversation',title:'합성 상담',createdAt:date,updatedAt:date,messages,summary}]}};
}
test('추천은 초안만 만들고 명시 전송 때 현재 profile/history/summary를 유지한다',async()=>{
  const server=worker(seed()),f=ui(server);try{
    await f.ready();const button=suggestions(f)[2];assert.match(button.textContent,/그 서비스/);
    assert.ok(suggestions(f).every(item=>/내 조건/.test(item.textContent)));assert.match(suggestions(f)[0].textContent,/70세 · 서울특별시/);assert.doesNotMatch(button.textContent,/70|서울/);
    button.click();await settle();assert.equal(f.ports.length,0);const input=f.root.querySelector('#gyeote-question');assert.equal(input.value,button.textContent);
    input.closest('form').dispatchEvent(new f.w.Event('submit',{cancelable:true}));await settle();
    assert.equal(f.ports.length,1);const payload=f.ports[0].packet.payload;
    assert.equal(payload.query,button.textContent);assert.equal(payload.profile.age,70);assert.equal(payload.history.length,6);
    assert.equal(payload.conversation_context.text,server.data[key].conversations[0].summary.text);assert.equal(payload.conversation_context.batch.length,6);
  }finally{f.close();}
});
test('전체 삭제·모드 전환에서 옛 추천은 무효이고 초안은 덮지 않는다',async()=>{
  const server=worker(seed()),f=ui(server);try{
    await f.ready();const old=suggestions(f)[0];await f.click('전체 대화 삭제');await f.click('삭제 확인');old.click();assert.equal(f.root.querySelector('#gyeote-question').value,'');
    const first=suggestions(f)[0];assert.match(first.textContent,/내 조건/);f.root.querySelector('#gyeote-question').value='직접 쓴 초안';first.click();assert.equal(f.root.querySelector('#gyeote-question').value,'직접 쓴 초안');
    await f.mode('screen');first.click();assert.equal(f.root.querySelector('.question-suggestions').hidden,true);assert.equal(f.root.querySelector('#gyeote-question').value,'');assert.equal(f.ports.length,0);
  }finally{f.close();}
});
test('미저장 답변 동안 입력 도우미를 제한하고 명시 폐기 후 다시 활성화한다',async()=>{
  const server=worker(),f=ui(server,1,speech().setup);try{
    await f.ready();await f.question('합성 질문');server.failure.quota=true;await f.answer(answer);
    assert.ok(suggestions(f).every(button=>button.disabled));assert.equal(f.root.querySelector('.voice-start').disabled,true);
    suggestions(f)[0].click();assert.equal(f.root.querySelector('#gyeote-question').value,'');assert.equal(f.ports.length,1);
    await f.click('미저장 답변 버리기');await f.click('미저장 답변 버리기 확인');assert.ok(suggestions(f).every(button=>!button.disabled));assert.equal(f.root.querySelector('.voice-start').disabled,false);
  }finally{f.close();}
});
test('탭 숨김은 음성을 취소하고 복귀하면 추천·음성을 다시 사용할 수 있다',async()=>{
  const server=worker(),voice=speech(),f=ui(server,1,voice.setup);try{
    await f.ready();await f.click('음성 입력');const first=voice.instances[0],late=first.onresult;
    Object.defineProperty(f.w.document,'hidden',{configurable:true,value:true});f.w.document.dispatchEvent(new f.w.Event('visibilitychange'));
    assert.equal(first.aborts,1);late(voice.result('숨김 뒤 결과'));assert.equal(f.root.querySelector('#gyeote-question').value,'');assert.equal(f.root.querySelector('.voice-start').disabled,true);
    Object.defineProperty(f.w.document,'hidden',{configurable:true,value:false});f.w.document.dispatchEvent(new f.w.Event('visibilitychange'));
    assert.equal(f.root.querySelector('.voice-start').disabled,false);assert.ok(suggestions(f).every(button=>!button.disabled));
    await f.click('음성 입력');voice.instances[1].onresult(voice.result('복귀 후 합성 질문'));assert.equal(f.root.querySelector('#gyeote-question').value,'복귀 후 합성 질문');assert.equal(f.ports.length,0);
  }finally{f.close();}
});
for(const boundary of ['mode','conversation','profile','access','close','collapse','pagehide','hash'])test(`음성 중 ${boundary} 전환은 이전 결과를 적용하지 않는다`,async()=>{
  const server=worker(boundary==='conversation'?seed():undefined),voice=speech(),f=ui(server,1,voice.setup);try{
    await f.ready();await f.click('음성 입력');const first=voice.instances[0],late={result:first.onresult,end:first.onend,error:first.onerror};
    if(boundary==='mode')await f.mode('screen');
    if(boundary==='conversation'){await f.click('전체 대화 삭제');await f.click('삭제 확인');}
    if(boundary==='profile')await f.click('내 정보 수정');
    if(boundary==='access')await f.notify({type:'gyeote:document-access-changed',state:{mode:'admin',status:'ready',accessId:'other'}});
    if(boundary==='close')f.root.querySelector('.close').click();
    if(boundary==='collapse')f.root.querySelector('.collapse').click();
    if(boundary==='pagehide')f.w.dispatchEvent(new f.w.Event('pagehide'));
    if(boundary==='hash')f.w.dispatchEvent(new f.w.Event('hashchange'));
    await settle();assert.equal(first.aborts,1);late.result(voice.result('이전 상태 결과'));late.end();late.error({error:'network'});
    assert.equal(f.root.querySelector('#gyeote-question').value,'');assert.equal(f.ports.length,0);
  }finally{f.close();}
});
test('긴 음성은 초안 유지·전송 차단하고 민감 질문은 기존 개인정보 경로에서 거절한다',async()=>{
  const server=worker(),voice=speech(),f=ui(server,1,voice.setup);try{
    await f.ready();await f.click('음성 입력');voice.instances[0].onresult(voice.result('가'.repeat(301)));
    const input=f.root.querySelector('#gyeote-question');input.closest('form').dispatchEvent(new f.w.Event('submit',{cancelable:true}));await settle();
    assert.equal(input.value.length,301);assert.equal(f.ports.length,0);assert.match(f.root.querySelector('.status').textContent,/300자/);
    input.value='';await f.click('음성 입력');voice.instances[1].onresult(voice.result('010-0000-0000'));
    assert.equal(f.ports.length,0);input.closest('form').dispatchEvent(new f.w.Event('submit',{cancelable:true}));await settle();
    assert.equal(f.ports.length,0);assert.equal(server.data[key],undefined);assert.match(f.root.querySelector('.status').textContent,/개인정보/);
  }finally{f.close();}
});
test('음성 중 명시 전송은 인식을 취소하며 처리 중 새 도우미 동작을 막는다',async()=>{
  const server=worker(),voice=speech(),f=ui(server,1,voice.setup);try{
    await f.ready();await f.click('음성 입력');const first=voice.instances[0],late=first.onresult;
    await f.question('직접 확인한 합성 질문');assert.equal(first.aborts,1);assert.equal(f.ports.length,1);assert.equal(f.root.querySelector('.voice-start').disabled,true);assert.ok(suggestions(f).every(button=>button.disabled));
    late(voice.result('전송 뒤 늦은 음성'));assert.equal(f.root.querySelector('#gyeote-question').value,'');await f.answer(answer);assert.equal(f.root.querySelector('.voice-start').disabled,false);
  }finally{f.close();}
});
