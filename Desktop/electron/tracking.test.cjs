const {test}=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const clients=require('./local-clients.cjs');
const {watchMessage,verifiedPresence,focusUpdate}=require('./watch-status.cjs');
const {overlayLayout,OverlayPresenter}=require('./overlay-layout.cjs');
const tick=()=>new Promise(setImmediate);
const id='B'.repeat(20),area={x:0,y:0,width:1600,height:1000};
const element={id,name:'복지서비스',role:'Hyperlink',enabled:true,offscreen:false,hit:true,rect:{x:355,y:240,width:127,height:100}};
function fixture(guideStep,options={}){
 let receive,current,visible=false,focused=false,opens=0,discoveries=0,highlighted=false,packet;
 const panel={hide(){visible=false;},showInactive(){visible=true;opens++;},isVisible:()=>visible,getBounds:()=>({x:1000,y:0,width:380,height:500}),setPosition(){}};
 const overlay={hide(){highlighted=false;},setBounds(){},showInactive(){highlighted=true;},webContents:{send(_channel,data){packet=data;if(options.autoAck!==false)queueMicrotask(()=>presenter.acknowledge(data.version));}}};
 const presenter=new OverlayPresenter(overlay);
 const stop=()=>{};stop.discover=()=>discoveries++;
 stop.refresh=()=>{if(options.autoRefresh!==false&&current)queueMicrotask(()=>feed(current));};
 const screen={screenToDipRect:(_w,r)=>r,dipToScreenRect:(_w,r)=>r,getDisplayMatching:()=>({workArea:area}),getAllDisplays:()=>[{bounds:area,workArea:area}]};
 const original=Module._load,file=require.resolve('./assistant.cjs');delete require.cache[file];
 let assistant;
 try{
  Module._load=function(name,parent,...args){
   if(parent?.filename===file&&name==='electron')return {screen};
   if(parent?.filename===file&&name==='./chrome-watch.cjs')return {watchChrome:callback=>{receive=callback;return stop;}};
   if(parent?.filename===file&&name==='./local-clients.cjs')return {...clients,guideStep};
   return original.call(this,name,parent,...args);
  };
  assistant=require(file).assistant({panel,overlay,overlayPresenter:presenter,publish(){},clearDemo(){},ownFocused:()=>focused,autoOpen:options.autoOpen!==false});
 }finally{Module._load=original;delete require.cache[file];}
 const snap={context:'123:'+'A'.repeat(20)+':doc:nav',signature:'first',active:true,elements:[element],viewport:{x:0,y:0,width:900,height:600}};
 function feed(data,reason='',meta){current=data;receive(data?{...data,verifiedAt:Date.now()}:null,reason,meta);}
 return {assistant,panel,snap,feed,presenter,packet:()=>packet,focused:value=>focused=value,highlighted:()=>highlighted,opens:()=>opens,discoveries:()=>discoveries};
}
const targetAnswer=async()=>({action:'안내',target_id:id,instruction:'복지서비스 메뉴에서 서비스를 찾아볼 수 있어요.',expect_label:null});
test('질문은 캐시로 추론하지 않고 질문 뒤 새 화면이 확인되면 한 번만 추론',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return {action:'설명',target_id:null,instruction:'현재 화면 설명입니다.',expect_label:null};},{autoRefresh:false});
 try{f.feed(f.snap);await f.assistant.command('goal','이 화면에서 뭘 할 수 있어?');await tick();assert.equal(calls,0);f.feed(f.snap);await tick();assert.equal(calls,1);f.feed(f.snap);assert.equal(calls,1);assert.equal(f.highlighted(),false);assert.equal(f.assistant.state().text,'현재 화면 설명입니다.');}finally{f.assistant.stop();}
});
test('패널 포커스에서 새로 검증된 대상 표시와 방향·이름을 렌더 ACK 뒤 함께 공개',async()=>{
 const f=fixture(targetAnswer,{autoAck:false});try{
  f.focused(true);f.feed({...f.snap,active:false,panelFocused:true});f.panel.showInactive();
  await f.assistant.command('goal','복지서비스는 어디 있어?');await tick();
  assert.equal(f.highlighted(),false);assert.doesNotMatch(f.assistant.state().text,/파란 테두리/);
  const packet=f.packet();assert.equal(packet.label,'복지서비스');assert.equal(packet.direction,'가운데');
  f.presenter.acknowledge(packet.version);assert.equal(f.highlighted(),true);assert.match(f.assistant.state().text,/화면 가운데.*복지서비스/);
  assert.equal(f.assistant.state().text,f.assistant.state().screenMessages.at(-1).text);
 }finally{f.assistant.stop();}
});
test('가려진 대상·다른 앱·만료 시 파란 표시 지시가 현재 안내에 남지 않음',async()=>{
 const f=fixture(targetAnswer);try{
  f.feed(f.snap);await f.assistant.command('goal','복지서비스 찾기');await tick();assert.equal(f.highlighted(),true);
  f.feed({...f.snap,elements:[{...element,hit:false}]});assert.equal(f.highlighted(),false);assert.doesNotMatch(f.assistant.state().text,/파란 테두리/);assert.doesNotMatch(f.assistant.state().screenMessages.at(-1).text,/파란 테두리/);
  f.feed(null,'other_app');assert.equal(f.panel.isVisible(),false);assert.equal(f.assistant.state().currentStepId,null);
 }finally{f.assistant.stop();}
});
test('취소·화면 변경 뒤 늦은 overlay ACK로 이전 표시를 되살리지 않음',async()=>{
 const f=fixture(targetAnswer,{autoAck:false});try{
  f.feed(f.snap);await f.assistant.command('goal','복지서비스 찾기');await tick();const version=f.packet().version;
  f.feed({...f.snap,signature:'new'});f.presenter.acknowledge(version);assert.equal(f.highlighted(),false);assert.equal(f.assistant.state().currentStepId,null);
 }finally{f.assistant.stop();}
});

test('화면 변경·숨김·접기·초기화·종료 뒤 늦은 모델 응답은 폐기함',async()=>{
 for(const cancel of [f=>f.feed({...f.snap,signature:'new'}),f=>f.assistant.hidden(),f=>f.assistant.collapsed(true),f=>f.assistant.command('reset'),f=>f.assistant.stop()]){
  let finish,signal,calls=0;
  const f=fixture((_goal,_source,_progress,requestSignal)=>{
   calls++;signal=requestSignal;return new Promise(resolve=>finish=resolve);
  });
  try{
   f.feed(f.snap);await f.assistant.command('goal','복지서비스 찾기');await tick();
   await cancel(f);
   assert.equal(signal.aborted,true);
   finish(await targetAnswer());await tick();
   assert.equal(calls,1);assert.equal(f.assistant.state().currentStepId,null);
   assert.notEqual(f.assistant.state().status,'guide');assert.equal(f.highlighted(),false);
  }finally{f.assistant.stop();}
 }
});
test('재검증 중에는 표시·현행 지시를 숨기고 같은 대상만 새 좌표로 복원',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return targetAnswer();});try{
  f.feed(f.snap);await f.assistant.command('goal','복지서비스 찾기');await tick();f.feed(null,'target_rechecking');assert.equal(f.highlighted(),false);assert.doesNotMatch(f.assistant.state().screenMessages.at(-1).text,/파란 테두리/);
  f.feed({...f.snap,elements:[{...element,rect:{...element.rect,y:290}}]});await tick();assert.equal(f.highlighted(),true);assert.equal(calls,1);assert.equal(f.packet().ring.y+f.packet().bounds.y,290);
  f.feed(null,'target_rechecking');f.feed({...f.snap,signature:'new',context:'123:tab:new:nav'});await tick();assert.equal(f.highlighted(),false);
 }finally{f.assistant.stop();}
});
test('모달 배경 대상·응답 도중 사라진 대상은 안내하지 않음',async()=>{
 let finish;const f=fixture(()=>new Promise(resolve=>finish=resolve));try{
  f.feed(f.snap);await f.assistant.command('goal','복지서비스 찾기');await tick();f.feed({...f.snap,elements:[{...element,blocked:true}]});finish(await targetAnswer());await tick();assert.equal(f.assistant.state().status,'error');assert.equal(f.highlighted(),false);
 }finally{f.assistant.stop();}
});
test('추가질문 답변만 원 질문을 유지하고 새 질문·초기화는 별개 문맥',async()=>{
 const calls=[];const f=fixture(async(goal,source,progress,signal,clarifications)=>{calls.push({goal,clarifications:structuredClone(clarifications)});return {action:calls.length===1?'추가질문':'설명',target_id:null,instruction:'어떤 항목인지 알려주세요.',expect_label:null};});try{
  f.feed(f.snap);await f.assistant.command('goal','이 항목은 무슨 뜻이야?');await tick();await f.assistant.command('goal','복지서비스');await tick();assert.equal(calls[1].goal,calls[0].goal);assert.equal(calls[1].clarifications.length,1);
  await f.assistant.command('goal','검색은 어디서 해?');await tick();assert.equal(calls[2].goal,'검색은 어디서 해?');assert.deepEqual(calls[2].clarifications,[]);
 }finally{f.assistant.stop();}
});
test('Chrome 자동 열림·숨김·수동 재탐색과 백그라운드 설정을 보존',()=>{
 const f=fixture(targetAnswer);try{f.feed(f.snap);assert.equal(f.panel.isVisible(),true);f.feed({...f.snap,active:false});assert.equal(f.opens(),1);f.feed(null,'other_app');assert.equal(f.panel.isVisible(),false);f.assistant.manualOpen();assert.equal(f.discoveries(),1);f.panel.showInactive();f.feed({...f.snap,active:false});assert.equal(f.panel.isVisible(),true);}finally{f.assistant.stop();}
 const b=fixture(targetAnswer,{autoOpen:false});try{b.feed(b.snap);assert.equal(b.panel.isVisible(),false);}finally{b.assistant.stop();}
});
test('패널 캐시 포커스 이벤트만으로는 새 hit 검증을 대신하지 않음',()=>{
 const cache={snapshot:{context:'123:tab:doc',active:true,panelFocused:true},at:1000};
 assert.equal(focusUpdate({focus:'panel'},cache,'chrome',1200).snapshot.panelFocused,false);
 assert.equal(focusUpdate({focus:'chrome',window:'123'},cache,'panel',1200).keep,true);
 assert.equal(focusUpdate({focus:'panel'},cache,'chrome',5001).snapshot,null);
 assert.equal(focusUpdate({focus:'other'},cache,'chrome',1200).reason,'other_app');
});
test('원인별 진단과 검증된 사이트 metadata만 자동 열림에 사용',()=>{
 assert.match(watchMessage('chrome_not_found'),/Chrome 창이 없습니다/);assert.match(watchMessage('accessibility_timeout'),/20초/);
 assert.equal(verifiedPresence({verified:false,window:'1',tab:'A'.repeat(20)}),null);
 assert.deepEqual(verifiedPresence({verified:true,window:'1',tab:'A'.repeat(20),active:false}),{key:'1:'+'A'.repeat(20),active:false});
});
test('콜아웃은 왼쪽 공간 우선, 가장자리·패널을 피하고 방향은 실제 대상 위치로 계산',()=>{
 const left=overlayLayout(element.rect,area,{x:1000,y:0,width:380,height:500},'복지서비스',{x:0,y:0,width:900,height:600});assert.ok(left.card.x+left.card.width<left.ring.x);
 const edge=overlayLayout({...element.rect,x:10},area,null,'검색',area);assert.ok(edge.card.x>edge.ring.x);assert.equal(edge.direction,'왼쪽');
});
test('Windows native helpers compile and URL tracking rejects fake hosts',{skip:process.platform!=='win32'},()=>{
 for(const [file,flag,marker] of [['watch.ps1','-TestTracking','UIA_TRACKING_POLICY_PASS']]){
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'../native',file),flag],{encoding:'utf8',windowsHide:true,timeout:20000});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,new RegExp(marker));
 }
});
