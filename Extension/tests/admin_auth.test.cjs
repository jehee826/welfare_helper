const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('../../FrontEnd/node_modules/jsdom');const protocol=require('../protocol.js');const source=n=>fs.readFileSync(path.join(__dirname,'..',n),'utf8');
const token='a'.repeat(40),session={token,expiresAt:Math.floor(Date.now()/1000)+3600,origin:protocol.documentOrigin()};
function worker(){let listener,changed,queryArg;const data={},tabMessages=[];const storage={async get(keys){const list=Array.isArray(keys)?keys:[keys];return Object.fromEntries(list.map(k=>[k,data[k]]))},async set(values){Object.assign(data,values)}};const chrome={runtime:{id:'x',getURL:n=>'chrome-extension://x/'+n,onMessage:{addListener(fn){listener=fn}},sendMessage:async()=>{},getContexts:async()=>[{}]},storage:{session:storage,onChanged:{addListener(fn){changed=fn}}},tabs:{query:async(arg)=>{queryArg=arg;return [{id:1}]},sendMessage:async(_id,msg)=>{tabMessages.push(msg)}},action:{onClicked:{addListener(){}}},offscreen:{createDocument:async()=>{}}};vm.runInNewContext(source('worker.js'),{chrome,GyeoteProtocol:protocol,importScripts(){},fetch:async()=>new Response('{}'),AbortController,setTimeout,clearTimeout,URL,crypto:require("node:crypto").webcrypto});const send=(msg,sender)=>new Promise(resolve=>{const ret=listener(msg,{id:'x',...sender},resolve);if(!ret)resolve(undefined)});return {data,send,tabMessages,query:()=>queryArg,notify:(changes={documentAccessId:{newValue:data.documentAccessId}})=>changed(changes,'session'),options:{url:'chrome-extension://x/options.html'},internal:{url:'chrome-extension://x/offscreen.html'},content:{frameId:0,url:'https://www.bokjiro.go.kr/',tab:{url:'https://www.bokjiro.go.kr/'}}}}
test('삭제한 관리자 메시지는 옵션에서도 무시하고 내부 접근 응답에는 토큰을 싣지 않는다',async()=>{
 const f=worker();
 for(const sender of [f.content,f.options,f.internal])for(const type of ['gyeote:admin-connect','gyeote:admin-check','gyeote:admin-logout','gyeote:admin-invalid'])assert.equal(await f.send({type,session,token},sender),undefined);
 assert.equal(await f.send({type:'gyeote:document-auth'},f.content),undefined);
 const access=await f.send({type:'gyeote:document-access'},f.content),internal=await f.send({type:'gyeote:document-auth'},f.internal);
 assert.equal(access.mode,'anonymous');assert.equal(access.status,'anonymous');assert.equal(internal.mode,'anonymous');assert.equal(Object.hasOwn(internal,'session'),false);assert.equal(JSON.stringify([access,internal]).includes(token),false);
});
test('기존 관리자 선택과 만료 여부는 공개 상담 접근을 막거나 토큰을 전달하지 않는다',async()=>{
 for(const expiresAt of [1,session.expiresAt]){
  const f=worker();Object.assign(f.data,{documentAccess:'admin',documentAccessId:'legacy',documentAdminSession:{...session,expiresAt}});
  const access=await f.send({type:'gyeote:document-access'},f.content);assert.equal(access.mode,'anonymous');assert.equal(access.status,'anonymous');assert.equal(access.accessId,'legacy');assert.equal(JSON.stringify(access).includes(token),false);
 }
});
function offscreen(auth,connection,fetcher,runtime={}){auth.origin??=protocol.documentOrigin();let connect,receive,disconnect,onMessage;const sent=[],runtimeMessages=[];const chrome={runtime:{id:'x',onConnect:{addListener(fn){connect=fn}},onMessage:{addListener(fn){onMessage=fn}},sendMessage:async(msg)=>{runtimeMessages.push(msg);return msg.type==='gyeote:connection'?connection:msg.type==='gyeote:document-auth'?auth:{ok:true}}}};vm.runInNewContext(source('offscreen.js'),{chrome,GyeoteProtocol:protocol,AbortController,setTimeout,clearTimeout,fetch:fetcher,Uint8Array,TextDecoder,Blob,...runtime});const port={name:'gyeote:guide',sender:{id:'x',frameId:0,url:'https://www.bokjiro.go.kr/',tab:{url:'https://www.bokjiro.go.kr/'}},postMessage(x){sent.push(x)},disconnect(){disconnect?.()},onMessage:{addListener(fn){receive=fn}},onDisconnect:{addListener(fn){disconnect=fn}}};connect(port);return {sent,runtimeMessages,run:(mode,access)=>receive({requestId:'A'.repeat(20),mode,...(mode==='document'?{documentAccess:access===undefined?'anonymous:anonymous:initial':access}:{}),payload:mode==='document'?{query:'질문',history:[]}:{source:'dom',snapshot_id:'F'.repeat(20),question:'질문',screen_context:[],candidates:[]}}),changed:()=>onMessage({target:'gyeote:offscreen',type:'gyeote:auth-changed'},{id:'x'})}}
test('공개 문서와 화면 요청은 남은 세션 값과 무관하게 인증 헤더를 보내지 않는다',async()=>{
 for(const [mode,auth] of [['document',{mode:'anonymous',session}],['screen',{mode:'admin',session}]]){
  let calls=0;const f=offscreen(auth,null,async(_u,o)=>{calls++;assert.equal(o.headers.Authorization,undefined);assert.equal(o.credentials,'omit');return new Response(JSON.stringify(mode==='document'?{kind:'answer',text:'답',evidence:[]}:{reply:{snapshot_id:'F'.repeat(20),kind:'설명',answer:'답',targets:[]}}));});
  await f.run(mode);assert.equal(calls,1);assert.equal(f.sent[0].type,'result');
 }
});
test('비공개 접근을 요구하는 raw 요청은 유효·만료 토큰 모두 fetch 전에 거절한다',async()=>{
 for(const auth of [{mode:'admin',session},{mode:'admin',session:{...session,expiresAt:1}},{mode:'unknown'}]){let calls=0;const f=offscreen(auth,null,()=>{calls++;});await f.run('document');assert.equal(calls,0);assert.equal(f.sent[0].error,'connection_failed');}
});
test('접근 ID 변경은 문서 fetch만 중단하고 화면 fetch는 유지한다',async()=>{for(const mode of ['document','screen']){let abort=false,resolve;const f=offscreen({mode:'anonymous'},{token,timeoutSeconds:90},(_u,o)=>new Promise((res,rej)=>{resolve=res;o.signal.addEventListener('abort',()=>{abort=true;rej(Error('abort'))})}));const pending=f.run(mode);await new Promise(setImmediate);f.changed();await new Promise(setImmediate);if(mode==='screen')resolve(new Response(JSON.stringify({reply:{snapshot_id:'F'.repeat(20),kind:'설명',answer:'답',targets:[]}})));await pending;assert.equal(abort,mode==='document')}});
function options(fetcher){const dom=new JSDOM(source('options.html'),{url:'https://extension.invalid/',runScripts:'outside-only'}),w=dom.window,messages=[];w.GyeoteProtocol=protocol;w.fetch=fetcher;w.chrome={runtime:{sendMessage:async msg=>messages.push(msg)}};w.eval(source('options.js'));return {w,messages,close:()=>w.close()};}
test('옵션에는 관리자 웹 링크만 남고 로그인·세션 요청은 만들지 않는다',async()=>{
 let calls=0;const f=options(async()=>{calls++;throw Error('옵션 통신 금지');});try{
  for(const selector of ['#admin-form','#admin-password','#admin-login','#admin-logout','#admin-status'])assert.equal(f.w.document.querySelector(selector),null);
  const link=f.w.document.querySelector('a');assert.equal(link.href,'https://welfare-helper-iota.vercel.app/admin/documents');assert.equal(link.target,'_blank');assert.match(link.rel,/noopener/);
  f.w.dispatchEvent(new f.w.Event('focus'));await new Promise(setImmediate);assert.equal(calls,0);assert.deepEqual(f.messages,[]);assert.equal(f.w.document.body.textContent.includes(token),false);
 }finally{f.close();}
});
test('누락되거나 오래된 접근 ID는 문서 fetch를 차단한다',async()=>{for(const access of [null,'admin:ready:old']){let n=0;const f=offscreen({mode:'anonymous',accessId:'new'},null,()=>{n++});await f.run('document',access);assert.equal(n,0);assert.equal(f.sent[0].error,'document_access_changed')}});
test('옛 관리자 저장값 변경은 통지를 만들지 않고 접근 ID 변경은 공개 상태만 보낸다',async()=>{
 const f=worker();Object.assign(f.data,{documentAccess:'admin',documentAdminSession:session});f.notify({documentAccess:{newValue:'admin'},documentAdminSession:{newValue:session}});await new Promise(setImmediate);assert.equal(f.tabMessages.length,0);
 f.data.documentAccessId='next';f.notify();await new Promise(setImmediate);await new Promise(setImmediate);assert.equal(Object.keys(f.query()).length,0);assert.equal(f.tabMessages.length,1);const message=f.tabMessages[0];assert.equal(message.state.mode,'anonymous');assert.equal(message.state.status,'anonymous');assert.equal(message.state.accessId,'next');assert.equal(JSON.stringify(message).includes(token),false);
});
test('통지 누락으로 응답 전에 접근 ID가 바뀌면 이전 결과를 전달하지 않는다',async()=>{
 const auth={mode:'anonymous',accessId:'initial'};const f=offscreen(auth,null,async()=>{auth.accessId='new';return new Response(JSON.stringify({kind:'answer',text:'이전 답변',evidence:[]}));});await f.run('document');assert.equal(f.sent[0].error,'document_access_changed');
});
test('공개 요청의401은 관리자 세션 조작 없이 거절 오류로 반환한다',async()=>{
 const f=offscreen({mode:'anonymous',session},null,async()=>new Response('{}',{status:401}));await f.run('document');assert.equal(f.sent[0].error,'document_auth_required');assert.equal(f.runtimeMessages.some(m=>m.type==='gyeote:admin-invalid'),false);
});
test('남은 옛 세션의 만료 시각 대신 요청 자체의 기한으로 중단한다',async()=>{
 for(const seconds of [1,600]){
  let now=Date.now(),nextTimer=0,aborted=false;const timers=new Map();class Clock extends Date{static now(){return now;}}
  const f=offscreen({mode:'anonymous',session:{...session,expiresAt:Math.floor(now/1000)+60}},null,(_u,o)=>new Promise((_,reject)=>o.signal.addEventListener('abort',()=>{aborted=true;reject(Error('abort'));})),{Date:Clock,GyeoteProtocol:{...protocol,documentTimeoutSeconds:()=>seconds},setTimeout(fn,delay){const id=++nextTimer;timers.set(id,{fn,delay});return id;},clearTimeout(id){timers.delete(id);}});
  const pending=f.run('document');await new Promise(setImmediate);assert.equal(timers.size,1);const timer=[...timers.values()][0];assert.equal(timer.delay,seconds*1000);now+=timer.delay-1;timer.fn();await pending;assert.equal(aborted,true);assert.equal(f.sent[0].error,'request_stopped');assert.equal(f.runtimeMessages.some(m=>m.type==='gyeote:admin-invalid'),false);
 }
});
