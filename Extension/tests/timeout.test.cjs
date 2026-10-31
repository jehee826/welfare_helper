const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const protocol=require('../protocol.js');
const payload={source:'dom',snapshot_id:'F'.repeat(20),question:'화면 기능 알려줘',screen_context:[],candidates:[]};
function fixture(connection,fetcher){
 let connect,receive,disconnect;const sent=[];
 const chrome={runtime:{id:'a'.repeat(32),onConnect:{addListener(fn){connect=fn;}},onMessage:{addListener(){}},sendMessage:async()=>connection}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../offscreen.js'),'utf8'),{chrome,GyeoteProtocol:protocol,AbortController,setTimeout,clearTimeout,fetch:fetcher,Uint8Array,TextDecoder});
 const port={name:'gyeote:guide',sender:{id:chrome.runtime.id,frameId:0,url:'https://www.bokjiro.go.kr/ssis-tbu/index.do',tab:{url:'https://www.bokjiro.go.kr/ssis-tbu/index.do'}},postMessage(data){sent.push(data);},disconnect(){disconnect?.();},onMessage:{addListener(fn){receive=fn;}},onDisconnect:{addListener(fn){disconnect=fn;}}};
 connect(port);return {sent,run:deadlineAt=>receive({requestId:'A'.repeat(20),payload:{...payload},deadlineAt})};
}
const connection={token:'x'.repeat(40),imageEnabled:false,timeoutSeconds:600};
test('기존 연결은 90초이며 설정 범위를 검증한다',()=>{
 assert.equal(protocol.timeoutSeconds({version:1,token:'x'.repeat(40),imageEnabled:false}),90);
 assert.equal(protocol.timeoutSeconds(connection),600);
 for(const timeoutSeconds of [null,0,1801,NaN,Infinity,1.5,'600'])assert.throws(()=>protocol.timeoutSeconds({timeoutSeconds}));
});
test('600초 예산은 90초에 종료되지 않고 지정 시점에 취소된다',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0;
 const f=fixture(connection,(_url,options)=>{calls++;return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));});
 const running=f.run();await new Promise(setImmediate);t.mock.timers.tick(90000);assert.equal(f.sent.length,0);t.mock.timers.tick(510000);await running;
 assert.equal(calls,1);assert.equal(f.sent[0].error,'request_stopped');
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
