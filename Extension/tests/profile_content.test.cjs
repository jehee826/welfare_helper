const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('../../FrontEnd/node_modules/jsdom'),protocol=require('../protocol.js');
const source=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8'),plain=value=>JSON.parse(JSON.stringify(value));
const key='gyeote.profile',profile={age:70,income:'unknown',household:'single',region:'서울특별시',disability:null};
const saved=(revision=1,value=profile)=>({schemaVersion:1,revision,onboardingCompleted:true,profile:value});
const settle=async()=>{for(let i=0;i<4;i++)await new Promise(setImmediate);};
function fixture(data={},failure={}){
 const dom=new JSDOM('<main><button>공개 메뉴</button></main>',{url:'https://www.bokjiro.go.kr/',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
 w.Element.prototype.getBoundingClientRect=()=>({x:40,y:60,left:40,top:60,right:180,bottom:100,width:140,height:40});
 const computed=w.getComputedStyle.bind(w);w.getComputedStyle=node=>{const s=computed(node);return {display:s.display,visibility:s.visibility||'visible',opacity:s.opacity||'1',position:s.position||'static'};};
 w.document.elementFromPoint=()=>w.document.querySelector('main button');w.requestAnimationFrame=fn=>{queueMicrotask(fn);return 1;};w.cancelAnimationFrame=()=>{};
 w.Storage.prototype.getItem=w.Storage.prototype.setItem=()=>{throw Error('호스트 저장소 사용 금지');};
 w.TextEncoder=TextEncoder;
 for(const name of ['protocol.js','conversations.js','dom.js','capture.js','profile.js','conversation-panel.js','input-assist.js'])w.eval(source(name));
 let root,workerListener,changed,contentListener,captureHidden=false;const ports=[],runtimeMessages=[],calls={get:0,set:0};
 const attach=w.Element.prototype.attachShadow;w.Element.prototype.attachShadow=function(options){const r=attach.call(this,options);if(this.hasAttribute('data-gyeote-host'))root=r;return r;};
 const session={connection:{token:'x'.repeat(40),timeoutSeconds:30,imageEnabled:true}};
 const workerChrome={runtime:{id:'x',getURL:name=>'chrome-extension://x/'+name,onMessage:{addListener(fn){workerListener=fn;}},sendMessage:async message=>runtimeMessages.push(message),getContexts:async()=>[{}]},
 storage:{local:{setAccessLevel:async()=>{},get:async name=>{calls.get++;if(failure.get)throw Error('가상 읽기 실패');return {[name]:data[name]};},set:async value=>{calls.set++;if(failure.set)throw Error('가상 저장 실패');const changes={};for(const [name,item] of Object.entries(value))changes[name]={oldValue:data[name],newValue:item};Object.assign(data,plain(value));changed(changes,'local');}},session:{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(name=>[name,session[name]])),set:async value=>Object.assign(session,value)},onChanged:{addListener(fn){changed=fn;}}},
 tabs:{query:async()=>[{id:1}],sendMessage:async(_id,message)=>contentListener?.(message,{id:'x'},()=>{})},action:{onClicked:{addListener(){}}}};
 const sandbox={chrome:workerChrome,GyeoteProtocol:protocol,URL,TextEncoder,crypto:require('node:crypto').webcrypto,fetch:()=>{throw Error('실제 통신 금지');},AbortController,setTimeout,clearTimeout};
 const context=vm.createContext(sandbox);sandbox.importScripts=(...names)=>names.forEach(name=>vm.runInContext(source(name),context));vm.runInContext(source('worker.js'),context);
 const sender={id:'x',frameId:0,url:'https://www.bokjiro.go.kr/',tab:{id:1,url:'https://www.bokjiro.go.kr/'}};
 const send=message=>new Promise(resolve=>{if(!workerListener(message,sender,resolve))resolve(undefined);});
 w.chrome={runtime:{id:'x',onMessage:{addListener(fn){contentListener=fn;}},sendMessage:async message=>{
  if(message.type==='gyeote:capture'){captureHidden=w.document.querySelector('[data-gyeote-host]').style.visibility==='hidden';return {ok:true,image:'iVBORAAAA'};}
  return send(message);
 },connect:()=>{const port={onMessage:{addListener(fn){port.receive=fn;}},onDisconnect:{addListener(fn){port.disconnectedListener=fn;}},postMessage(message){port.packet=plain(message);},disconnect(){port.disconnected=true;port.disconnectedListener?.();}};ports.push(port);return port;}}};
 w.eval(source('content.js'));
 const find=text=>[...root.querySelectorAll('button')].find(node=>node.textContent===text);
 return {w,root,data,failure,calls,ports,runtimeMessages,ready:settle,send,click:async text=>{assert.ok(find(text),text);find(text).click();await settle();},
  save:async changes=>{for(const [name,value] of Object.entries(changes)){const control=root.querySelector('.profile-panel [name='+name+']');control.value=value;control.dispatchEvent(new w.Event('change'));}root.querySelector('.profile-panel form').dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();},
  question:async text=>{root.querySelector('#gyeote-question').value=text;root.querySelector('#gyeote-question').closest('form').dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();},
  answer:async(body,port=ports.at(-1))=>{await port.receive({type:'result',requestId:port.packet.requestId,body});await settle();},
  error:async(code,port=ports.at(-1))=>{await port.receive({type:'error',requestId:port.packet.requestId,error:code});await settle();},
  mode:async mode=>{const select=root.querySelector('.mode');select.value=mode;select.dispatchEvent(new w.Event('change'));await settle();},
  spoof:()=>contentListener({type:'gyeote:profile-changed'},{id:'foreign'},()=>{}),capturedHidden:()=>captureHidden,
  notify:revision=>contentListener({type:'gyeote:profile-changed',revision},{id:'x'},()=>{}),
  close:()=>{w.dispatchEvent(new w.Event('pagehide'));w.close();}};
}

test('기본 상담·선택적 최초 폼·수정·삭제와 UI 대역 재생성 복원을 확인한다',async()=>{
 const data={},f=fixture(data);try{
  await f.ready();assert.equal(f.root.querySelector('.mode').value,'document');
  assert.equal(f.root.querySelector('[name=age]').value,'');assert.equal(f.root.querySelector('[name=household]').value,'');assert.equal(f.root.querySelector('[name=region]').value,'');assert.equal(f.root.querySelector('[name=disability]').value,'');
  assert.equal(f.root.querySelector('#gyeote-question').closest('form').hidden,true);
  await f.save({age:'70',household:'single',region:'서울특별시'});assert.deepEqual(data[key],saved());
  assert.equal(f.root.querySelector('#gyeote-question').closest('form').hidden,false);assert.equal(f.root.querySelector('.profile-panel form'),null);
 }finally{f.close();}
 const g=fixture(data);try{
  await g.ready();assert.match(g.root.querySelector('.profile-panel').textContent,/70세/);
  await g.click('내 정보 수정');await g.save({age:'71'});assert.equal(data[key].revision,2);assert.equal(data[key].profile.age,71);
  await g.click('내 정보 삭제');assert.equal(data[key].revision,3);assert.equal(data[key].onboardingCompleted,false);assert.equal(data[key].profile,null);assert.ok(g.root.querySelector('.profile-panel form'));
  assert.deepEqual(Object.keys(data),[key]);
 }finally{g.close();}
});

test('나중 입력은 저장 성공 후 상담을 열고 문서에만 nullable 조건을 전송한다',async()=>{
 const f=fixture();try{await f.ready();await f.click('나중에 입력');assert.equal(f.data[key].onboardingCompleted,true);assert.equal(f.data[key].profile,null);
  await f.question('문서 내용은?');assert.equal(f.ports.length,1);assert.equal(f.ports[0].packet.payload.profile,null);assert.equal(f.ports[0].packet.mode,'document');
  assert.ok(!('candidates' in f.ports[0].packet.payload));await f.answer({kind:'answer',text:'가상 문서 답변',evidence:[]});
  assert.match(f.root.querySelector('.conversation').textContent,/가상 문서 답변/);assert.deepEqual(Object.keys(f.data),[key,'gyeote.conversations']);
 }finally{f.close();}
});

test('저장 실패 시 입력·첫 이용 상태를 유지하고 재시도 성공 후에만 폼을 닫는다',async()=>{
 const f=fixture({}, {set:true});try{await f.ready();await f.save({age:'55'});
  assert.equal(f.data[key],undefined);assert.equal(f.root.querySelector('[name=age]').value,'55');assert.match(f.root.querySelector('.profile-error').textContent,/저장하거나 읽지 못했습니다/);
  assert.equal(f.root.querySelector('#gyeote-question').closest('form').hidden,true);
  f.failure.set=false;await f.save({});assert.equal(f.data[key].profile.age,55);assert.equal(f.root.querySelector('.profile-panel form'),null);
 }finally{f.close();}
});

test('모르는 조건을 강제하지 않고 범위 밖·소수 나이는 저장 전에 거절한다',async()=>{
 const f=fixture();try{await f.ready();
  for(const age of ['121','-1','1.5']){await f.save({age});assert.equal(f.data[key],undefined);assert.match(f.root.querySelector('.profile-error').textContent,/0~120/);assert.equal(f.root.activeElement.name,'age');}
  await f.save({age:''});assert.deepEqual(f.data[key].profile,{age:null,income:'unknown',household:null,region:null,disability:null});
 }finally{f.close();}
});

test('복수 탭 충돌은 편집 중 입력을 보존하고 최신 정보 확인을 요구한다',async()=>{
 const f=fixture({[key]:saved()});try{await f.ready();await f.click('내 정보 수정');f.root.querySelector('[name=age]').value='66';
  await f.send({type:'gyeote:profile-save',expectedRevision:1,profile:{...profile,age:40}});await settle();
  assert.equal(f.root.querySelector('[name=age]').value,'66');assert.match(f.root.querySelector('.profile-error').textContent,/다른 탭/);
  await f.save({});assert.equal(f.data[key].profile.age,40);assert.equal(f.data[key].revision,2);
  await f.click('최신 정보 다시 불러오기');assert.match(f.root.querySelector('.profile-panel').textContent,/40세/);
 }finally{f.close();}
});

for(const notify of [true,false])test('revision 변경 후 늦은 답변은 표시·이력에 반영하지 않는다, 통지='+notify,async()=>{
 const f=fixture({[key]:saved()});try{await f.ready();await f.question('첫 질문');const old=f.ports[0];
  if(notify)await f.send({type:'gyeote:profile-save',expectedRevision:1,profile:{...profile,age:40}});
  else f.data[key]=saved(2,{...profile,age:40});
  await settle();await f.answer({kind:'answer',text:'늦은 예전 답변',evidence:[]},old);
  assert.ok(!f.root.querySelector('.conversation').textContent.includes('늦은 예전 답변'));
  await f.question('새 질문');const current=f.ports.at(-1).packet;
  assert.equal(current.payload.profile.age,40);assert.equal(current.payload.history.length,0);assert.deepEqual(Object.keys(f.data),[key]);
 }finally{f.close();}
});

test('손상 저장은 자동 삭제하지 않고 명시적 재설정 후 최초 폼을 제공한다',async()=>{
 const raw={schemaVersion:2,revision:5,profile},f=fixture({[key]:raw});try{await f.ready();assert.deepEqual(f.data[key],raw);assert.equal(f.calls.set,0);
  assert.match(f.root.querySelector('.profile-error').textContent,/저장된 정보를 읽을 수 없습니다/);await f.click('손상된 내 정보 재설정');
  assert.equal(f.data[key].revision,6);assert.equal(f.data[key].onboardingCompleted,false);assert.ok(f.root.querySelector('[name=age]'));
 }finally{f.close();}
});

test('화면 모드는 조건 미전송·폼 수집 제외·캡처 중 패널 숨김을 유지한다',async()=>{
 const f=fixture({[key]:saved()});try{await f.ready();await f.mode('screen');
  assert.equal(f.root.querySelector('.profile-panel').hidden,true);
  assert.ok(!JSON.stringify(f.w.GyeoteDOM.collect('공개 메뉴').payload).includes('서울특별시'));
  f.root.querySelector('.image-option').checked=true;await f.question('공개 메뉴는 어디야?');
  const packet=f.ports.at(-1).packet;assert.equal(packet.mode,'screen');assert.ok(!('profile' in packet.payload));assert.ok(!JSON.stringify(packet.payload).includes('서울특별시'));
  assert.equal(f.capturedHidden(),true);assert.equal(packet.payload.image,'iVBORAAAA');
 }finally{f.close();}
});

test('위조한 프로필 변경 통지는 진행 중 질문을 취소하지 않는다',async()=>{
 const f=fixture({[key]:saved()});try{await f.ready();await f.question('문서 질문');const port=f.ports[0],reads=f.calls.get;
  f.spoof();await settle();assert.equal(port.disconnected,undefined);assert.equal(f.calls.get,reads);
  await f.answer({kind:'answer',text:'현재 답변',evidence:[]});assert.match(f.root.querySelector('.conversation').textContent,/현재 답변/);
 }finally{f.close();}
});

test('통지가 누락된 조건 변경 뒤 오류는 안전하게 즉시 표시한다',async()=>{
 const f=fixture({[key]:saved()});try{await f.ready();await f.question('문서 질문');const old=f.ports[0];
  f.data[key]=saved(2,{...profile,age:40});await f.error('generation_failed',old);
  assert.match(f.root.querySelector('.status').textContent,/문서 검색이나 답변 처리에 실패/);
  assert.equal(f.root.querySelector('#gyeote-question').closest('form').querySelector('[type=submit]').disabled,false);
 }finally{f.close();}
});

test('같은 revision의 지연 통지는 삭제 후 폼과 새 요청을 방해하지 않는다',async()=>{
 const f=fixture({[key]:saved()});try{await f.ready();await f.click('내 정보 삭제');f.notify(2);await settle();assert.equal(f.root.querySelector('.profile-error').textContent,'');
  await f.click('나중에 입력');await f.question('새 질문');const port=f.ports.at(-1);assert.equal(port.packet.profileRevision,3);
  f.notify(3);await settle();assert.equal(port.disconnected,undefined);
  await f.answer({kind:'answer',text:'현재 답변',evidence:[]});assert.match(f.root.querySelector('.conversation').textContent,/현재 답변/);
 }finally{f.close();}
});
