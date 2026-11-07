const {test}=require('node:test'),assert=require('node:assert/strict');
const {worker,ui,answer,settle}=require('./conversation_fixture.cjs');
const protocol=require('../protocol.js');
function fixture(response){
  const server=worker(undefined,{},undefined,async url=>{
    assert.ok([protocol.documentOrigin()+'/api/v1/chat/capabilities',protocol.documentOrigin()+'/api/v1/conversation/summary'].includes(url));
    if(url.endsWith('/conversation/summary'))return new Response('{}',{status:404});
    return response();
  });
  return {...ui(server),server};
}
const metadata=enabled=>new Response(JSON.stringify({profile_context_supported:false,referral_records_enabled:enabled}));

test('활성 수집 고지는 질문 포트를 열기 전에 표시하며 수신 확인·개인정보 필드를 추가하지 않는다',async()=>{
  const f=fixture(()=>metadata(true));
  try{
    await f.ready();const connect=f.w.chrome.runtime.connect,notice=f.root.querySelector('.referral-notice');
    assert.equal(notice.hidden,false);assert.equal(notice.parentElement,f.root.querySelector('.consultation'));
    f.w.chrome.runtime.connect=(...args)=>{assert.equal(notice.hidden,false);return connect(...args);};
    await f.question('문의처를 알려주세요');assert.equal(f.ports.length,1);
    assert.match(notice.textContent,/90일/);assert.match(notice.textContent,/질문·답변·요약·프로필·IP/);assert.match(notice.textContent,/관리자 기간별 삭제/);
    assert.deepEqual(Object.keys(f.ports[0].packet.payload).sort(),['conversation_context','history','query']);
  }finally{f.close();}
});

for(const legacy of [false,true])test(`${legacy?'기존 서버 404':'비활성'} 상태는 수집 중으로 표시하지 않고 기존 질문을 유지한다`,async()=>{
  const f=fixture(()=>legacy?new Response('{}',{status:404}):metadata(false));
  try{await f.ready();await f.question('공개 질문');assert.equal(f.ports.length,1);assert.equal(f.root.querySelector('.referral-notice').hidden,true);}
  finally{f.close();}
});

for(const failure of ['server','invalid','offline'])test(`수집 설정 ${failure} 실패는 고지 없이 질문을 보내지 않는다`,async()=>{
  const f=fixture(()=>{if(failure==='offline')throw Error('network');return failure==='server'?new Response('{}',{status:503}):new Response(JSON.stringify({referral_records_enabled:'true'}));});
  try{await f.ready();await f.question('공개 질문');assert.equal(f.ports.length,0);assert.match(f.root.querySelector('.status').textContent,/수집 설정을 확인하지 못해/);}
  finally{f.close();}
});

test('같은 탭에서도 다음 질문의 활성 상태를 다시 확인하고 화면 안내에서는 고지를 숨긴다',async()=>{
  let enabled=false;const f=fixture(()=>metadata(enabled));
  try{
    await f.ready();await f.question('첫 질문');await f.answer(answer);assert.equal(f.root.querySelector('.referral-notice').hidden,true);
    enabled=true;await f.question('다음 질문');assert.equal(f.root.querySelector('.referral-notice').hidden,false);
    await f.mode('screen');assert.equal(f.root.querySelector('.referral-notice').hidden,true);
    await settle();
  }finally{f.close();}
});
