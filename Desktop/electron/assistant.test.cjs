const {test}=require("node:test");const assert=require("node:assert/strict");
const p=require("./assistant-policy.cjs");const {LatestGuide,configuration,guideStep}=require("./local-clients.cjs");
const id="A".repeat(20),tab="B".repeat(20),doc="C".repeat(20),nav="D".repeat(20);
const box={x:10,y:10,width:100,height:40},view={x:0,y:0,width:800,height:600};
const raw={available:true,active:true,window:"123",tab,document:doc,navigation:nav,viewport:view,elements:[{id,name:"로그인",role:"Button",rect:box,enabled:true,offscreen:false,hit:true}]};
test("정확한 HTTPS 호스트만 허용하고 로컬 서버 외 주소 거부",()=>{
 assert.equal(p.bokjiroUrl("https://www.bokjiro.go.kr/ssis-tbu/index.do"),true);
 for(const url of ["http://www.bokjiro.go.kr","https://www.bokjiro.go.kr.evil.test","https://www.bokjiro.go.kr@evil.test","https://evil.test/?url=https://www.bokjiro.go.kr","https://www.bokjiro.go.kr:444","https://user@www.bokjiro.go.kr"])assert.equal(p.bokjiroUrl(url),false);
 assert.equal(p.localOrigin("http://127.0.0.1:8000",8000),"http://127.0.0.1:8000");
 for(const url of ["https://15.164.190.21","http://127.0.0.1:11434","http://localhost:8000/api","http://u@localhost:8000"])assert.throws(()=>p.localOrigin(url,8000));
});
test("후보 공개 라벨 필터와 스크롤 비추론 서명",()=>{
 const first=p.sanitizeSnapshot(raw);assert.equal(first.elements.length,1);
 const second=p.sanitizeSnapshot({...raw,elements:[{...raw.elements[0],rect:{...box,y:400},offscreen:true,hit:false}]});
 assert.equal(first.signature,second.signature);
 assert.notEqual(first.signature,p.sanitizeSnapshot({...raw,navigation:"E".repeat(20)}).signature);
 assert.equal(p.sanitizeSnapshot({...raw,elements:[{...raw.elements[0],name:"개인 이름과 입력값"}]}).elements.length,0);
 assert.equal(p.sanitizeSnapshot({...raw,available:false}),null);
});

test("본문 공개 라벨과 실제 스크롤 범위만 전달함",()=>{
 const result=p.sanitizeSnapshot({...raw,page_labels:["사용자 개인 텍스트","복지서비스","복지서비스"],scroll_percent:0});
 assert.deepEqual(result.pageLabels,["복지서비스"]);
 assert.equal(result.scrollPercent,0);
 for(const value of [-1,101,NaN,"20"])assert.equal(p.sanitizeSnapshot({...raw,scroll_percent:value}).scrollPercent,null);
 assert.equal(result.signature,p.sanitizeSnapshot({...raw,page_labels:["복지서비스"],scroll_percent:20}).signature);
});

test("임의 공개문구 추측·입력값·도움말은 경계에서 버리고 설명 응답은 대상 없이 허용",()=>{
 const snap=p.sanitizeSnapshot({...raw,screen_context:[{kind:"text",text:"복지서비스"},{kind:"label",text:"사용자 이름"},{kind:"help",text:"개인 인증 안내"}]});
 assert.deepEqual(snap.screenContext,[{kind:"text",text:"복지서비스"}]);
 const answer={action:"설명",target_id:null,instruction:"현재 화면에서 확인된 기능을 설명합니다.",expect_label:null};
 assert.equal(p.validateStep(answer,snap.elements).action,"설명");
 assert.throws(()=>p.validateStep({...answer,target_id:id},snap.elements));
});

test("패널 강조는 정확 패널 포커스의 새 UIA hit만 허용",()=>{
 const snap={...p.sanitizeSnapshot(raw),active:false,panelFocused:true,verifiedAt:Date.now()};
 assert.equal(p.realHighlight(snap,id,r=>r,[view],null,true).reason,"visible");
 assert.equal(p.realHighlight({...snap,verifiedAt:0},id,r=>r,[view],null,true).reason,"inactive");
 assert.equal(p.realHighlight({...snap,panelFocused:false},id,r=>r,[view],null,true).reason,"inactive");
});

test("UIA 화면밖 표시가 누락돼도 페이지 영역 밖 대상은 선택하지 않음",()=>{
 const snap=p.sanitizeSnapshot({...raw,elements:[{...raw.elements[0],rect:{...box,y:650},offscreen:false}]});
 assert.equal(snap.elements[0].offscreen,true);
 assert.throws(()=>p.validateStep({target_id:id,action:"안내",instruction:"선택하세요.",expect_label:null},snap.elements));
});

test("모달이 열리면 뒤의 버튼은 요청·안내·강조 대상에서 제외됨",async()=>{
 const closeId="E".repeat(20);
 const snap=p.sanitizeSnapshot({...raw,modal_open:true,elements:[raw.elements[0],{...raw.elements[0],id:closeId,name:"닫기",in_modal:true}]});
 assert.equal(snap.elements[0].blocked,true);assert.equal(snap.elements[1].blocked,false);
 const step={target_id:id,action:"안내",instruction:"선택하세요.",expect_label:null};
 assert.throws(()=>p.validateStep(step,snap.elements));
 assert.equal(p.realHighlight(snap,id,r=>r,[view],null,true).reason,"modal_covered");
 const original=global.fetch;
 global.fetch=async(_url,options)=>{
  assert.deepEqual(JSON.parse(options.body).candidates.map(c=>c.id),[closeId]);
  return {ok:true,body:new ReadableStream({start(c){c.enqueue(Buffer.from(JSON.stringify({step:{...step,target_id:closeId},model:"test"})));c.close();}})};
 };
 try{assert.equal((await guideStep("복지서비스 찾기",snap,[],new AbortController().signal)).target_id,closeId);}
 finally{global.fetch=original;}
});
test("화면 안내 전송에는 합성 이미지 필드를 포함하지 않는다",async()=>{
 let calls=0;const original=global.fetch;global.fetch=async(_url,options)=>{calls++;const body=JSON.parse(options.body);assert.equal(Object.hasOwn(body,'image'),false);return {ok:true,body:new ReadableStream({start(c){c.enqueue(Buffer.from(JSON.stringify({step:{target_id:null,action:'설명',instruction:'공개 화면입니다.',expect_label:null},model:'test'})));c.close();}})};};
 try{await guideStep('화면 설명',{elements:[],image:'synthetic'},[],new AbortController().signal);assert.equal(calls,1);}finally{global.fetch=original;}
});
test("객체 경계에서 가짜 ID·실패형식·비밀 목표는 보류",()=>{
 const elements=p.sanitizeSnapshot(raw).elements;
 const step={target_id:id,action:"안내",instruction:"로그인 버튼의 위치를 확인하세요.",expect_label:"다음"};
 assert.equal(p.validateStep(step,elements).target_id,id);
 for(const change of [{offscreen:true},{enabled:false},{blocked:true}])assert.throws(()=>p.validateStep(step,[{...elements[0],...change}]),{message:"unknown_target"});
 for(const value of [null,[],"{",{...step,target_id:"unknown"},{...step,action:"완료"},{...step,expect_label:"개인정보"},{...step,extra:1},{...step,instruction:""},{...step,instruction:123}])assert.throws(()=>p.validateStep(value,elements));
 for(const goal of ["인증코드 123456","abc@example.com","주민번호 입력",""])assert.throws(()=>p.safeGoal(goal));
});
test("HTTP 경계에서 잘린 JSON·응답 크기 초과를 거절하고 reader를 정리함",async()=>{
 const original=global.fetch;
 try{
  for(const [chunk,error] of [[Buffer.from('{"step":'),SyntaxError],[Buffer.alloc(2*1024*1024+1),{message:"response_limit"}]]){
   let reads=0,cancelled=0;
   global.fetch=async()=>({ok:true,body:{getReader:()=>({
    read:async()=>reads++===0?{done:false,value:chunk}:{done:true},
    cancel:async()=>{cancelled++;},
   })}});
   await assert.rejects(guideStep("복지서비스 찾기",{elements:[]},[],new AbortController().signal),error);
   assert.equal(cancelled,1);
  }
 }finally{global.fetch=original;}
});
test("UIA 가림·비활성·화면밖·패널겹침에서 강조하지 않음",()=>{
 const snap=p.sanitizeSnapshot(raw),convert=r=>r;
 assert.deepEqual(p.realHighlight(snap,id,convert,[view],null,true),{rect:box,reason:"visible"});
 for(const [snap2,reason] of [[{...snap,active:false},"inactive"],[{...snap,elements:[{...snap.elements[0],hit:false}]},"occluded"],[{...snap,elements:[{...snap.elements[0],offscreen:true}]},"offscreen"]])assert.deepEqual(p.realHighlight(snap2,id,convert,[view],null,true),{rect:null,reason});
 assert.deepEqual(p.realHighlight(snap,id,convert,[view],box,true),{rect:null,reason:"panel_covered"});
 assert.deepEqual(p.realHighlight(snap,id,r=>({...r,x:-20}),[view],null,true),{rect:null,reason:"display_unknown"});
});
test("화면 안내 단일 실행·최신 요청 합치기·취소 후 오래된 결과 폐기",async()=>{
 const queue=new LatestGuide(),results=[];let active=0,max=0;
 const task=name=>async signal=>{active++;max=Math.max(max,active);await new Promise(resolve=>{const timer=setTimeout(resolve,15);signal.addEventListener("abort",()=>{clearTimeout(timer);resolve();},{once:true});});active--;return name;};
 queue.submit(task("old"),(e,v)=>results.push(v));
 queue.submit(task("middle"),(e,v)=>results.push(v));
 queue.submit(task("new"),(e,v)=>results.push(v));
 await new Promise(resolve=>setTimeout(resolve,60));assert.equal(max,1);assert.deepEqual(results,["new"]);
});

test("서버가 바쁠 때 재시도 대기는 취소할 수 있다",async()=>{
 const original=global.fetch,controller=new AbortController();let calls=0;
 global.fetch=async()=>{calls++;return {ok:false,status:429};};
 try{
  const request=guideStep("복지서비스 찾기",{elements:[]},[],controller.signal);
  await new Promise(setImmediate);controller.abort();
  await assert.rejects(request);assert.equal(calls,1);
 }finally{global.fetch=original;}
});

test("서버가 바쁜 응답 뒤 정상 응답을 받으면 안내한다",async()=>{
 const original=global.fetch;let calls=0;
 global.fetch=async()=>++calls===1?{ok:false,status:429}:{ok:true,body:new ReadableStream({start(c){c.enqueue(Buffer.from(JSON.stringify({step:{action:"보류",target_id:null,instruction:"확인하세요.",expect_label:null},model:"test"})));c.close();}})};
 try{const result=await guideStep("복지서비스 찾기",{elements:[]},[],new AbortController().signal);assert.equal(result.action,"보류");assert.equal(calls,2);}
 finally{global.fetch=original;}
});

test("비활성·생성 실패·연결 실패를 구분하며 429 외에는 재시도하지 않음",async()=>{
 const original=global.fetch;
 try {
  for(const [status,message] of [[404,"guide_disabled"],[503,"guide_generation_failed"],[500,"local_service_error"]]){
   let calls=0;global.fetch=async()=>{calls++;return {ok:false,status};};
   await assert.rejects(guideStep("복지서비스 찾기",{elements:[]},[],new AbortController().signal),{message});
   assert.equal(calls,1);
  }
  global.fetch=async()=>{throw new TypeError("fetch failed");};
  await assert.rejects(guideStep("복지서비스 찾기",{elements:[]},[],new AbortController().signal),{message:"local_connection_failed"});
 }finally{global.fetch=original;}
});

test("429 대기 25회 종료와 전체 90초 종료를 구분함",async t=>{
 const original=global.fetch;let calls=0,busy=0;
 t.mock.timers.enable({apis:["setTimeout"]});
 global.fetch=async()=>{calls++;return {ok:false,status:429};};
 try {
  const outcome=assert.rejects(guideStep("복지서비스 찾기",{elements:[]},[],new AbortController().signal,[],null,()=>busy++),{message:"guide_busy_exhausted"});
  for(let i=0;i<25;i++){await new Promise(setImmediate);t.mock.timers.tick(3000);}
  await outcome;assert.equal(calls,25);assert.equal(busy,24);
  const queue=new LatestGuide(),errors=[];
  queue.submit(signal=>new Promise((_,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true})),error=>errors.push(error));
  t.mock.timers.tick(90000);await new Promise(setImmediate);
  assert.deepEqual(errors,["guide_timeout"]);
  queue.submit(signal=>new Promise((_,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true})),error=>errors.push(error));
  queue.cancel();await new Promise(setImmediate);
  assert.deepEqual(errors,["guide_timeout","guide_cancelled"]);
 }finally{global.fetch=original;}
});
