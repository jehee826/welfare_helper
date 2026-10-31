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
test("잘린 JSON·가짜 ID·실패형식·비밀 목표는 보류",()=>{
 const elements=p.sanitizeSnapshot(raw).elements;
 const step={target_id:id,action:"안내",instruction:"로그인 버튼의 위치를 확인하세요.",expect_label:"다음"};
 assert.equal(p.parseStep(JSON.stringify(step),elements).target_id,id);
 for(const change of [{offscreen:true},{enabled:false}])assert.throws(()=>p.parseStep(JSON.stringify(step),[{...elements[0],...change}]));
 for(const value of ["{",JSON.stringify({...step,target_id:"unknown"}),JSON.stringify({...step,action:"완료"}),JSON.stringify({...step,expect_label:"개인정보"}),JSON.stringify({...step,extra:1})])assert.throws(()=>p.parseStep(value,elements));
 for(const goal of ["인증코드 123456","abc@example.com","주민번호 입력",""])assert.throws(()=>p.safeGoal(goal));
});
test("UIA 가림·비활성·화면밖·패널겹침에서 강조하지 않음",()=>{
 const snap=p.sanitizeSnapshot(raw),convert=r=>r;
 assert.deepEqual(p.realHighlight(snap,id,convert,[view],null,true),box);
 for(const snap2 of [{...snap,active:false},{...snap,elements:[{...snap.elements[0],hit:false}]},{...snap,elements:[{...snap.elements[0],offscreen:true}]}])assert.equal(p.realHighlight(snap2,id,convert,[view],null,true),null);
 assert.equal(p.realHighlight(snap,id,convert,[view],box,true),null);
 assert.equal(p.realHighlight(snap,id,r=>({...r,x:-20}),[view],null,true),null);
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
