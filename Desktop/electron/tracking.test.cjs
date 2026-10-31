const {test}=require("node:test");
const assert=require("node:assert/strict");
const Module=require("node:module");
const {spawnSync}=require("node:child_process");
const path=require("node:path");
const clients=require("./local-clients.cjs");
const {watchMessage,verifiedPresence,focusUpdate}=require("./watch-status.cjs");
function fixture(guideStep,autoOpen=true){
 let receive,visible=false,opens=0,discoveries=0;
 const panel={hide(){visible=false;},showInactive(){visible=true;opens++;},isVisible:()=>visible,getBounds:()=>({x:800,y:0,width:380,height:500}),setPosition(){}};
 const overlay={hide(){},setBounds(){},showInactive(){}};
 const stop=()=>{};stop.discover=()=>discoveries++;
 const area={x:0,y:0,width:1600,height:1000};
 const screen={screenToDipRect:(_w,r)=>r,dipToScreenRect:(_w,r)=>r,getDisplayMatching:()=>({workArea:area}),getAllDisplays:()=>[{bounds:area,workArea:area}]};
 const original=Module._load;const file=require.resolve("./assistant.cjs");delete require.cache[file];
 let assistant;
 try {
  Module._load=function(name,parent,...args){
   if(parent?.filename===file&&name==="electron")return {screen};
   if(parent?.filename===file&&name==="./chrome-watch.cjs")return {watchChrome:callback=>{receive=callback;return stop;}};
   if(parent?.filename===file&&name==="./local-clients.cjs"&&guideStep)return {...clients,guideStep};
   return original.call(this,name,parent,...args);
  };
  assistant=require(file).assistant({panel,overlay,publish(){},clearDemo(){},ownFocused:()=>false,autoOpen});
 } finally {Module._load=original;delete require.cache[file];}
 const snap={context:"123:"+"A".repeat(20)+":doc:nav",signature:"first",active:true,elements:[],viewport:{x:0,y:0,width:700,height:600}};
 return {assistant,panel,snap,receive:(data,reason="",meta)=>receive(data,reason,meta),opens:()=>opens,discoveries:()=>discoveries};
}
test("Chrome→패널은 유지, 다른 앱에서는 숨김, 수동 재열기에서 재탐색 요청",()=>{
 const f=fixture();try{
  f.receive(f.snap);assert.equal(f.panel.isVisible(),true);
  f.receive({...f.snap,active:false});assert.equal(f.panel.isVisible(),true);assert.equal(f.opens(),1);
  f.receive(null,"other_app");assert.equal(f.panel.isVisible(),false);
  f.receive(f.snap);f.receive(null,"target_rechecking");f.receive(null,"url_not_target");
  assert.equal(f.panel.isVisible(),false);
  f.receive(f.snap);f.receive(null,"target_changed_during_read");assert.equal(f.panel.isVisible(),true);
  f.receive(null,"other_app");assert.equal(f.panel.isVisible(),false);
  f.assistant.manualOpen();f.panel.showInactive();assert.equal(f.discoveries(),1);
  f.receive({...f.snap,active:false});assert.equal(f.panel.isVisible(),true);
  f.receive(f.snap);assert.equal(f.panel.isVisible(),true);
  f.receive(null,"url_not_target");assert.equal(f.panel.isVisible(),false);
 }finally{f.assistant.stop();}
});

test("대상 재검증 중에는 기존 요청을 취소해도 패널을 유지한다",()=>{
 const f=fixture();try{
  f.receive(f.snap);assert.equal(f.panel.isVisible(),true);
  f.receive(null,"target_rechecking");assert.equal(f.panel.isVisible(),true);
  assert.match(f.assistant.state().text,/다시 검증/);
  f.receive(null,"other_app");assert.equal(f.panel.isVisible(),false);
 }finally{f.assistant.stop();}
});

test("재검증 중 요청은 새 스냅샷에서 한 번 실행하고 다른 앱 전환 시 취소한다",async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return {action:"보류",target_id:null,instruction:"확인하세요.",expect_label:null};});
 const snap={...f.snap,elements:[{name:"복지서비스",role:"Hyperlink",enabled:true,offscreen:false}]};
 try{
  f.receive(snap);f.receive(null,"target_changed_during_read");
  await f.assistant.command("goal","복지서비스 찾기");assert.equal(calls,0);
  f.receive(snap);await new Promise(setImmediate);assert.equal(calls,1);
  f.receive(null,"target_rechecking");await f.assistant.command("goal","다른 목표");
  f.receive(null,"other_app");f.receive(snap);await new Promise(setImmediate);assert.equal(calls,1);
 }finally{f.assistant.stop();}
});

test("UIA 주소 검증은 실제 문서 URL을 대조하고 HTTP·다른 페이지·가짜 호스트를 거부",{skip:process.platform!=="win32"},()=>{
 const result=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",path.join(__dirname,"../native/watch.ps1"),"-TestTracking"],{encoding:"utf8",windowsHide:true,timeout:20000});
 assert.equal(result.status,0,result.stderr);
 assert.match(result.stdout,/UIA_TRACKING_POLICY_PASS/);
});

test("백그라운드 검사는 실제 후보를 받아도 패널을 자동 표시하지 않음",()=>{
 const f=fixture(undefined,false);try{
  f.receive(f.snap);
  assert.equal(f.panel.isVisible(),false);
  f.receive(null,"no_accessibility_document",{key:"123:"+"A".repeat(20),active:true});
  assert.equal(f.panel.isVisible(),false);
 }finally{f.assistant.stop();}
});

test("추가질문 답변은 원래 목표·문맥을 유지하고 새 안내 시작은 문맥을 비움",async()=>{
 const calls=[];
 const f=fixture(async(goal,source,progress,signal,clarifications)=>{
  calls.push({goal,clarifications:structuredClone(clarifications)});
  return {action:calls.length===1?"추가질문":"보류",target_id:null,instruction:calls.length===1?"어떤 지원을 찾으시나요?":"현재 화면을 확인하세요.",expect_label:null};
 });
 try {
  f.receive({...f.snap,elements:[{name:"복지서비스",role:"Hyperlink",enabled:true}]});
  await f.assistant.command("goal","복지서비스를 찾아보고 싶어");
  await new Promise(setImmediate);
  assert.equal(f.assistant.state().awaitingClarification,true);
  await f.assistant.command("goal","주거 지원");
  await new Promise(setImmediate);
  assert.equal(calls[1].goal,calls[0].goal);
  assert.deepEqual(calls[1].clarifications,[{question:"어떤 지원을 찾으시나요?",answer:"주거 지원"}]);
  assert.equal(f.assistant.state().screenMessages.length,4);
  await f.assistant.command("reset");
  await f.assistant.command("goal","서비스 신청 화면을 찾고 싶어");
  await new Promise(setImmediate);
  assert.equal(calls[2].goal,"서비스 신청 화면을 찾고 싶어");
  assert.deepEqual(calls[2].clarifications,[]);
 }finally{f.assistant.stop();}
});

test("숨겨진 메뉴가 나타나면 사용자 화면 변화 확인으로만 다음 안내를 요청",async()=>{
 const id="B".repeat(20),nextId="C".repeat(20),calls=[];
 const f=fixture(async(goal,source,progress)=>{
  calls.push([...progress]);
  return calls.length===1?{action:"안내",target_id:id,instruction:"복지서비스를 선택하세요.",expect_label:"서비스 신청"}:{action:"보류",target_id:null,instruction:"화면을 확인하세요.",expect_label:null};
 });
 const elements=[{id,name:"복지서비스",role:"Hyperlink",enabled:true,offscreen:false,hit:true,rect:{x:10,y:10,width:80,height:40}},
  {id:nextId,name:"서비스 신청",role:"Hyperlink",enabled:true,offscreen:true,hit:false,rect:{x:10,y:60,width:80,height:40}}];
 try{
  f.receive({...f.snap,elements});
  await f.assistant.command("goal","복지서비스를 찾아보고 싶어");await new Promise(setImmediate);
  f.receive({...f.snap,elements:[elements[0],{...elements[1],offscreen:false,hit:true}]});
  assert.equal(calls.length,1);
  await f.assistant.command("advance");await new Promise(setImmediate);
  assert.deepEqual(calls,[[],["서비스 신청"]]);
 }finally{f.assistant.stop();}
});

test("예상 라벨이 나타나지 않아도 완료로 기록하지 않고 새 화면으로 안내한다",async()=>{
 const calls=[];const f=fixture(async(_goal,_source,progress)=>{
  calls.push([...progress]);
  return {action:"보류",target_id:null,instruction:"화면을 확인하세요.",expect_label:"다음"};
 });
 try{
  f.receive({...f.snap,elements:[{name:"복지서비스",role:"Hyperlink",enabled:true,offscreen:false}]});
  await f.assistant.command("goal","복지서비스 찾기");await new Promise(setImmediate);
  f.receive({...f.snap,elements:[{name:"복지지갑",role:"Hyperlink",enabled:true,offscreen:false}]});
  await f.assistant.command("advance");await new Promise(setImmediate);
  assert.deepEqual(calls,[[],[]]);
 }finally{f.assistant.stop();}
});

test("모델 처리 중 대상이 숨겨지면 클릭 안내를 표시하지 않음",async()=>{
 let finish;const id="B".repeat(20);
 const f=fixture(()=>new Promise(resolve=>{finish=resolve;}));
 const element={id,name:"복지서비스",role:"Hyperlink",enabled:true,offscreen:false,hit:true,rect:{x:10,y:10,width:80,height:40}};
 try{
  f.receive({...f.snap,elements:[element]});
  await f.assistant.command("goal","복지서비스를 찾아보고 싶어");
  f.receive({...f.snap,elements:[{...element,offscreen:true,hit:false}]});
  finish({action:"안내",target_id:id,instruction:"복지서비스를 누르세요.",expect_label:null});await new Promise(setImmediate);
  assert.equal(f.assistant.state().status,"error");
  assert.equal(f.assistant.state().screenMessages.length,1);
 }finally{f.assistant.stop();}
});
test("시작 시 백그라운드 검증은 포커스 위조 없이 보관하고 실제 Chrome 활성 때 자동 표시",()=>{
 const f=fixture();try{
  f.receive({...f.snap,active:false});assert.equal(f.panel.isVisible(),false);
  f.receive(f.snap);assert.equal(f.panel.isVisible(),true);
  f.assistant.hidden();f.panel.hide();
  f.receive(null,"other_app");f.receive(f.snap);assert.equal(f.panel.isVisible(),false);
  f.assistant.manualOpen();f.panel.showInactive();f.receive({...f.snap,active:false});assert.equal(f.panel.isVisible(),true);
 }finally{f.assistant.stop();}
});
test("주소는 확인됐지만 Document가 없는 경우에도 원인을 표시하고 숨김을 존중",()=>{
 const f=fixture(),presence={key:"123:"+"A".repeat(20),active:true};try{
  f.receive(null,"no_accessibility_document",presence);assert.equal(f.panel.isVisible(),true);
  assert.match(f.assistant.state().text,/주소·탭은 확인/);
  f.receive(null,"no_accessibility_document",{...presence,active:false});assert.equal(f.panel.isVisible(),true);
  f.assistant.hidden();f.panel.hide();f.receive(null,"no_accessibility_document",presence);
  assert.equal(f.panel.isVisible(),false);
  f.assistant.manualOpen();f.panel.showInactive();f.receive(null,"no_accessibility_document",{...presence,active:false});
  assert.equal(f.panel.isVisible(),true);
  f.receive(null,"no_accessibility_document",presence);f.receive(null,"other_app");
  assert.equal(f.panel.isVisible(),false);
 }finally{f.assistant.stop();}
});
test("reason은 원인별 문구, 검증되지 않은 대상 metadata는 자동 열림에 쓰지 않음",()=>{
 assert.match(watchMessage("chrome_not_found"),/Chrome 창이 없습니다/);
 assert.match(watchMessage("ambiguous_target"),/여러 개/);
 assert.match(watchMessage("url_scheme_missing"),/scheme/);
 assert.match(watchMessage("accessibility_timeout"),/20초/);
 assert.equal(verifiedPresence({verified:false,window:"1",tab:"A".repeat(20)}),null);
 assert.equal(verifiedPresence({verified:true,window:"1",tab:"invalid"}),null);
 assert.deepEqual(verifiedPresence({verified:true,window:"1",tab:"A".repeat(20),active:false}),{key:"1:"+"A".repeat(20),active:false});
});

test("패널 포커스는 새 추론 없이 inactive로, 오래된 캐시는 재사용하지 않음",()=>{
 const cached={snapshot:{context:"123:tab:doc",active:true},at:1000};
 assert.equal(focusUpdate({focus:"panel"},cached,"chrome",1200).snapshot.active,false);
 assert.equal(focusUpdate({focus:"chrome",window:"123"},cached,"panel",1200).keep,true);
 assert.equal(focusUpdate({focus:"chrome",window:"456"},cached,"panel",1200).snapshot,null);
 assert.equal(focusUpdate({focus:"panel"},cached,"chrome",5001).snapshot,null);
 assert.equal(focusUpdate({focus:"other"},cached,"chrome",1200).reason,"other_app");
});
