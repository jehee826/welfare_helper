const {test}=require("node:test");
const assert=require("node:assert/strict");
const Module=require("node:module");
const {watchMessage,verifiedPresence,focusUpdate}=require("./watch-status.cjs");
function fixture(){
 let receive,visible=false,opens=0,discoveries=0;
 const panel={hide(){visible=false;},showInactive(){visible=true;opens++;},isVisible:()=>visible,getBounds:()=>({x:800,y:0,width:380,height:500}),setPosition(){}};
 const overlay={hide(){},setBounds(){},showInactive(){}};
 const stop=()=>{};stop.discover=()=>discoveries++;
 const screen={screenToDipRect:(_w,r)=>r,getDisplayMatching:()=>({workArea:{x:0,y:0,width:1600,height:1000}})};
 const original=Module._load;const file=require.resolve("./assistant.cjs");delete require.cache[file];
 let assistant;
 try {
  Module._load=function(name,parent,...args){
   if(parent?.filename===file&&name==="electron")return {screen};
   if(parent?.filename===file&&name==="./chrome-watch.cjs")return {watchChrome:callback=>{receive=callback;return stop;}};
   return original.call(this,name,parent,...args);
  };
  assistant=require(file).assistant({panel,overlay,publish(){},clearDemo(){},ownFocused:()=>false});
 } finally {Module._load=original;delete require.cache[file];}
 const snap={context:"123:"+"A".repeat(20)+":doc:nav",signature:"first",active:true,elements:[],viewport:{x:0,y:0,width:700,height:600}};
 return {assistant,panel,snap,receive:(data,reason="",meta)=>receive(data,reason,meta),opens:()=>opens,discoveries:()=>discoveries};
}
test("Chrome→패널은 유지, 다른 앱에서는 숨김, 수동 재열기에서 재탐색 요청",()=>{
 const f=fixture();try{
  f.receive(f.snap);assert.equal(f.panel.isVisible(),true);
  f.receive({...f.snap,active:false});assert.equal(f.panel.isVisible(),true);assert.equal(f.opens(),1);
  f.receive(null,"other_app");assert.equal(f.panel.isVisible(),false);
  f.assistant.manualOpen();f.panel.showInactive();assert.equal(f.discoveries(),1);
  f.receive({...f.snap,active:false});assert.equal(f.panel.isVisible(),true);
  f.receive(f.snap);assert.equal(f.panel.isVisible(),true);
  f.receive(null,"url_not_target");assert.equal(f.panel.isVisible(),false);
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
