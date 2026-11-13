const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const protocol=require('../protocol.js');
const payload={source:'dom',snapshot_id:'F'.repeat(20),question:'화면 기능 알려줘',screen_context:[],candidates:[]};
function fixture(connection,fetcher,{mode='screen',timeoutSeconds}={}){
 let connect,receive,disconnect;const sent=[];
 const chrome={runtime:{id:'a'.repeat(32),onConnect:{addListener(fn){connect=fn;}},onMessage:{addListener(){}},sendMessage:async msg=>msg.type==='gyeote:document-auth'?{mode:'anonymous',accessId:'one',origin:protocol.documentOrigin()}:connection}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../offscreen.js'),'utf8'),{chrome,GyeoteProtocol:protocol,AbortController,setTimeout,clearTimeout,fetch:fetcher,Uint8Array,TextDecoder,Blob});
 const port={name:'gyeote:guide',sender:{id:chrome.runtime.id,frameId:0,url:'https://www.bokjiro.go.kr/ssis-tbu/index.do',tab:{url:'https://www.bokjiro.go.kr/ssis-tbu/index.do'}},postMessage(data){sent.push(data);},disconnect(){disconnect?.();},onMessage:{addListener(fn){receive=fn;}},onDisconnect:{addListener(fn){disconnect=fn;}}};
 connect(port);return {sent,run:deadlineAt=>receive({requestId:'A'.repeat(20),mode,payload:mode==='document'?{query:'2026년 문서 질문',history:[],...(timeoutSeconds===undefined?{}:{timeout_seconds:timeoutSeconds})}:{...payload},...(mode==='document'?{documentAccess:'anonymous:anonymous:one'}:{}),deadlineAt})};
}
const connection={token:'x'.repeat(40),imageEnabled:false,timeoutSeconds:600};
test('문서는 600초 화면은 90초이며 설정 범위를 검증한다',()=>{assert.equal(protocol.documentTimeoutSeconds(),600);assert.equal(protocol.screenTimeoutSeconds(),90);for(const value of [null,0,1801,NaN,Infinity,1.5,'600'])assert.throws(()=>protocol.validateDocumentTimeout(value));});
test('600초 예산은 90초에 종료되지 않고 지정 시점에 취소된다',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0;
 const g=fixture(connection,(_url,options)=>{calls++;return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));},{mode:'document'});const running=g.run();await new Promise(setImmediate);t.mock.timers.tick(90000);assert.equal(g.sent.length,0);t.mock.timers.tick(510000);await running;
 assert.equal(calls,1);assert.equal(g.sent[0].error,'request_stopped');
});
test('만료된 deadline은 fetch 없이 중단하고 짧은 유효 예산을 전달한다',async()=>{
 let calls=0,seconds;
 const f=fixture(connection,async(_url,options)=>{calls++;seconds=JSON.parse(options.body).timeout_seconds;return new Response(JSON.stringify({reply:{snapshot_id:payload.snapshot_id,kind:'설명',answer:'공개 화면입니다.',targets:[]}}));});
 await f.run(Date.now()-1);assert.equal(calls,0);assert.equal(f.sent[0].error,'request_stopped');
 const g=fixture(connection,async(_url,options)=>{calls++;seconds=JSON.parse(options.body).timeout_seconds;return new Response(JSON.stringify({reply:{snapshot_id:payload.snapshot_id,kind:'설명',answer:'공개 화면입니다.',targets:[]}}));});
 await g.run(Date.now()+3500);assert.equal(calls,1);assert.ok(seconds>=1&&seconds<=4);assert.equal(g.sent[0].type,'result');
});
test('504는 중단으로 분류하고 재시도하지 않는다',async()=>{
 let calls=0;const f=fixture(connection,async()=>{calls++;return new Response(JSON.stringify({detail:'desktop_request_timeout'}),{status:504});});
 await f.run();assert.equal(calls,1);assert.equal(f.sent[0].error,'request_stopped');
});
test('499 취소는 중단으로 분류하고 재시도하지 않는다',async()=>{
 let calls=0;const f=fixture(connection,async()=>{calls++;return new Response(JSON.stringify({detail:'desktop_request_cancelled'}),{status:499});});
 await f.run();assert.equal(calls,1);assert.equal(f.sent[0].error,'request_stopped');
});

test('문서 모드는 남은 전체 예산과 클라이언트 상한의 최솟값을 전송한다',async()=>{
 for(const timeoutSeconds of [undefined,2]){
  let sentBody,calls=0;
  const f=fixture(connection,async(url,options)=>{calls++;assert.equal(url,protocol.documentOrigin()+'/api/v1/chat/stream');sentBody=JSON.parse(options.body);return new Response(JSON.stringify({kind:'answer',text:'문서 답변',evidence:[]}));},{mode:'document',timeoutSeconds});
  await f.run(Date.now()+3500);assert.equal(calls,1);assert.equal(f.sent[0].type,'result');
  assert.ok(sentBody.timeout_seconds>=1&&sentBody.timeout_seconds<=4);
  if(timeoutSeconds)assert.equal(sentBody.timeout_seconds,2);
  assert.deepEqual(Object.keys(sentBody).sort(),['history','query','timeout_seconds']);
 }
});

test('문서 기한·취소·혼잡은 구분하고 자동 재전송하지 않는다',async()=>{
 for(const [status,error] of [[504,'request_timeout'],[499,'request_cancelled'],[429,'busy']]){
  let calls=0;const f=fixture(connection,async()=>{calls++;return new Response(JSON.stringify({detail:'virtual-private-error'}),{status});},{mode:'document'});
  await f.run();assert.equal(calls,1);assert.equal(f.sent[0].error,error);assert.ok(!JSON.stringify(f.sent).includes('virtual-private-error'));
 }
});

test('문서 요청 빈도 제한은 혼잡과 구분하고 재전송하지 않는다',async()=>{
 let calls=0;const f=fixture(connection,async()=>{calls++;return new Response(JSON.stringify({detail:'chat_rate_limited'}),{status:429});},{mode:'document'});
 await f.run();assert.equal(calls,1);assert.equal(f.sent[0].error,'chat_rate_limited');
});

test('문서 요청의 예산 필드는 선택적이며 1~1800 정수만 허용한다',()=>{
 assert.equal(protocol.documentRequest({query:'질문'}).timeout_seconds,undefined);
 assert.equal(protocol.documentRequest({query:'질문',timeout_seconds:1}).timeout_seconds,1);
 assert.equal(protocol.documentRequest({query:'질문',timeout_seconds:1800}).timeout_seconds,1800);
 for(const value of [0,1801,true,1.5,'1',null])assert.throws(()=>protocol.documentRequest({query:'질문',timeout_seconds:value}));
});
