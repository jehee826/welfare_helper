const {test}=require('node:test'),assert=require('node:assert/strict');
const {worker,ui,answer,settle}=require('./conversation_fixture.cjs');

const local={name:'로컬 한국어',lang:'ko-KR',localService:true};
const remote={name:'원격 한국어',lang:'ko-KR',localService:false};
const english={name:'local en',lang:'en-US',localService:true};
const contact={label:'합성 기관',phone:'02-123-4567',kind:'service',source_url:'https://www.example.go.kr/help',checked_at:'2026-11-03',hours:'평일 9시~18시'};

function speechHarness(initialVoices=[local]){
  const spoken=[],listeners=new Set();let voices=initialVoices,cancels=0;
  const synth={getVoices:()=>voices,speak(utterance){spoken.push(utterance);},cancel(){cancels++;const pending=spoken.filter(item=>!item.done);for(const item of pending){item.done=true;item.onerror?.({error:'interrupted'});}},
    addEventListener(type,fn){if(type==='voiceschanged')listeners.add(fn);},removeEventListener(type,fn){listeners.delete(fn);}};
  return {spoken,get cancels(){return cancels;},
    setVoices(next){voices=next;for(const fn of [...listeners])fn();},
    finish(){for(const item of spoken.filter(item=>!item.done)){item.done=true;item.onend?.();}},
    setup:w=>{w.speechSynthesis=synth;w.SpeechSynthesisUtterance=class{constructor(text){this.text=text;}};}};
}
function fixture(harness,extra=()=>{}){const f=ui(worker(),1,w=>{harness?.setup(w);extra(w);});return f;}
const speakButtons=f=>[...f.root.querySelectorAll('.speak-answer')];

test('본문 URL과 내부 식별자는 낭독에서만 빼고 조건·예외·숫자·업무 연락처를 보존한다',async()=>{
  const h=speechHarness(),f=fixture(h);
  const text='신청은 https://www.example.go.kr/help?doc=10 또는 [공식 안내](https://example.go.kr/path)에서 확인하세요.\n만 65세 이상, 소득 2.5% 이하, 1,000,000원. 예외는 별도 확인하세요. 전화 02-123-4567.\n문서 참조 document_id: doc-123, chunk_id=C1, snapshot_id=ABCDEF0123456789ABCD, target_id: ABCDEF0123456789ABCE. 123e4567-e89b-12d3-a456-426614174000';
  try{
    await f.ready();await f.question('합성 질문');await f.answer({...answer,text,contacts:[contact]});
    speakButtons(f)[0].click();await settle();const spoken=h.spoken.map(item=>item.text).join(' ');
    assert.doesNotMatch(spoken,/https|www|example|doc-123|document|chunk|snapshot|target|ABCDEF|123e4567|\bC1\b/);
    assert.match(spoken,/공식 안내/);assert.match(spoken,/만 65세 이상, 소득 2\.5% 이하, 1,000,000원/);
    assert.match(spoken,/예외는 별도 확인하세요/);assert.match(spoken,/02-123-4567/);assert.match(spoken,/0 2, 1 2 3, 4 5 6 7/);
    assert.equal(f.root.querySelector('.assistant-message div').textContent,text);
  }finally{f.close();}
});

test('완료된 답변은 자동 재생하지 않고 로컬 한국어 음성으로만 본문과 문의처를 읽는다',async()=>{
  const h=speechHarness([remote,english,local]),f=fixture(h);
  try{
    await f.ready();await f.question('합성 질문');await f.answer({kind:'answer',text:'합성 복지 안내입니다.\n신청은 주민센터에서 합니다.',evidence:[],contacts:[contact]});
    assert.equal(h.spoken.length,0);const [button]=speakButtons(f);assert.equal(button.textContent,'읽기');
    button.click();await settle();
    assert.ok(h.spoken.length>0);assert.ok(h.spoken.every(item=>item.voice===local&&item.lang==='ko-KR'));
    const text=h.spoken.map(item=>item.text).join(' ');
    assert.match(text,/합성 복지 안내입니다\..*신청은 주민센터에서 합니다\./);assert.match(text,/0 2, 1 2 3, 4 5 6 7/);assert.match(text,/평일 9시부터 18시/);
    assert.doesNotMatch(text,/https?:|example\.go\.kr|출처|참고자료/);
    assert.equal(button.textContent,'정지');assert.equal(button.getAttribute('aria-pressed'),'true');
    h.finish();assert.equal(button.textContent,'읽기');assert.equal(button.getAttribute('aria-pressed'),'false');
  }finally{f.close();}
});

test('원격 음성만 있으면 외부로 보내지 않고 안내하며 텍스트 상담은 계속된다',async()=>{
  const h=speechHarness([remote,english]),f=fixture(h);
  try{
    await f.ready();await f.question('합성 질문');await f.answer(answer);speakButtons(f)[0].click();await settle();
    assert.equal(h.spoken.length,0);assert.match(f.root.querySelector('.status').textContent,/기기 내 음성이 없어/);
    await f.question('두 번째 합성 질문');assert.equal(f.ports.length,2);
  }finally{f.close();}
});

test('음성합성을 지원하지 않으면 읽기 버튼만 안내하고 질문 흐름은 그대로다',async()=>{
  const f=fixture(null);
  try{
    await f.ready();await f.question('합성 질문');await f.answer(answer);speakButtons(f)[0].click();await settle();
    assert.match(f.root.querySelector('.status').textContent,/지원하지 않아요/);assert.match(f.root.querySelector('.conversation').textContent,/합성 복지 안내/);
  }finally{f.close();}
});

test('음성 목록이 늦게 오면 voiceschanged 뒤 로컬 한국어 음성으로 읽는다',async()=>{
  const h=speechHarness([]),f=fixture(h);
  try{
    await f.ready();await f.question('합성 질문');await f.answer(answer);speakButtons(f)[0].click();await settle();
    assert.equal(h.spoken.length,0);h.setVoices([remote,local]);await settle();
    assert.ok(h.spoken.length>0);assert.ok(h.spoken.every(item=>item.voice===local));
  }finally{f.close();}
});

test('같은 버튼을 다시 누르면 정지하고 다른 답변을 누르면 이전 낭독을 멈춘다',async()=>{
  const h=speechHarness(),f=fixture(h);
  try{
    await f.ready();await f.question('첫 질문');await f.answer({...answer,text:'첫 답변'});await f.question('둘째 질문');await f.answer({...answer,text:'둘째 답변'});
    const [first,second]=speakButtons(f);
    first.click();await settle();first.click();await settle();assert.equal(first.textContent,'읽기');assert.equal(h.cancels,1);
    const before=h.spoken.length;first.click();await settle();second.click();await settle();
    assert.equal(first.textContent,'읽기');assert.equal(second.textContent,'정지');assert.equal(h.spoken.at(-1).text,'둘째 답변');assert.ok(h.spoken.length>before);
  }finally{f.close();}
});

test('취소된 낭독의 늦은 종료 이벤트는 새 낭독 상태를 바꾸지 않는다',async()=>{
  const h=speechHarness(),f=fixture(h);
  try{
    await f.ready();await f.question('첫 질문');await f.answer({...answer,text:'첫 답변'});await f.question('둘째 질문');await f.answer({...answer,text:'둘째 답변'});
    const [first,second]=speakButtons(f);first.click();await settle();const stale=h.spoken.at(-1);second.click();await settle();
    stale.onend?.();stale.onerror?.({error:'synthesis-failed'});
    assert.equal(second.textContent,'정지');assert.doesNotMatch(f.root.querySelector('.status').textContent,/마치지 못했어요/);
  }finally{f.close();}
});

test('음성 입력을 시작하면 낭독을 먼저 멈춘다',async()=>{
  const h=speechHarness(),f=fixture(h,w=>{w.SpeechRecognition=class{start(){}abort(){}};});
  try{
    await f.ready();await f.question('합성 질문');await f.answer(answer);const [button]=speakButtons(f);button.click();await settle();
    const cancels=h.cancels;f.root.querySelector('.voice-start').click();await settle();
    assert.ok(h.cancels>cancels);assert.equal(button.textContent,'읽기');
  }finally{f.close();}
});

test('패널 닫기·대화 지우기·페이지 이탈은 낭독을 멈춘다',async()=>{
  const h=speechHarness(),f=fixture(h);
  try{
    await f.ready();await f.question('합성 질문');await f.answer(answer);const [button]=speakButtons(f);
    button.click();await settle();f.root.querySelector('.close').click();await settle();assert.equal(button.textContent,'읽기');
    f.root.querySelector('.open').click();await settle();button.click();await settle();
    const cancels=h.cancels;f.w.dispatchEvent(new f.w.Event('pagehide'));assert.ok(h.cancels>cancels);assert.equal(button.textContent,'읽기');
  }finally{f.close();}
});

test('긴 본문은 순서를 지키며 나눠 읽고 내용을 빠뜨리지 않는다',async()=>{
  const h=speechHarness(),f=fixture(h);
  const long=Array.from({length:30},(_,i)=>`조건 ${i+1}번은 반드시 확인해야 합니다.`).join(' ')+'\n예외: 소득 기준을 넘으면 지원하지 않습니다.';
  try{
    await f.ready();await f.question('합성 질문');await f.answer({...answer,text:long});speakButtons(f)[0].click();await settle();
    assert.ok(h.spoken.length>2);assert.ok(h.spoken.every(item=>item.text.length<=180));
    assert.equal(h.spoken.map(item=>item.text).join(' ').replace(/\s+/g,' '),long.replace('예외:','예외').replace(/\s+/g,' '));
  }finally{f.close();}
});

test('화면 안내 답변도 표시된 안내문만 읽고 자동 재생하지 않는다',async()=>{
  const h=speechHarness(),f=fixture(h);
  try{
    await f.mode('screen');await f.question('공개 메뉴는 어디 있어?');const payload=f.ports.at(-1).packet.payload;
    await f.answer({reply:{snapshot_id:payload.snapshot_id,kind:'안내',answer:'공개 메뉴를 확인하세요.',targets:[{target_id:payload.candidates[0].id,meaning:'공개 메뉴'}]}});
    assert.equal(h.spoken.length,0);const button=speakButtons(f).at(-1);button.click();await settle();
    const text=h.spoken.map(item=>item.text).join(' ');assert.match(text,/공개 메뉴를 확인하세요/);assert.doesNotMatch(text,/snapshot|target_id|https?:/);
  }finally{f.close();}
});

test('읽고 있지 않을 때 질문·취소는 페이지의 음성합성을 끊지 않는다',async()=>{
  const h=speechHarness(),f=fixture(h);
  try{
    await f.ready();await f.question('첫 질문');await f.answer(answer);await f.question('둘째 질문');f.root.querySelector('.clear')?.click();await settle();
    assert.equal(h.cancels,0);
  }finally{f.close();}
});

test('나눈 조각은 구분점이 180번째 글자여도 180자를 넘지 않고 문장 끝을 먼저 고른다',async()=>{
  const h=speechHarness(),f=fixture(h);
  const edge='가'.repeat(100)+' '+'나'.repeat(79)+'. '+'다'.repeat(50),sentence='라'.repeat(99)+'. '+'마마 '.repeat(40).trim();
  try{
    await f.ready();await f.question('합성 질문');await f.answer({...answer,text:edge+'\n'+sentence});speakButtons(f)[0].click();await settle();
    const parts=h.spoken.map(item=>item.text);
    assert.ok(parts.every(part=>part.length<=180),JSON.stringify(parts.map(part=>part.length)));
    assert.equal(parts.join(' ').replace(/\s+/g,' '),(edge+' '+sentence).replace(/\s+/g,' '));
    assert.ok(parts.includes('라'.repeat(99)+'.'));
  }finally{f.close();}
});

test('읽기는 특수문자를 읽지 않고 표시 번호·범위는 말로 바꾸며 숫자 표기는 유지한다',async()=>{
  const h=speechHarness(),f=fixture(h);
  try{
    await f.ready();await f.question('합성 질문');
    await f.answer({...answer,text:'※ 신청 기한: 2026-11-30(토)까지 → 주민센터 / 온라인\n• 소득 2.5% 이하, 금액 1,000,000원 · 시간 09:30~18:00 「안내」'});
    speakButtons(f)[0].click();await settle();const text=h.spoken.map(item=>item.text).join(' ');
    assert.doesNotMatch(text,/[※→\/•·()「」~]|[^\d]:|:[^\d]/u);
    assert.match(text,/신청 기한 2026-11-30 토 까지 주민센터 온라인/);assert.match(text,/소득 2\.5% 이하, 금액 1,000,000원 시간 09:30부터 18:00 안내/);
    assert.match(f.root.querySelector('.conversation').textContent,/※ 신청 기한: 2026-11-30\(토\)까지/);
    h.finish();await f.mode('screen');await f.question('공개 메뉴는 어디 있어?');const payload=f.ports.at(-1).packet.payload;
    await f.answer({reply:{snapshot_id:payload.snapshot_id,kind:'안내',answer:'공개 메뉴를 확인하세요.',targets:[{target_id:payload.candidates[0].id,meaning:'공개 메뉴'}]}});
    const before=h.spoken.length;speakButtons(f).at(-1).click();await settle();const screen=h.spoken.slice(before).map(item=>item.text).join(' ');
    assert.match(screen,/1번 파랑 테두리의/);assert.doesNotMatch(screen,/[①‘’·]/u);
  }finally{f.close();}
});
