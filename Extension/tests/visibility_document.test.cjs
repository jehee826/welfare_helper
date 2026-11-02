const {test}=require('node:test'),assert=require('node:assert/strict');
const {worker,ui,key,settle}=require('./conversation_fixture.cjs');

function visibility(f,hidden){Object.defineProperty(f.w.document,'hidden',{configurable:true,value:hidden});f.w.document.dispatchEvent(new f.w.Event('visibilitychange'));}
test('숨김 중 기한 콜백이 지연돼도 절대 기한 뒤 결과는 저장하지 않는다',async()=>{
 let now=Date.now();const server=worker(),f=ui(server,1,w=>{w.Date.now=()=>now;});try{
  await f.ready();await f.question('합성 질문');const port=f.ports.at(-1);visibility(f,true);await settle();
  now=port.packet.deadlineAt+1;await f.answer({kind:'fallback',text:'늦은 답변',evidence:[]},port);
  assert.doesNotMatch(f.root.querySelector('.conversation').textContent,/늦은 답변/);
  assert.equal(server.data[key],undefined);assert.equal(port.disconnected,true);
 }finally{f.close();}
});
test('문서 blur와 hidden 복귀는 같은 요청과 기한을 유지하고 fallback을 복원한다',async()=>{
 const server=worker(),f=ui(server);try{
  await f.ready();await f.question('합성 질문');const port=f.ports.at(-1);
  f.w.dispatchEvent(new f.w.Event('blur'));await settle();assert.notEqual(port.disconnected,true);
  const requestId=port.packet.requestId,deadline=port.packet.deadlineAt;visibility(f,true);await settle();assert.notEqual(port.disconnected,true);
  visibility(f,false);await settle();assert.equal(port.packet.requestId,requestId);assert.equal(port.packet.deadlineAt,deadline);
  visibility(f,true);await f.answer({kind:'fallback',text:'확인할 조건을 알려주세요.',evidence:[]},port);
  assert.equal(server.data[key].conversations[0].messages.length,2);
 }finally{f.close();}
 const restored=ui(server);try{await restored.ready();assert.match(restored.root.querySelector('.conversation').textContent,/확인할 조건/);}finally{restored.close();}
});
for(const ending of ['cancel','deadline','pagehide','mode','profile','access','conversation'])test('숨긴 문서 요청도 '+ending+' 경계는 유지한다',async()=>{
 let deadline;const server=worker(),f=ui(server,1,w=>{const set=w.setTimeout.bind(w),clear=w.clearTimeout.bind(w);w.setTimeout=(fn,ms,...a)=>ms>10000?(deadline=fn,999998):set(fn,ms,...a);w.clearTimeout=id=>id===999998?undefined:clear(id);});try{
  await f.ready();await f.question('합성 질문');const port=f.ports.at(-1);visibility(f,true);await settle();assert.notEqual(port.disconnected,true);
  if(ending==='cancel')f.root.querySelector('.cancel').click();
  if(ending==='deadline'){assert.equal(typeof deadline,'function');deadline();}
  if(ending==='pagehide')f.w.dispatchEvent(new f.w.Event('pagehide'));
  if(ending==='mode')await f.mode('screen');
  if(ending==='profile')await server.send({type:'gyeote:profile-save',expectedRevision:1,profile:{age:60}});
  if(ending==='access')await server.send({type:'gyeote:admin-connect',session:{token:'a'.repeat(40),expiresAt:Math.floor(Date.now()/1000)+600}},{id:'x',url:'chrome-extension://x/options.html'});
  if(ending==='conversation')await f.click('새 상담',f.root.querySelector('.conversation-nav'));
  await settle();assert.equal(port.disconnected,true);assert.equal(server.data[key]?.conversations?.some(c=>c.messages.length>0)??false,false);
 }finally{f.close();}
});
