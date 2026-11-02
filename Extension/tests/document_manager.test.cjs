const {test}=require('node:test'),assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const plain=value=>JSON.parse(JSON.stringify(value));
const source=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8');
const settle=async()=>{for(let i=0;i<6;i++)await new Promise(setImmediate);};
function worker(data={},failure={}){
  let listener,changed;const clients=new Map(),calls={get:[],set:[],openTabs:[],optionsOpened:0};
  const session={documentAccess:'anonymous',documentAccessId:'public-1'};
  const chrome={runtime:{id:'x',getURL:name=>'chrome-extension://x/'+name,
    onMessage:{addListener(fn){listener=fn;}},sendMessage:async()=>{},
    openOptionsPage:async()=>{calls.optionsOpened++;}},
    storage:{local:{setAccessLevel:async()=>{},get:async key=>{calls.get.push(key);return {[key]:data[key]};},
      set:async values=>{calls.set.push(plain(values));Object.assign(data,plain(values));}},
      session:{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,session[key]])),set:async values=>Object.assign(session,plain(values))},
      onChanged:{addListener(fn){changed=fn;}}},
    tabs:{create:async options=>{calls.openTabs.push(plain(options));if(failure.createTab)throw Error('private tab error');return {id:2};},
      query:async()=>[...clients.keys()].map(id=>({id})),sendMessage:async(id,message)=>clients.get(id)?.(message,{id:'x'},()=>{})},
    action:{onClicked:{addListener(){}}}};
  const sandbox={chrome,URL,TextEncoder,crypto:require('node:crypto').webcrypto,setTimeout,clearTimeout,fetch:()=>{throw Error('실제 통신 금지');}};
  const context=vm.createContext(sandbox);
  sandbox.importScripts=(...names)=>names.forEach(name=>vm.runInContext(source(name),context));
  vm.runInContext(source('worker.js'),context);
  const sender=id=>({id:'x',frameId:0,url:'https://www.bokjiro.go.kr/',tab:{id,url:'https://www.bokjiro.go.kr/'}});
  const send=(message,from=sender(1))=>new Promise(resolve=>{if(!listener(plain(message),from,value=>resolve(plain(value))))resolve(undefined);});
  return {data,failure,session,calls,clients,sender,send};
}
function ui(server){
  // 검사는 저장소 루트에서 실행한다. 별도 인덱스의 소스도 같은 설치된 jsdom으로 검증한다.
  const {JSDOM}=require(path.resolve('FrontEnd/node_modules/jsdom'));
  const dom=new JSDOM('<main>공개 안내</main>',{url:'https://www.bokjiro.go.kr/',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
  let root;const ports=[],requests=[];w.TextEncoder=TextEncoder;
  const attach=w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow=function(options){const result=attach.call(this,options);if(this.hasAttribute('data-gyeote-host'))root=result;return result;};
  w.chrome={runtime:{id:'x',onMessage:{addListener(fn){server.clients.set(1,fn);}},sendMessage:message=>{requests.push(plain(message));return server.send(message);},connect:()=>{ports.push({});throw Error('이 검사에서는 모델 요청 금지');}}};
  const manifest=JSON.parse(source('manifest.json'));
  for(const name of manifest.content_scripts[0].js)w.eval(source(name));
  const button=text=>[...root.querySelectorAll('button')].find(node=>node.textContent===text);
  return {w,root,ports,requests,ready:settle,button,
    click:async text=>{const node=button(text);assert.ok(node,text);node.click();await settle();},
    mode:async value=>{const node=root.querySelector('.mode');node.value=value;node.dispatchEvent(new w.Event('change'));await settle();},
    close:()=>{w.dispatchEvent(new w.Event('pagehide'));server.clients.delete(1);w.close();}};
}
const request={type:'gyeote:document-manager'};
const url='https://welfare-helper-iota.vercel.app/admin/documents';

test('worker는 고정 관리자 경로만 열고 세션·프로필·대화 저장소를 읽지 않는다',async()=>{
  const f=worker({'gyeote.profile':{private:'synthetic-profile'},'gyeote.conversations':{private:'synthetic-conversation'}});
  f.session.documentAccess='admin';f.session.documentAdminSession={token:'a'.repeat(40),expiresAt:Math.floor(Date.now()/1000)+600};
  const before=plain(f.data),session=plain(f.session);
  assert.deepEqual(await f.send(request),{ok:true});assert.deepEqual(f.calls.openTabs,[{url}]);
  assert.equal(new URL(f.calls.openTabs[0].url).search,'');assert.equal(new URL(f.calls.openTabs[0].url).hash,'');
  assert.deepEqual(f.calls.get,[]);assert.deepEqual(f.calls.set,[]);assert.deepEqual(f.data,before);assert.deepEqual(f.session,session);assert.equal(f.calls.optionsOpened,0);
});

test('공식 복지로의 최상위 동일탭 sender 외에는 관리자 탭을 열지 않는다',async()=>{
  const f=worker();
  for(const changed of [{id:'foreign'},{frameId:1},{url:'https://www.bokjiro.go.kr.evil.invalid/'},{url:'chrome-extension://x/options.html'},{url:'chrome-extension://x/offscreen.html'},{tab:{id:1,url:'https://www.bokjiro.go.kr/another'}},{tab:{url:'https://www.bokjiro.go.kr/'}},{tab:{id:-1,url:'https://www.bokjiro.go.kr/'}},{tab:undefined}]){
    assert.equal(await f.send(request,{...f.sender(1),...changed}),undefined);
  }
  assert.deepEqual(f.calls.openTabs,[]);
});

test('임의 URL·세션·프로필·대화·요약 필드를 거절하고 입력을 오류에 노출하지 않는다',async()=>{
  const f=worker();
  for(const fields of [{url:'https://example.invalid/?token=private'},{token:'private-token'},{password:'private-password'},{profile:{age:70}},{history:[{role:'user',content:'synthetic-private'}]},{summary:'synthetic-private'}]){
    assert.deepEqual(await f.send({...request,...fields}),{ok:false,error:'invalid_manager_request'});
  }
  assert.deepEqual(f.calls.openTabs,[]);assert.deepEqual(f.calls.get,[]);
});

test('탭 열기 실패는 안전한 오류이며 다음 시도를 막지 않는다',async()=>{
  const f=worker(undefined,{createTab:true});
  assert.deepEqual(await f.send(request),{ok:false,error:'document_manager_open_failed'});
  f.failure.createTab=false;assert.deepEqual(await f.send(request),{ok:true});assert.equal(f.calls.openTabs.length,2);
});

test('패널 문서 관리와 연결 설정은 별개이며 관리자 로그인 전에도 진입 버튼을 제공한다',async()=>{
  const server=worker({}),f=ui(server);try{
    await f.ready();assert.ok(f.button('관리자 접근'));
    await f.click('관리자 접근');assert.deepEqual(server.calls.openTabs,[{url}]);
    assert.deepEqual(f.requests.filter(m=>m.type===request.type),[request]);assert.equal(server.calls.optionsOpened,0);
    await f.click('확장 옵션');assert.equal(server.calls.optionsOpened,1);assert.equal(server.calls.openTabs.length,1);
    await f.mode('screen');await f.click('관리자 접근');assert.equal(server.calls.openTabs.length,2);assert.equal(f.ports.length,0);assert.deepEqual(server.data,{});
  }finally{f.close();}
});

test('패널은 열기 실패를 표시하고 초안·저장값을 보존한 채 다시 시도한다',async()=>{
  const server=worker(),f=ui(server);try{
    await f.ready();const draft=f.root.querySelector('#gyeote-question');draft.value='작성 중인 질문';const before=plain(server.data);
    server.failure.createTab=true;await f.click('관리자 접근');assert.match(f.root.querySelector('.status').textContent,/문서 관리 페이지를 열지 못했습니다/);
    assert.equal(f.button('관리자 접근').disabled,false);assert.equal(draft.value,'작성 중인 질문');assert.deepEqual(server.data,before);assert.equal(f.ports.length,0);
    server.failure.createTab=false;await f.click('관리자 접근');assert.equal(server.calls.openTabs.length,2);assert.equal(f.button('관리자 접근').disabled,false);assert.match(f.root.querySelector('.status').textContent,/문서 관리용 새 탭을 열었습니다/);
  }finally{f.close();}
});
