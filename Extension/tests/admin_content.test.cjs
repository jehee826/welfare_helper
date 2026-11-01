const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('../../FrontEnd/node_modules/jsdom');
const source=n=>fs.readFileSync(path.join(__dirname,'..',n),'utf8');
function fixture({shadow=false,link=false}={}){
 const dom=new JSDOM('<main><button>공개 메뉴</button></main>',{url:'https://www.bokjiro.go.kr/ssis-tbu/index.do',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
 let button=w.document.querySelector('main button');if(link){const a=w.document.createElement('a');a.href='/first';a.textContent='공개 메뉴';button.replaceWith(a);button=a}if(shadow){const host=w.document.createElement('div');button.replaceWith(host);host.attachShadow({mode:'open'}).append(button)}w.Element.prototype.getBoundingClientRect=()=>({x:40,y:60,left:40,top:60,right:180,bottom:100,width:140,height:40});
 const computed=w.getComputedStyle.bind(w);w.getComputedStyle=n=>{const s=computed(n);return {display:s.display,visibility:s.visibility||'visible',opacity:s.opacity||'1',position:s.position||'static'}};w.document.elementFromPoint=()=>button;
 for(const n of ['dom.js','protocol.js','capture.js'])w.eval(source(n));
 const attach=w.Element.prototype.attachShadow;let root,receiver,packet,accessListener;let access={mode:'admin',status:'ready',accessId:'one'};const ports=[],timers=new Map();let timerId=0;
 w.setTimeout=(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id};w.clearTimeout=id=>timers.delete(id);
 w.Element.prototype.attachShadow=function(options){const r=attach.call(this,options);if(this.hasAttribute('data-gyeote-host'))root=r;return r};
 w.chrome={runtime:{onMessage:{addListener(fn){accessListener=fn}},sendMessage:async(msg)=>msg.type==='gyeote:document-access'?access:({ok:true,imageEnabled:false,documentAccess:access}),connect:()=>{const port={onMessage:{addListener(fn){receiver=fn}},onDisconnect:{addListener(fn){port.onDisconnectListener=fn}},postMessage(data){packet=data;port.sent=data},disconnect(){}};ports.push(port);return port}}};
 w.eval(source('content.js'));
 const makeReply=(p,kind='안내')=>({type:'result',requestId:p.requestId,body:{reply:{snapshot_id:p.payload.snapshot_id,kind,answer:'공개 기능을 확인할 수 있습니다.',targets:kind==='안내'?[{target_id:p.payload.candidates[0].id,meaning:'공개 기능'}]:[]}}});
 return {w,root,button,ports,timers,setAccess:(v)=>access=v,authChange:()=>accessListener({type:'gyeote:document-access-changed',state:{mode:'admin',status:'ready'}},{},()=>{}),answerDoc:(body)=>receiver({type:'result',requestId:packet.requestId,body}),packet:()=>packet,mode:(v)=>{const x=root.querySelector('.mode');x.value=v;x.dispatchEvent(new w.Event('change'))},fireDeadline:()=>{const timer=[...timers.values()].find(t=>t.ms>10000);assert.ok(timer);timer.fn()},send:async()=>{root.querySelector('input[type=text]').value='공개 메뉴 알려줘';root.querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));await new Promise(setImmediate)},reply:(kind='안내')=>receiver(makeReply(packet,kind)),saveReply:()=>{const old=packet,callback=receiver;return()=>callback(makeReply(old))},close:()=>{w.dispatchEvent(new w.Event('pagehide'));w.close()}};
}


test('인증 변경은 문서 이력·근거만 지우고 화면 이력은 보존한다',async()=>{const f=fixture();try{await f.send();f.reply('설명');f.mode('document');await f.send();f.answerDoc({kind:'answer',text:'문서 답변',evidence:[]});assert.match(f.root.querySelector('.conversation').textContent,/문서 답변/);f.authChange();assert.doesNotMatch(f.root.querySelector('.conversation').textContent,/문서 답변/);f.mode('screen');assert.match(f.root.querySelector('.conversation').textContent,/공개 기능/)}finally{f.close()}});

test('통지 누락된 로그아웃 뒤 prepared 접근 변경은 문서 이력을 전송 전 제거한다',async()=>{const f=fixture();try{f.mode('document');await f.send();f.answerDoc({kind:'answer',text:'관리자 전용 근거',evidence:[]});f.setAccess({mode:'anonymous',status:'anonymous',accessId:'two'});await f.send();assert.equal(f.packet().payload.history.length,0);assert.doesNotMatch(f.root.querySelector('.conversation').textContent,/관리자 전용 근거/);assert.equal(f.packet().documentAccess,'anonymous:anonymous:two')}finally{f.close()}});
