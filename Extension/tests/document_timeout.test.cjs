const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {worker,ui,source}=require('./conversation_fixture.cjs'),protocol=require('../protocol.js');
const token='x'.repeat(40);

function offscreen(connection){
  let connected,receive;const sent=[],calls=[];
  const chrome={runtime:{id:'x',onConnect:{addListener(fn){connected=fn;}},onMessage:{addListener(){}},sendMessage:async message=>message.type==='gyeote:connection'?connection:{mode:'anonymous',accessId:'public-1',origin:protocol.documentOrigin()}}};
  vm.runInNewContext(source('offscreen.js'),{chrome,GyeoteProtocol:protocol,AbortController,setTimeout,clearTimeout,Uint8Array,TextDecoder,Blob,fetch:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return new Response(JSON.stringify(/\/chat(\/stream)?$/.test(url)?{kind:'answer',text:'합성 응답',evidence:[]}:{reply:{snapshot_id:'F'.repeat(20),kind:'설명',answer:'공개 화면입니다.',targets:[]}}));}});
  connected({name:'gyeote:guide',sender:{id:'x',frameId:0,url:'https://www.bokjiro.go.kr/',tab:{url:'https://www.bokjiro.go.kr/'}},postMessage:message=>sent.push(message),disconnect(){},onMessage:{addListener(fn){receive=fn;}},onDisconnect:{addListener(){}}});
  return {sent,calls,run:(mode,fields={})=>receive({requestId:'A'.repeat(20),mode,...(mode==='document'?{documentAccess:'anonymous:anonymous:public-1'}:{}),payload:mode==='document'?{query:'합성 문서 질문',history:[]}:{source:'dom',snapshot_id:'F'.repeat(20),question:'화면 설명',screen_context:[],candidates:[]},...fields})};
}

test('삭제된 연결정보와 무관하게 문서 600초·화면 90초를 전송한다',async()=>{const server=worker();Object.defineProperty(server.session,'connection',{get(){throw Error('연결정보 읽기 금지')}});for(const [mode,seconds] of [['document',600],['screen',90]]){const prepared=await server.send({type:'gyeote:prepare',mode},server.sender(1));assert.equal(prepared.timeoutSeconds,seconds);assert.equal(Object.hasOwn(prepared,'imageEnabled'),false);const f=offscreen();await f.run(mode);assert.equal(f.sent[0].type,'result');assert.equal(f.calls[0].body.timeout_seconds,seconds);}});

test('문서600초 기본값은 상시 안내 없이 포트 기한에 반영된다',async()=>{
  const server=worker();delete server.session.connection;const f=ui(server);try{
    await f.ready();const start=Date.now();await f.question('합성 문서 질문');
    assert.equal(f.root.querySelector('button[type=submit]').getAttribute('aria-label'),'요청 취소');assert.equal(f.root.querySelector('.request-notice'),null);
    assert.ok(f.ports[0].packet.deadlineAt>=start+599000&&f.ports[0].packet.deadlineAt<=Date.now()+600000);
  }finally{f.close();}
});

test('지난 기한은 fetch 없이 중지한다',async()=>{const f=offscreen();await f.run('document',{deadlineAt:Date.now()-1});assert.equal(f.calls.length,0);assert.equal(f.sent[0].error,'request_stopped');});
