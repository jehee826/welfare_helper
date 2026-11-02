const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const protocol=require('../protocol.js');
const cases=require('../../BackEnd/tests/fixtures/document_privacy_cases.json');
const source=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8');
for(const item of cases)test(`공통 가상 입력 정책: ${item.text}`,()=>assert.equal(protocol.privacy.sensitiveInput(item.text),item.sensitive));

test('가림은 표시 텍스트·URL에만 적용하고 식별자·해시·원문 범위를 보존한다',()=>{
  const token='prefix-9913991234567-suffix';
  const metadata=Object.fromEntries(['chunk_id','document_id','model_digest','hash','snapshot','section'].map(key=>[key,token]));
  Object.assign(metadata,{source_blocks:[token],required_by:[token],start:9913991234567,end:9913991234599,pages:[1]});
  const original={...metadata,text:'가상 9913991234567',quote:'9913991234567',context:'계좌번호: 321-00-000001',source_url:'https://example.invalid/source?value=9913991234567'};
  const before=JSON.stringify(original),safe=protocol.privacy.redactDocument(original);
  for(const key of Object.keys(metadata))assert.deepEqual(safe[key],metadata[key]);
  for(const key of ['text','quote','context','source_url'])assert.match(safe[key],/\[개인정보 가림\]/);
  assert.equal(safe.redacted,true);assert.equal(JSON.stringify(original),before);
  const urlOnly=protocol.privacy.redactDocument({...metadata,text:'안전한 본문',source_url:original.source_url});
  assert.equal(urlOnly.redacted,true);assert.equal(urlOnly.text,'안전한 본문');
  const unchanged={...metadata,text:'2026년 129/1355 안내'};assert.deepEqual(protocol.privacy.redactDocument(unchanged),unchanged);
});

function panel(){
  const {worker,ui}=require('./conversation_fixture.cjs'),f=ui(worker());
  return {root:f.root,get packets(){return f.ports.map(port=>port.packet);},
    prepared:()=>f.requests.filter(message=>message.type==='gyeote:prepare').length,
    send:async text=>{await f.ready();await f.question(text);},answer:body=>f.answer(body),close:f.close};
}

test('문서 패널은 민감 질문을 메시지·준비·포트 전송 전에 차단한다',async()=>{
  const f=panel();try{
    for(const raw of ['991399-1234567','010-0000-0000','계좌번호: 321-00-000001']){
      await f.send(raw);assert.equal(f.prepared(),0);assert.equal(f.packets.length,0);
      assert.ok(!f.root.querySelector('.conversation').textContent.includes(raw));
      assert.match(f.root.querySelector('.status').textContent,/개인정보가 포함된 질문은 보낼 수 없습니다/);
    }
    await f.send('2026년 129/1355, 14일 3권');assert.equal(f.packets.length,1);
    const payload=f.packets[0].payload;assert.equal(payload.query,'2026년 129/1355, 14일 3권');assert.deepEqual(payload.history,[]);assert.equal(payload.profile,null);assert.ok(payload.conversation_context);
    await f.answer({kind:'answer',text:'정상 답변',evidence:[]});
  }finally{f.close();}
});

test('문서 답변·근거 표시와 다음 이력은 정제하며 공공 연락처가 재질문을 막지 않는다',async()=>{
  const f=panel();try{
    await f.send('정상 질문');
    await f.answer({kind:'answer',text:'가상 991399-1234567. 기관 연락처 010-0000-0000, 대표 129/1355',evidence:[{
      chunk_id:'chunk',document_id:'doc',quote:'991399-1234567',context:'계좌번호: 321-00-000001',pages:[1],source_blocks:['b1'],source_url:'https://example.invalid'
    }]});
    const shown=f.root.querySelector('.conversation').textContent;
    assert.ok(!shown.includes('991399-1234567')&&!shown.includes('321-00-000001'));
    assert.match(shown,/원문 그대로의 인용이 아닙니다/);assert.match(shown,/129\/1355/);assert.ok(!shown.includes('010-0000-0000'));
    await f.send('후속 질문');assert.equal(f.packets.length,2);
    assert.ok(!JSON.stringify(f.packets[1].payload.history).includes('010-0000-0000'));
    await f.answer({kind:'answer',text:'후속 답변',evidence:[]});
  }finally{f.close();}
});

function offscreen(fetcher){
  let onConnect,receive;const sent=[];
  const chrome={runtime:{id:'a'.repeat(32),onConnect:{addListener(fn){onConnect=fn;}},onMessage:{addListener(){}},sendMessage:async msg=>msg.type==='gyeote:connection'?{timeoutSeconds:30}:{mode:'anonymous',accessId:'one',origin:protocol.documentOrigin()}}};
  vm.runInNewContext(source('offscreen.js'),{chrome,GyeoteProtocol:protocol,AbortController,setTimeout,clearTimeout,fetch:fetcher,Uint8Array,TextDecoder,Blob});
  const port={name:'gyeote:guide',sender:{id:chrome.runtime.id,frameId:0,url:'https://www.bokjiro.go.kr/',tab:{url:'https://www.bokjiro.go.kr/'}},postMessage(packet){sent.push(packet);},disconnect(){},onMessage:{addListener(fn){receive=fn;}},onDisconnect:{addListener(){}}};onConnect(port);
  return {sent,run:payload=>receive({requestId:'A'.repeat(20),mode:'document',documentAccess:'anonymous:anonymous:one',payload})};
}

test('오프스크린은 우회된 민감 질문과 history도 fetch 0회로 거절한다',async()=>{
  for(const payload of [{query:'010-0000-0000',history:[]},{query:'정상 질문',history:[{role:'assistant',content:'991399-1234567'}]}]){
    let calls=0;const f=offscreen(async()=>{calls++;throw Error('실제 전송 금지');});
    await f.run(payload);assert.equal(calls,0);assert.equal(f.sent[0].error,'sensitive_input');
    assert.ok(!JSON.stringify(f.sent).includes('991399-1234567'));
  }
});

test('서버 개인정보 오류 코드를 보존하고 내부 오류 본문은 전하지 않는다',async()=>{
  for(const [body,status,expected] of [[{detail:'sensitive_input'},422,'sensitive_input'],[{detail:'가상 SECRET stack'},503,'generation_failed'],[{detail:'가상 SECRET'},401,'document_auth_required']]){
    const f=offscreen(async()=>new Response(JSON.stringify(body),{status}));await f.run({query:'2026년 기준',history:[],profile:null});
    assert.equal(f.sent[0].error,expected);assert.ok(!JSON.stringify(f.sent).includes('SECRET'));
  }
});

test('응답 포트 경계에서도 식별정보를 가리고 구조화된 공공 연락처는 보존한다',async()=>{
  const original={kind:'answer',text:'가상 991399-1234567, 개인 연락처: 010-0000-0000',contacts:[{label:'기관',phone:'010-0000-0000'}],evidence:[]};
  const f=offscreen(async()=>new Response(JSON.stringify(original)));await f.run({query:'정상 질문',history:[],profile:null});
  assert.equal(f.sent[0].type,'result');assert.ok(!f.sent[0].body.text.includes('991399-1234567'));
  assert.ok(!f.sent[0].body.text.includes('010-0000-0000'));assert.deepEqual(JSON.parse(JSON.stringify(f.sent[0].body.contacts)),original.contacts);
  assert.ok(original.text.includes('991399-1234567'));
});
