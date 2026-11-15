const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {JSDOM}=require('../../FrontEnd/node_modules/jsdom');
const {worker,ui,source,settle,key}=require('./conversation_fixture.cjs');
const {packageExtension,runtimeFiles}=require('../package.cjs');
const installed=require('../protocol.js'),origin='https://api.example.invalid',token='a'.repeat(40),expiresAt=Math.floor(Date.now()/1000)+600;
const sourceProtocol=source('protocol.js');
const packagePath=packageExtension({origin,name:'t8-test-'+crypto.randomUUID()}),read=name=>fs.readFileSync(path.join(packagePath,name),'utf8');
function protocol(readSource=read){const context={URL};vm.runInNewContext(readSource('protocol.js'),context);return context.GyeoteProtocol;}
function offscreen({auth={mode:'anonymous',accessId:'public-1',origin},fetcher=async()=>new Response(JSON.stringify({kind:'answer',text:'가상 답변',evidence:[]})),policy=protocol()}={}){
  let connect,receive;const sent=[],messages=[],calls=[];
  const chrome={runtime:{id:'x',onConnect:{addListener(fn){connect=fn;}},onMessage:{addListener(){}},sendMessage:async message=>{messages.push(message);if(message.type==='gyeote:document-auth')return typeof auth==='function'?auth():auth;if(message.type==='gyeote:connection')return {token,timeoutSeconds:30,imageEnabled:true};return {ok:true};}}};
  vm.runInNewContext(read('offscreen.js'),{chrome,GyeoteProtocol:policy,AbortController,setTimeout,clearTimeout,Uint8Array,TextDecoder,Blob,fetch:(url,options)=>{calls.push({url,options});return fetcher(url,options);}});
  connect({name:'gyeote:guide',sender:{id:'x',frameId:0,url:'https://www.bokjiro.go.kr/',tab:{url:'https://www.bokjiro.go.kr/'}},postMessage:value=>sent.push(value),disconnect(){},onMessage:{addListener(fn){receive=fn;}},onDisconnect:{addListener(){}}});
  return {sent,messages,calls,run:packet=>receive({requestId:'A'.repeat(20),mode:'document',documentAccess:'anonymous:anonymous:public-1',payload:{query:'합성 문서 질문',history:[]},...packet})};
}

test('주소 주입은 prepare와 전송 경계에서 거절한다',async()=>{const server=worker(undefined,{},read);assert.equal((await server.send({type:'gyeote:prepare',mode:'document',origin:'https://other.invalid'},server.sender(1))).ok,false);for(const packet of [{origin:'https://other.invalid'},{payload:{query:'질문',origin:'https://other.invalid'}}]){const f=offscreen();await f.run(packet);assert.equal(f.calls.length,0);assert.equal(f.sent[0].type,'error');}});
test('원격 아이콘은 패널을 닫고 열며 포커스를 복원한다',async()=>{const server=worker(undefined,{},read),f=ui(server);try{await f.ready();const tab={id:1,url:'https://www.bokjiro.go.kr/'};await server.click(tab);await settle();assert.equal(f.root.querySelector('.panel').hidden,true);await server.click(tab);await settle();assert.equal(f.root.querySelector('.panel').hidden,false);assert.equal(f.root.activeElement,f.root.querySelector('#gyeote-question'));}finally{f.close();}});
test('연결 JSON 없이 공개 질문과 문서 응답을 표시한다',async()=>{const server=worker(undefined,{},read),f=ui(server);try{await f.ready();await f.question('합성 공개 질문');assert.equal(f.ports.length,1);await f.answer({kind:'answer',text:'합성 문서 응답',evidence:[]});assert.match(f.root.querySelector('.conversation').textContent,/합성 문서 응답/);assert.equal(server.session.connection,undefined);}finally{f.close();}});
test('설정 기한 경계와 420초 문서·90초 화면 예산을 유지한다',async()=>{for(const n of [1,1800])assert.equal(installed.validateDocumentTimeout(n),n);const dir=packageExtension({origin,name:'t8-bounds-'+crypto.randomUUID(),timeoutSeconds:420}),custom=n=>fs.readFileSync(path.join(dir,n),'utf8'),server=worker(undefined,{},custom);for(const [mode,seconds] of [['document',420],['screen',90]])assert.equal((await server.send({type:'gyeote:prepare',mode},server.sender(1))).timeoutSeconds,seconds);const f=offscreen({policy:protocol(custom)});await f.run();assert.equal(JSON.parse(f.calls[0].options.body).timeout_seconds,420);});
test('origin 없는 관리자 인증은 raw offscreen에서 fetch 전에 거절한다',async()=>{for(const auth of [{mode:'admin',accessId:'one',session:{token,expiresAt}},{mode:'admin',accessId:'one',origin,session:{token,expiresAt}}]){const f=offscreen({auth});await f.run({documentAccess:'admin:ready:one'});assert.equal(f.calls.length,0);assert.equal(f.sent[0].type,'error');assert.equal(f.sent[0].error,'connection_failed');}});

test('운영 allowlist 패키지는 정적 origin·정확한 host·CSP를 일치시키고 기존 출력과 소스를 보존한다',()=>{
  assert.deepEqual(fs.readdirSync(packagePath).sort(),[...runtimeFiles].sort());
  const manifest=JSON.parse(read('manifest.json'));assert.deepEqual(manifest.host_permissions,[origin+'/*']);assert.deepEqual(manifest.permissions,JSON.parse(source('manifest.json')).permissions);assert.ok(manifest.permissions.includes('activeTab'));
  for(const name of ['options.html','offscreen.html']){assert.ok(read(name).includes('connect-src '+origin+';'));assert.ok(!read(name).includes('connect-src http:'));}
  assert.equal(protocol().documentOrigin(),origin);assert.equal(runtimeFiles.length,15);assert.ok(!runtimeFiles.includes('capture.js')&&!runtimeFiles.includes('image.js'));
  const before=read('protocol.js');assert.throws(()=>packageExtension({origin,name:path.basename(packagePath)}),/덮어쓰지/);assert.equal(read('protocol.js'),before);
  assert.throws(()=>packageExtension({origin,name:'../escape'}));assert.throws(()=>packageExtension({origin,name:'other',extra:true}));
  assert.equal(source('protocol.js'),sourceProtocol);
});

test('기본 설정은 HTTPS EC2와 원격 DOM을 사용한다',()=>{assert.equal(installed.documentOrigin(),'https://15.164.190.21');assert.equal(installed.documentTimeoutSeconds(),600);assert.equal(installed.screenTimeoutSeconds(),90);assert.equal(Object.hasOwn(installed,'documentSession'),false);assert.equal(Object.hasOwn(installed,'adminSession'),false);assert.deepEqual(JSON.parse(source('manifest.json')).host_permissions,[installed.documentOrigin()+'/*']);});

for(const value of ['http://api.example.invalid','http://127.0.0.1:8000','https://127.0.0.1:8443','https://localhost','https://[::1]:8443','https://a.invalid/path','https://a.invalid/','https://u:p@a.invalid','https://*.invalid','https://a.invalid?q=1','https://a.invalid#h','https://a.invalid;evil','https://a.invalid' + String.fromCharCode(39) + ';evil','https://bad_label.invalid','https://a.invalid:0','https://a.invalid:65536',' https://a.invalid','https://a.invalid\\other'])test('정적 origin 거절: '+value,()=>assert.throws(()=>installed.validateDocumentOrigin(value),/connection_configuration_invalid/));

test('원격 공개 질문은 연결 JSON·화면 토큰 없이 같은 서버에 맥락과 유한 기한을 전송한다',async()=>{
  const context={text:'합성 상담 요약',coveredThroughMessageId:'B'.repeat(20)+':assistant',profileRevision:1,batch:[],omitted:false};
  const payload={query:'합성 후속 질문',profile:{age:70},history:[{role:'user',content:'이전 질문'},{role:'assistant',content:'이전 답변'}],conversation_context:context};
  const f=offscreen();await f.run({payload,profileRevision:1});assert.equal(f.sent[0].type,'result');assert.equal(f.calls.length,1);
  const {url,options}=f.calls[0];assert.equal(url,origin+'/api/v1/chat/stream');assert.equal(options.headers.Authorization,undefined);assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');
  const body=JSON.parse(options.body);assert.equal(Object.hasOwn(payload,'profile'),true);assert.equal(Object.hasOwn(body,'profile'),false);assert.deepEqual(body.history,payload.history);assert.deepEqual(body.conversation_context,context);assert.ok(body.timeout_seconds>0&&body.timeout_seconds<=600);assert.ok(!f.messages.some(message=>message.type==='gyeote:connection'));
});

test('원격 패널은 화면 DOM을 지원하고 삭제된 캡처·연결 메시지는 응답하지 않는다',async()=>{const server=worker(undefined,{},read),f=ui(server);try{await f.ready();await f.mode('screen');assert.equal(f.root.querySelector('.mode').value,'screen');assert.equal(f.root.querySelector('.image-option'),null);for(const type of ['gyeote:capture','gyeote:connection','gyeote:process-image'])assert.equal(await server.send({type},server.sender(1)),undefined);}finally{f.close();}});

test('설정 오류는 fallback 없이 통신 0회와 안전한 오류로 종료한다',async()=>{
  const invalid=name=>name==='protocol.js'?read(name).replace(JSON.stringify(origin),JSON.stringify('http://other.invalid')):read(name);
  const f=offscreen({policy:protocol(invalid)});await f.run();assert.equal(f.calls.length,0);assert.equal(f.sent[0].error,'connection_configuration_invalid');
});

test('정적 기한은 문서 600초와 화면 90초를 유지한다',async()=>{assert.equal(protocol().documentTimeoutSeconds(),600);assert.equal(protocol().screenTimeoutSeconds(),90);for(const value of [0,1801,1.5,'600',NaN])assert.throws(()=>installed.validateDocumentTimeout(value));const customPath=packageExtension({origin,name:'t8-timeout-'+crypto.randomUUID(),timeoutSeconds:45}),custom=name=>fs.readFileSync(path.join(customPath,name),'utf8');const server=worker(undefined,{},custom);assert.equal((await server.send({type:'gyeote:prepare',mode:'document'},server.sender(1))).timeoutSeconds,45);assert.equal((await server.send({type:'gyeote:prepare',mode:'screen'},server.sender(1))).timeoutSeconds,45);const stopped=offscreen();await stopped.run({deadlineAt:Date.now()-1});assert.equal(stopped.calls.length,0);assert.equal(stopped.sent[0].error,'request_stopped');});

test('기존 관리자 선택·토큰은 원격 공개 접근에 반영하지 않고 관리자 메시지는 무시한다',async()=>{
 const calls=[],server=worker(undefined,{},read,async(url,options)=>{calls.push({url,options});return new Response('{}');}),options={id:'x',url:'chrome-extension://x/options.html'};
 for(const type of ['gyeote:admin-connect','gyeote:admin-check','gyeote:admin-logout'])assert.equal(await server.send({type,session:{token,expiresAt,origin}},options),undefined);
 Object.assign(server.session,{documentAccess:'admin',documentAdminSession:{token,expiresAt:1,origin:'https://other.invalid'}});
 const access=await server.send({type:'gyeote:document-access'});assert.equal(access.mode,'anonymous');assert.equal(access.status,'anonymous');assert.equal(access.origin,origin);assert.equal(JSON.stringify(access).includes(token),false);assert.equal(calls.length,0);
});

test('다른 서버 관리자 세션과 리다이렉트 실패는 결과로 반환하지 않는다',async()=>{
  const auth={mode:'admin',accessId:'one',origin,session:{token,expiresAt,origin:'https://other.invalid'}};
  const a=offscreen({auth});await a.run({documentAccess:'admin:ready:one'});assert.equal(a.calls.length,0);assert.equal(a.sent[0].error,'connection_failed');
  const b=offscreen({fetcher:async(_url,options)=>{assert.equal(options.redirect,'error');throw new TypeError('redirect blocked');}});await b.run();assert.equal(b.calls.length,1);assert.equal(b.sent[0].type,'error');
});

test('수신 중 origin이 바뀌면 늦은 답변을 반환하거나 상담에 저장하지 않는다',async()=>{
  const server=worker(undefined,{},read),f=ui(server);try{
    await f.ready();await f.question('합성 질문');const port=f.ports.at(-1);let release;const auth={mode:'anonymous',accessId:'public-1',origin};
    const transport=offscreen({auth,fetcher:()=>new Promise(resolve=>release=resolve)}),pending=transport.run(port.packet);await settle();
    auth.origin='https://other.invalid';release(new Response(JSON.stringify({kind:'answer',text:'늦은 답변',evidence:[]})));await pending;
    assert.equal(transport.sent[0].error,'document_access_changed');await port.receive(transport.sent[0]);await settle();
    assert.equal((server.data[key]?.conversations||[]).flatMap(conversation=>conversation.messages).length,0);assert.doesNotMatch(f.root.querySelector('.conversation').textContent,/늦은 답변/);
  }finally{f.close();}
});

test('원격 옵션은 서버 안내·관리자 웹 링크만 보이고 인증 통신을 하지 않는다',async()=>{
 const dom=new JSDOM(read('options.html'),{runScripts:'outside-only'}),w=dom.window,messages=[],calls=[];
 w.GyeoteProtocol=protocol();w.chrome={runtime:{sendMessage:async message=>messages.push(message)}};w.fetch=async(...args)=>{calls.push(args);throw Error('옵션 통신 금지');};w.eval(read('options.js'));
 try{w.dispatchEvent(new w.Event('focus'));await settle();assert.equal(calls.length,0);assert.deepEqual(messages,[]);assert.equal(w.document.querySelector('#file'),null);assert.equal(w.document.querySelector('#admin-form'),null);assert.equal(w.document.querySelector('#admin-password'),null);assert.ok(w.document.querySelector('#document-server').textContent.includes(origin));assert.equal(w.document.querySelector('a').href,'https://welfare-helper-iota.vercel.app/admin/documents');assert.ok(!w.document.body.textContent.includes(token));}finally{w.close();}
});
