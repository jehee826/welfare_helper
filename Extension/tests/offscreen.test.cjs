const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const protocol=require('../protocol.js');
const payload={source:'dom',snapshot_id:'F'.repeat(20),question:'화면 기능 알려줘',screen_context:[],candidates:[]};
function fixture(fetcher){
 let connect,receive,disconnect;const sent=[];
 const chrome={runtime:{id:'a'.repeat(32),onConnect:{addListener(fn){connect=fn;}},onMessage:{addListener(){}},sendMessage:async()=>({token:'x'.repeat(40),imageEnabled:false})}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../offscreen.js'),'utf8'),{chrome,GyeoteProtocol:protocol,AbortController,setTimeout,clearTimeout,fetch:fetcher,Uint8Array,TextDecoder,Blob});
 const port={name:'gyeote:guide',sender:{id:chrome.runtime.id,frameId:0,url:'https://www.bokjiro.go.kr/ssis-tbu/index.do',tab:{url:'https://www.bokjiro.go.kr/ssis-tbu/index.do'}},postMessage(data){sent.push(data);},disconnect(){disconnect?.();},onMessage:{addListener(fn){receive=fn;}},onDisconnect:{addListener(fn){disconnect=fn;}}};
 connect(port);return {sent,port,run:()=>receive({requestId:'A'.repeat(20),payload})};
}
test('긴 요청은 확장 문서가 고정 HTTPS 화면 API에 인증 없이 한 번 요청',async()=>{
 let calls=0;
 const f=fixture(async(url,options)=>{calls++;assert.equal(url,protocol.documentOrigin()+'/api/v1/screen/guide');assert.equal(options.headers.Authorization,undefined);return new Response(JSON.stringify({reply:{snapshot_id:payload.snapshot_id,kind:'설명',answer:'공개 화면의 기능입니다.',targets:[]}}));});
 await f.run();assert.equal(calls,1);assert.equal(f.sent[0].type,'result');
});
test('페이지/포트 연결 해제는 추론 요청을 취소하고 자동 재전송하지 않음',async()=>{
 let calls=0;
 const f=fixture((_url,options)=>{calls++;return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));});
 const running=f.run();await new Promise(setImmediate);f.port.disconnect();await running;assert.equal(calls,1);assert.equal(f.sent[0].error,'request_stopped');
});
test('Spot 연결 오류 후 과거 질문을 다시 보내지 않음',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;throw Error('offline');});await f.run();assert.equal(calls,1);assert.equal(f.sent[0].error,'connection_failed');
});
test('90초 제한은 요청을 취소하고 무한 재시도하지 않음',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0;
 const f=fixture((_url,options)=>{calls++;return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(Error('deadline')),{once:true}));});
 const running=f.run();await new Promise(setImmediate);t.mock.timers.tick(90000);await running;assert.equal(calls,1);assert.equal(f.sent[0].error,'request_stopped');
});
