const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const protocol=require('../protocol.js');
const source=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8');
const url='https://www.bokjiro.go.kr/ssis-tbu/index.do',id='a'.repeat(32);
const payload={source:'dom',snapshot_id:'F'.repeat(20),question:'화면 기능 알려줘',screen_context:[],candidates:[]};

test('삭제된 캡처와 이미지 처리 메시지는 호출하지 않는다',async()=>{const server=require('./conversation_fixture.cjs').worker();for(const type of ['gyeote:capture','gyeote:process-image','gyeote:connection'])assert.equal(await server.send({type},server.sender(1)),undefined);});

test('진행 중 중복 요청은 busy로 거절하고 끊긴 뒤 새 요청은 명시적으로만 전송한다',async()=>{
 let connect,calls=0,release;const sent=[];
 const chrome={runtime:{id,onConnect:{addListener(fn){connect=fn;}},onMessage:{addListener(){}},sendMessage:async()=>({token:'x'.repeat(40),imageEnabled:false})}};
 const fetcher=async()=>{calls++;if(calls===1)await new Promise(resolve=>{release=resolve});return new Response(JSON.stringify({reply:{snapshot_id:payload.snapshot_id,kind:'설명',answer:'공개 화면입니다.',targets:[]}}));};
 vm.runInNewContext(source('offscreen.js'),{chrome,GyeoteProtocol:protocol,AbortController,setTimeout,clearTimeout,fetch:fetcher,Uint8Array,TextDecoder,Blob});
 function port(){let receive;const p={name:'gyeote:guide',sender:{id,frameId:0,url,tab:{url}},postMessage(v){sent.push(v)},disconnect(){},onMessage:{addListener(fn){receive=fn}},onDisconnect:{addListener(){}}};connect(p);return ()=>receive({requestId:'A'.repeat(20),payload:{...payload}})}
 const first=port()();await new Promise(setImmediate);await port()();assert.equal(sent[0].error,'busy');assert.equal(calls,1);
 release();await first;await port()();assert.equal(calls,2);assert.equal(sent.at(-1).type,'result');
});

test('연결 실패는 자동 재전송하지 않고 사용자의 새 요청만 복구한다',async()=>{
 let connect,calls=0;const sent=[];
 const chrome={runtime:{id,onConnect:{addListener(fn){connect=fn;}},onMessage:{addListener(){}},sendMessage:async()=>({token:'x'.repeat(40),imageEnabled:false})}};
 const fetcher=async()=>{calls++;if(calls===1)throw Error('offline');return new Response(JSON.stringify({reply:{snapshot_id:payload.snapshot_id,kind:'설명',answer:'공개 화면입니다.',targets:[]}}));};
 vm.runInNewContext(source('offscreen.js'),{chrome,GyeoteProtocol:protocol,AbortController,setTimeout,clearTimeout,fetch:fetcher,Uint8Array,TextDecoder,Blob});
 function request(){let receive;const p={name:'gyeote:guide',sender:{id,frameId:0,url,tab:{url}},postMessage(v){sent.push(v)},disconnect(){},onMessage:{addListener(fn){receive=fn}},onDisconnect:{addListener(){}}};connect(p);return receive({requestId:'A'.repeat(20),payload:{...payload}})}
 await request();assert.equal(calls,1);assert.equal(sent[0].error,'connection_failed');
 await request();assert.equal(calls,2);assert.equal(sent[1].type,'result');
});

test('worker 재시작 대역은 기존 offscreen과 화면 90초를 재사용한다',async()=>{
 let creates=0;
 async function prepare(existing){
  let listener;const chrome={runtime:{id,getURL:f=>'chrome-extension://'+id+'/'+f,getContexts:async()=>existing?[{}]:[],onMessage:{addListener(fn){listener=fn;}}},action:{onClicked:{addListener(){}}},tabs:{onRemoved:{addListener(){}}},storage:{session:{get:async()=>({connection:{token:'x'.repeat(40),imageEnabled:false,timeoutSeconds:600}})}},offscreen:{createDocument:async()=>{creates++}}};
  vm.runInNewContext(source('worker.js'),{chrome,importScripts(){},GyeoteProtocol:protocol});
  const sender={id,frameId:0,url,tab:{id:1,url}};
  return new Promise(resolve=>listener({type:'gyeote:prepare'},sender,resolve));
 }
 assert.equal((await prepare(true)).timeoutSeconds,90);assert.equal((await prepare(true)).timeoutSeconds,90);assert.equal(creates,0);
});

test('동시 prepare는 offscreen 문서를 하나만 생성한다',async()=>{
 let listener,creates=0,release;const chrome={runtime:{id,getURL:f=>'chrome-extension://'+id+'/'+f,getContexts:async()=>[],onMessage:{addListener(fn){listener=fn;}}},action:{onClicked:{addListener(){}}},tabs:{onRemoved:{addListener(){}}},storage:{session:{get:async()=>({connection:{token:'x'.repeat(40),timeoutSeconds:600}})}},offscreen:{createDocument:()=>{creates++;return new Promise(resolve=>{release=resolve})}}};
 vm.runInNewContext(source('worker.js'),{chrome,importScripts(){},GyeoteProtocol:protocol});
 const sender={id,frameId:0,url,tab:{id:1,url}};
 const request=()=>new Promise(resolve=>listener({type:'gyeote:prepare'},sender,resolve));
 const a=request(),b=request();await new Promise(setImmediate);assert.equal(creates,1);release();assert.equal((await a).ok,true);assert.equal((await b).ok,true);
});
