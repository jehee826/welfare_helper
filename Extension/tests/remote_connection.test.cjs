const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {JSDOM}=require('../../FrontEnd/node_modules/jsdom');
const {worker,ui,source,settle,key}=require('./conversation_fixture.cjs');
const {packageExtension,runtimeFiles}=require('../package.cjs');
const local=require('../protocol.js'),origin='https://api.example.invalid',token='a'.repeat(40),expiresAt=Math.floor(Date.now()/1000)+600;
const packagePath=packageExtension({origin,name:'t8-test-'+crypto.randomUUID()}),read=name=>fs.readFileSync(path.join(packagePath,name),'utf8');
function protocol(readSource=read){const context={URL};vm.runInNewContext(readSource('protocol.js'),context);return context.GyeoteProtocol;}
function offscreen({auth={mode:'anonymous',accessId:'public-1',origin},fetcher=async()=>new Response(JSON.stringify({kind:'answer',text:'가상 답변',evidence:[]})),policy=protocol()}={}){
  let connect,receive;const sent=[],messages=[],calls=[];
  const chrome={runtime:{id:'x',onConnect:{addListener(fn){connect=fn;}},onMessage:{addListener(){}},sendMessage:async message=>{messages.push(message);if(message.type==='gyeote:document-auth')return typeof auth==='function'?auth():auth;if(message.type==='gyeote:connection')return {token,timeoutSeconds:30,imageEnabled:true};return {ok:true};}}};
  vm.runInNewContext(read('offscreen.js'),{chrome,GyeoteProtocol:policy,AbortController,setTimeout,clearTimeout,Uint8Array,TextDecoder,fetch:(url,options)=>{calls.push({url,options});return fetcher(url,options);}});
  connect({name:'gyeote:guide',sender:{id:'x',frameId:0,url:'https://www.bokjiro.go.kr/',tab:{url:'https://www.bokjiro.go.kr/'}},postMessage:value=>sent.push(value),disconnect(){},onMessage:{addListener(fn){receive=fn;}},onDisconnect:{addListener(){}}});
  return {sent,messages,calls,run:packet=>receive({requestId:'A'.repeat(20),mode:'document',documentAccess:'anonymous:anonymous:public-1',payload:{query:'합성 문서 질문',history:[]},...packet})};
}

test('운영 allowlist 패키지는 정적 origin·정확한 host·CSP를 일치시키고 기존 출력과 소스를 보존한다',()=>{
  assert.deepEqual(fs.readdirSync(packagePath).sort(),[...runtimeFiles].sort());
  const manifest=JSON.parse(read('manifest.json'));assert.deepEqual(manifest.host_permissions,[origin+'/*']);assert.deepEqual(manifest.permissions,JSON.parse(source('manifest.json')).permissions);assert.ok(manifest.permissions.includes('activeTab'));
  for(const name of ['options.html','offscreen.html']){assert.ok(read(name).includes('connect-src '+origin+';'));assert.ok(!read(name).includes('connect-src http:'));}
  assert.equal(protocol().documentOrigin(),origin);assert.equal(local.documentOrigin(),'http://127.0.0.1:8000');
  const before=read('protocol.js');assert.throws(()=>packageExtension({origin,name:path.basename(packagePath)}),/덮어쓰지/);assert.equal(read('protocol.js'),before);
  assert.throws(()=>packageExtension({origin,name:'../escape'}));assert.throws(()=>packageExtension({origin,name:'other',extra:true}));
  assert.ok(source('protocol.js').includes("const documentDeployment=Object.freeze({origin:'http://127.0.0.1:8000',timeoutSeconds:600});"));
});

for(const value of ['http://api.example.invalid','https://a.invalid/path','https://a.invalid/','https://u:p@a.invalid','https://*.invalid','https://a.invalid?q=1','https://a.invalid#h','https://a.invalid;evil','https://a.invalid' + String.fromCharCode(39) + ';evil','https://bad_label.invalid','https://a.invalid:0','https://a.invalid:65536',' https://a.invalid','https://a.invalid\\other'])test('정적 origin 거절: '+value,()=>assert.throws(()=>local.validateDocumentOrigin(value),/connection_configuration_invalid/));

test('원격 공개 질문은 연결 JSON·화면 토큰 없이 같은 서버에 맥락과 유한 기한을 전송한다',async()=>{
  const context={text:'합성 상담 요약',coveredThroughMessageId:'B'.repeat(20)+':assistant',profileRevision:1,batch:[],omitted:false};
  const payload={query:'합성 후속 질문',profile:{age:70},history:[{role:'user',content:'이전 질문'},{role:'assistant',content:'이전 답변'}],conversation_context:context};
  const f=offscreen();await f.run({payload,profileRevision:1});assert.equal(f.sent[0].type,'result');assert.equal(f.calls.length,1);
  const {url,options}=f.calls[0];assert.equal(url,origin+'/api/v1/chat');assert.equal(options.headers.Authorization,undefined);assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');
  const body=JSON.parse(options.body);assert.equal(body.profile.age,70);assert.deepEqual(body.history,payload.history);assert.deepEqual(body.conversation_context,context);assert.ok(body.timeout_seconds>0&&body.timeout_seconds<=600);assert.ok(!f.messages.some(message=>message.type==='gyeote:connection'));
});

test('원격 패널은 JSON 없이 공개 상담하며 화면 선택·수집을 차단한다',async()=>{
  const server=worker(undefined,{},read),f=ui(server);try{
    Object.defineProperty(server.session,'connection',{get(){throw Error('화면 연결 읽기 금지');}});
    await f.ready();assert.equal(f.root.querySelector('.mode option[value=screen]').disabled,true);assert.match(f.root.querySelector('.scope-notice').textContent,/원격 화면 안내를 제공하지/);
    await f.question('합성 공개 상담');assert.equal(f.ports.length,1);assert.equal(f.ports[0].packet.mode,'document');await f.answer({kind:'answer',text:'가상 답변',evidence:[]});
    f.w.GyeoteDOM={...f.w.GyeoteDOM,collect(){assert.fail('원격 화면 수집 금지');}};
    await f.mode('screen');assert.equal(f.root.querySelector('.mode').value,'document');assert.equal(f.ports.length,1);
  }finally{f.close();}
});

test('원격 화면·이미지·주소 주입은 worker와 offscreen에서 전송 0회로 거절한다',async()=>{
  const server=worker(undefined,{},read),sender=server.sender(1);
  assert.equal((await server.send({type:'gyeote:prepare',mode:'screen'},sender)).error,'remote_screen_unavailable');
  assert.equal((await server.send({type:'gyeote:capture'},sender)).error,'remote_screen_unavailable');
  assert.equal((await server.send({type:'gyeote:prepare',mode:'document',origin:'https://other.invalid'},sender)).ok,false);
  for(const packet of [{mode:'screen',payload:{image:'iVBORw0KGgo='}},{origin:'https://other.invalid'},{payload:{query:'합성 질문',origin:'https://other.invalid'}}]){
    const f=offscreen();await f.run(packet);assert.equal(f.calls.length,0);assert.equal(f.sent[0].type,'error');
  }
});

test('원격 아이콘 토글은 기존 권한으로 열고 닫으며 캡처·화면 전송은 계속 차단한다',async()=>{
  const server=worker(undefined,{},read),f=ui(server);try{
    await f.ready();const tab={id:1,url:'https://www.bokjiro.go.kr/'};
    await server.click(tab);await settle();assert.equal(f.root.querySelector('.panel').hidden,true);
    await server.click(tab);await settle();assert.equal(f.root.querySelector('.panel').hidden,false);assert.equal(f.root.activeElement,f.root.querySelector('#gyeote-question'));
    assert.equal((await server.send({type:'gyeote:capture'},server.sender(1))).error,'remote_screen_unavailable');
    const transport=offscreen();await transport.run({mode:'screen',payload:{image:'iVBORw0KGgo='}});assert.equal(transport.sent[0].error,'remote_screen_unavailable');assert.equal(transport.calls.length,0);assert.equal(f.ports.length,0);
  }finally{f.close();}
});

test('설정 오류는 fallback 없이 통신 0회와 안전한 오류로 종료한다',async()=>{
  const invalid=name=>name==='protocol.js'?read(name).replace(JSON.stringify(origin),JSON.stringify('http://other.invalid')):read(name);
  const f=offscreen({policy:protocol(invalid)});await f.run();assert.equal(f.calls.length,0);assert.equal(f.sent[0].error,'connection_configuration_invalid');
});

test('정적 기한은 원격 기본600초·지정값을 양쪽에서 사용하고 local JSON은 호환한다',async()=>{
  assert.equal(protocol().documentTimeoutSeconds(null),600);assert.equal(local.documentTimeoutSeconds(null),90);assert.equal(local.documentTimeoutSeconds({timeoutSeconds:120}),120);
  for(const value of [0,1801,1.5,'600',NaN])assert.throws(()=>local.validateDocumentTimeout(value));
  for(const value of [1,1800])assert.equal(local.validateDocumentTimeout(value),value);
  for(const value of ['https://127.0.0.1:8443','https://[::1]:8443'])assert.equal(local.validateDocumentOrigin(value),value);
  const customPath=packageExtension({origin,name:'t8-timeout-'+crypto.randomUUID(),timeoutSeconds:420}),custom=name=>fs.readFileSync(path.join(customPath,name),'utf8');
  const server=worker(undefined,{},custom),prepared=await server.send({type:'gyeote:prepare',mode:'document'},server.sender(1));assert.equal(prepared.timeoutSeconds,420);
  const f=offscreen({policy:protocol(custom)});await f.run();assert.equal(JSON.parse(f.calls[0].options.body).timeout_seconds,420);
  const localPath=packageExtension({origin:'http://127.0.0.1:8000',name:'t8-local-'+crypto.randomUUID()});
  assert.equal(protocol(name=>fs.readFileSync(path.join(localPath,name),'utf8')).documentTimeoutSeconds(null),90);
  const stopped=offscreen();await stopped.run({deadlineAt:Date.now()-1});assert.equal(stopped.calls.length,0);assert.equal(stopped.sent[0].error,'request_stopped');
});

test('관리자 세션은 문서 origin에 묶이며 local 구버전만 호환한다',async()=>{
  assert.equal(local.documentSession({token,expiresAt}),true);assert.equal(protocol().documentSession({token,expiresAt}),false);
  const calls=[],server=worker(undefined,{},read,async(url,options)=>{calls.push({url,options});return new Response('{}');}),options={id:'x',url:'chrome-extension://x/options.html'};
  for(const session of [{token,expiresAt},{token,expiresAt,origin:'https://other.invalid'},{token,expiresAt,origin,extra:1}])assert.equal((await server.send({type:'gyeote:admin-connect',session},options)).ok,false);
  assert.equal((await server.send({type:'gyeote:admin-connect',session:{token,expiresAt,origin}},options)).ok,true);
  await server.send({type:'gyeote:admin-check'},options);await server.send({type:'gyeote:admin-logout'},options);
  assert.deepEqual(calls.map(call=>call.url),[origin+'/api/v1/admin/session',origin+'/api/v1/admin/logout']);
  for(const {options} of calls){assert.equal(options.headers.Authorization,'Bearer '+token);assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');}
  server.session.documentAccess='admin';server.session.documentAdminSession={token,expiresAt,origin:'https://other.invalid'};
  assert.equal((await server.send({type:'gyeote:admin-check'},options)).status,'expired');assert.equal(server.session.documentAdminSession,null);assert.equal(calls.length,2);
});

test('다른 서버 관리자 세션과 리다이렉트 실패는 결과로 반환하지 않는다',async()=>{
  const auth={mode:'admin',accessId:'one',origin,session:{token,expiresAt,origin:'https://other.invalid'}};
  const a=offscreen({auth});await a.run({documentAccess:'admin:ready:one'});assert.equal(a.calls.length,0);assert.equal(a.sent[0].error,'document_auth_required');
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

test('원격 옵션 로그인만 비밀번호를 보내고 세션 origin을 붙이며 화면 JSON을 읽지 않는다',async()=>{
  const dom=new JSDOM(read('options.html'),{runScripts:'outside-only'}),w=dom.window,messages=[],calls=[];
  w.GyeoteProtocol=protocol();w.AbortController=AbortController;w.chrome={storage:{session:{set:async()=>assert.fail('화면 토큰 저장 금지')}},runtime:{sendMessage:async message=>{messages.push(message);return {ok:true,mode:message.type==='gyeote:admin-connect'?'admin':'anonymous',status:'ready'};}}};
  w.fetch=async(url,options)=>{calls.push({url,options});assert.equal(w.document.querySelector('#admin-password').value,'');return new Response(JSON.stringify({access_token:token,expires_at:expiresAt}));};
  w.eval(read('options.js'));try{
    assert.equal(calls.length,0);assert.equal(w.document.querySelector('#file').disabled,true);
    Object.defineProperty(w.document.querySelector('#file'),'files',{value:[{text:async()=>assert.fail('원격 패키지에서 화면 JSON 읽기 금지')}]});w.document.querySelector('#file').dispatchEvent(new w.Event('change'));await settle();
    w.document.querySelector('#admin-password').value='합성 비밀번호';w.document.querySelector('#admin-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();
    assert.equal(calls.length,1);assert.equal(calls[0].url,origin+'/api/v1/admin/login');assert.equal(calls[0].options.redirect,'error');assert.equal(messages.find(message=>message.type==='gyeote:admin-connect').session.origin,origin);assert.ok(!w.document.body.textContent.includes(token));
  }finally{w.close();}
});
