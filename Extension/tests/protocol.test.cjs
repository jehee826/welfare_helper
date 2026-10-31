const {test}=require('node:test'),assert=require('node:assert/strict');
const p=require('../protocol.js');
const ids=['A','B','C'].map(c=>c.repeat(20));
const payload={source:'dom',snapshot_id:'F'.repeat(20),question:'검색은 어디서 해?',screen_context:[],candidates:ids.map((id,i)=>({id,label:'공개 메뉴 '+i,role:'Button',enabled:true,visible:true}))};
test('0~3개 대상·설명·추가질문을 검증하고 색상은 모델에 맡기지 않음',()=>{
 for(const targets of [[],ids.map(target_id=>({target_id,meaning:'공개 메뉴'}))])assert.equal(p.reply({reply:{snapshot_id:payload.snapshot_id,kind:'설명',answer:'화면의 공개 기능입니다.',targets}},payload).targets.length,targets.length);
 assert.equal(p.reply({reply:{snapshot_id:payload.snapshot_id,kind:'추가질문',answer:'어떤 항목을 말씀하시나요?',targets:[]}},payload).kind,'추가질문');
});
test('가짜 ID·중복·늦은 스냅샷·모델 색상/코드·모달 뒤 대상을 거부',()=>{
 const r={snapshot_id:payload.snapshot_id,kind:'안내',answer:'메뉴를 확인하세요.',targets:[{target_id:ids[0],meaning:'공개 메뉴'}]};
 for(const change of [{snapshot_id:'E'.repeat(20)},{answer:'파란 버튼을 누르세요.'},{answer:'화면의 1번 항목을 누르세요.'},{answer:'querySelector 실행'},{targets:[r.targets[0],r.targets[0]]},{targets:[{target_id:'D'.repeat(20),meaning:'없는 대상'}]}])assert.throws(()=>p.reply({reply:{...r,...change}},payload));
 assert.throws(()=>p.reply({reply:r},{...payload,modal_open:true}));
});
test('다른 사이트·사설 실행 주소·임의 실행 역할·개인 질문을 차단',()=>{
 assert.equal(p.official('https://www.bokjiro.go.kr/ssis-tbu/index.do'),true);assert.equal(p.official('https://www.bokjiro.go.kr.evil.test'),false);
 assert.equal(p.official('https://user:secret@www.bokjiro.go.kr/'),false);
 for(const change of [{question:'인증코드 123456'},{candidates:[{...payload.candidates[0],role:'Execute'}]},{candidates:[payload.candidates[0],payload.candidates[0]]}])assert.throws(()=>p.request({...payload,...change}));
});
