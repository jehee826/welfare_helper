const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const protocol=require('../protocol.js'),source=fs.readFileSync(path.join(__dirname,'../offscreen.js'),'utf8');
const profile={age:70,income:'under50',household:'single',region:'서울특별시',disability:false};
function fixture(fetcher,auth={mode:'anonymous',accessId:'one',origin:protocol.documentOrigin()}){
 let connect,receive,notification;const sent=[];
 const chrome={runtime:{id:'x',onConnect:{addListener(fn){connect=fn;}},onMessage:{addListener(fn){notification=fn;}},sendMessage:async message=>message.type==='gyeote:connection'?{token:'x'.repeat(40),timeoutSeconds:30}:auth}};
 vm.runInNewContext(source,{chrome,GyeoteProtocol:protocol,AbortController,setTimeout,clearTimeout,fetch:fetcher,Uint8Array,TextDecoder,Blob});
 const port={name:'gyeote:guide',sender:{id:'x',frameId:0,url:'https://www.bokjiro.go.kr/',tab:{url:'https://www.bokjiro.go.kr/'}},postMessage:packet=>sent.push(packet),disconnect(){},onMessage:{addListener(fn){receive=fn;}},onDisconnect:{addListener(){}}};connect(port);
 const screen={source:'dom',snapshot_id:'F'.repeat(20),question:'공개 화면 설명',candidates:[],screen_context:[]};
 return {sent,run:(payload,mode='document',profileRevision,conversationContext)=>receive({requestId:'A'.repeat(20),mode,...(mode==='document'?{documentAccess:[auth.mode,auth.mode==='admin'?'ready':'anonymous',auth.accessId].join(':'),profileRevision,conversationContext}:{}),payload:mode==='screen'?screen:payload}),notify:(sender,revision)=>notification({target:'gyeote:offscreen',type:'gyeote:profile-changed',revision},sender,()=>{}),notifyConversation:(revision,generation='initial',sender={id:'x'})=>notification({target:'gyeote:offscreen',type:'gyeote:conversations-changed',revision,generation},sender,()=>{})};
}
for(const value of [profile,{age:null,income:'unknown',household:null,region:null,disability:null},null,undefined])test('문서 HTTP는 구형 조건을 외부 전송하지 않는다: '+JSON.stringify(value),async()=>{
 let body,calls=0;const f=fixture(async(_url,options)=>{calls++;body=JSON.parse(options.body);assert.equal(options.headers.Authorization,undefined);return new Response(JSON.stringify({kind:'answer',text:'가상 답변',evidence:[]}));});
 await f.run({query:'문서 질문',...(value===undefined?{}:{profile:value})});assert.equal(calls,1);assert.equal(f.sent[0].type,'result');
 assert.ok(!('profile' in body));
});

test('구형 조건에 임의 값이 있어도 HTTP 본문으로 전송하지 않는다',async()=>{
 for(const value of [{...profile,age:-1},{...profile,region:'상세주소'},{...profile,token:'private'}]){
  let body;const f=fixture(async(_url,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({kind:'answer',text:'가상 답변',evidence:[]}));});await f.run({query:'문서 질문',profile:value});assert.equal(Object.hasOwn(body,'profile'),false);assert.equal(f.sent[0].type,'result');
 }
});

test('worker의 조건 변경은 진행 중 문서 fetch를 중단하지 않는다',async()=>{
 let resolve,aborted=false;
 const f=fixture((_url,options)=>new Promise(ok=>{resolve=ok;options.signal.addEventListener('abort',()=>{aborted=true;});}));
 const running=f.run({query:'문서 질문',profile});await new Promise(setImmediate);f.notify({id:'x'});assert.equal(aborted,false);
 resolve(new Response(JSON.stringify({kind:'answer',text:'가상 답변',evidence:[]})));await running;assert.equal(f.sent[0].type,'result');
});

for(const mode of ['document','screen'])test('위조 통지 또는 화면 모드의 조건 변경은 요청을 취소하지 않는다: '+mode,async()=>{
 let resolve,aborted=false;const f=fixture((_url,options)=>{options.signal.addEventListener('abort',()=>aborted=true);return new Promise(ok=>resolve=ok);});
 const running=f.run({query:'문서 질문',profile},mode);await new Promise(setImmediate);f.notify({id:mode==='document'?'foreign':'x'});assert.equal(aborted,false);
 resolve(new Response(JSON.stringify(mode==='document'?{kind:'answer',text:'문서 답변',evidence:[]}:{reply:{snapshot_id:'F'.repeat(20),kind:'설명',answer:'공개 화면입니다.',targets:[]}})));await running;assert.equal(f.sent[0].type,'result');
});

test('offscreen은 다른 profile revision 통지도 진행 요청을 취소하지 않는다',async()=>{
 let resolve,aborted=false;const f=fixture((_url,options)=>new Promise(ok=>{resolve=ok;options.signal.addEventListener('abort',()=>{aborted=true;});}));
 const running=f.run({query:'문서 질문',profile},'document',4);await new Promise(setImmediate);
 f.notify({id:'x'},4);f.notify({id:'x'},5);assert.equal(aborted,false);resolve(new Response(JSON.stringify({kind:'answer',text:'가상 답변',evidence:[]})));await running;assert.equal(f.sent[0].type,'result');
});
test('공개 상담 변경은 같은 revision을 무시하고 다른 revision 또는 세대만 취소한다',async()=>{
 let aborted=false;const f=fixture((_url,options)=>new Promise((_,reject)=>options.signal.addEventListener('abort',()=>{aborted=true;reject(Error('합성 취소'));})));
 const running=f.run({query:'공개 질문'},'document',1,{revision:3,generation:'initial'});await new Promise(setImmediate);
 f.notifyConversation(3);assert.equal(aborted,false);f.notifyConversation(4,'initial',{id:'foreign'});assert.equal(aborted,false);
 f.notifyConversation(3,'new-generation');await running;assert.equal(aborted,true);assert.equal(f.sent[0].error,'request_stopped');
});
for(const mode of ['admin','screen'])test('공개 저장소 변경은 관리자·화면 요청을 취소하지 않는다: '+mode,async()=>{
 let resolve,aborted=false;const auth=mode==='admin'?{mode:'admin',accessId:'one',origin:protocol.documentOrigin(),session:{token:'a'.repeat(40),expiresAt:Math.floor(Date.now()/1000)+600,origin:protocol.documentOrigin()}}:undefined;
 const f=fixture((_url,options)=>{options.signal.addEventListener('abort',()=>aborted=true);return new Promise(ok=>resolve=ok);},auth);
 const running=f.run({query:'합성 질문'},mode==='screen'?'screen':'document',1,{revision:1,generation:'initial'});await new Promise(setImmediate);f.notifyConversation(2);assert.equal(aborted,false);
 resolve(new Response(JSON.stringify(mode==='screen'?{reply:{snapshot_id:'F'.repeat(20),kind:'설명',answer:'공개 기능입니다.',targets:[]}}:{kind:'answer',text:'관리자 합성 답변',evidence:[]})));await running;assert.equal(f.sent[0].type,'result');
});
const contextInput={text:'',coveredThroughMessageId:null,profileRevision:1,batch:[{id:'A'.repeat(20)+':user',role:'user',content:'사용자 필요'},{id:'A'.repeat(20)+':assistant',role:'assistant',content:'이전 설명'}],omitted:false};
test('문서 HTTP는 요약 batch를 전달하고 제출한 마지막 ID의 갱신만 받는다',async()=>{
 let body;const f=fixture(async(_url,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({kind:'answer',text:'합성 답변',evidence:[],context_update:{status:'updated',text:'합성 서비스 필요',coveredThroughMessageId:contextInput.batch.at(-1).id,profileRevision:1}}));});
 await f.run({query:'그 서비스',conversation_context:contextInput},'document',1);
 assert.deepEqual(body.conversation_context,contextInput);assert.equal(f.sent[0].type,'result');assert.ok(!('image' in body));
});
test('맥락의 임의 필드와 개인정보는 fetch 전에 거절한다',async()=>{
 for(const context of [{...contextInput,extra:'no'},{...contextInput,text:'010-1234-5678'}]){
  let calls=0;const f=fixture(async()=>{calls++;throw Error('전송 금지');});await f.run({query:'질문',conversation_context:context},'document',1);assert.equal(calls,0);assert.equal(f.sent[0].type,'error');
 }
});
test('서버가 반환한 임의 summary ID는 offscreen에서 표시 전에 거절한다',async()=>{
 const f=fixture(async()=>new Response(JSON.stringify({kind:'answer',text:'합성 답변',evidence:[],context_update:{status:'updated',text:'가짜 범위',coveredThroughMessageId:'B'.repeat(20)+':assistant',profileRevision:1}})));
 await f.run({query:'질문',conversation_context:contextInput},'document',1);assert.equal(f.sent[0].type,'error');assert.equal(f.sent[0].error,'invalid_context_update');
});
