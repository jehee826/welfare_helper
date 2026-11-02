const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {worker,ui,source}=require('./conversation_fixture.cjs'),protocol=require('../protocol.js');
const token='x'.repeat(40);

function offscreen(connection){
  let connected,receive;const sent=[],calls=[];
  const chrome={runtime:{id:'x',onConnect:{addListener(fn){connected=fn;}},onMessage:{addListener(){}},sendMessage:async message=>message.type==='gyeote:connection'?connection:{mode:'anonymous',accessId:'public-1',origin:protocol.documentOrigin()}}};
  vm.runInNewContext(source('offscreen.js'),{chrome,GyeoteProtocol:protocol,AbortController,setTimeout,clearTimeout,Uint8Array,TextDecoder,fetch:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return new Response(JSON.stringify(url.endsWith('/chat')?{kind:'answer',text:'합성 응답',evidence:[]}:{reply:{snapshot_id:'F'.repeat(20),kind:'설명',answer:'공개 화면입니다.',targets:[]}}));}});
  connected({name:'gyeote:guide',sender:{id:'x',frameId:0,url:'https://www.bokjiro.go.kr/',tab:{url:'https://www.bokjiro.go.kr/'}},postMessage:message=>sent.push(message),disconnect(){},onMessage:{addListener(fn){receive=fn;}},onDisconnect:{addListener(){}}});
  return {sent,calls,run:(mode,fields={})=>receive({requestId:'A'.repeat(20),mode,documentAccess:'anonymous:anonymous:public-1',payload:mode==='document'?{query:'합성 문서 질문',history:[]}:{source:'dom',snapshot_id:'F'.repeat(20),question:'화면 설명',screen_context:[],candidates:[]},...fields})};
}

for(const [label,connection,documentSeconds,screenSeconds] of [
  ['연결 없음',undefined,600,null],['시간 없는 기존 화면 연결',{token,imageEnabled:false},600,90],
  ['명시600초',{token,timeoutSeconds:600,imageEnabled:false},600,600],['명시90초',{token,timeoutSeconds:90,imageEnabled:false},90,90],
])test(`${label}: 문서/화면 준비와 실제 요청 예산이 각각 일치한다`,async()=>{
  const server=worker();server.session.connection=connection;
  const prepared=await server.send({type:'gyeote:prepare',mode:'document'},server.sender(1));assert.equal(prepared.timeoutSeconds,documentSeconds);
  const f=offscreen(connection);await f.run('document');assert.equal(f.sent[0].type,'result');assert.equal(f.calls[0].body.timeout_seconds,documentSeconds);
  const screen=await server.send({type:'gyeote:prepare',mode:'screen'},server.sender(1));
  const g=offscreen(connection);await g.run('screen');
  if(screenSeconds===null){assert.equal(screen.error,'connection_required');assert.equal(g.calls.length,0);}
  else{assert.equal(screen.timeoutSeconds,screenSeconds);assert.equal(g.sent[0].type,'result');assert.equal(g.calls[0].body.timeout_seconds,screenSeconds);}
});

test('문서600초 기본값은 패널 안내와 포트 기한에 반영된다',async()=>{
  const server=worker();delete server.session.connection;const f=ui(server);try{
    await f.ready();const start=Date.now();await f.question('합성 문서 질문');
    assert.match(f.root.querySelector('.status').textContent,/최대 600초/);
    assert.ok(f.ports[0].packet.deadlineAt>=start+599000&&f.ports[0].packet.deadlineAt<=Date.now()+600000);
  }finally{f.close();}
});

test('잘못된 명시 기한과 이미 지난 요청은 기본값으로 숨기지 않고 전송을 막는다',async()=>{
  for(const timeoutSeconds of [0,1801,1.5,null]){
    const f=offscreen({token,timeoutSeconds});await f.run('document');assert.equal(f.calls.length,0);assert.equal(f.sent[0].error,'connection_required');
  }
  const f=offscreen(undefined);await f.run('document',{deadlineAt:Date.now()-1});assert.equal(f.calls.length,0);assert.equal(f.sent[0].error,'request_stopped');
});
