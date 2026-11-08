const {test}=require('node:test'),assert=require('node:assert/strict');
const {worker,ui,profileKey}=require('./conversation_fixture.cjs');

function pointer(f,type,{id=1,x=0,y=0,button=0,target=f.root.querySelector('.head'),primary=true}={}){
  const event=new f.w.Event(type,{bubbles:true});Object.assign(event,{pointerId:id,clientX:x,clientY:y,button,isPrimary:primary});target.dispatchEvent(event);
}
function dragFixture(setup){
  const f=ui(worker(),1,setup),panel=f.root.querySelector('.panel'),head=f.root.querySelector('.head'),captured=new Set();
  head.setPointerCapture=id=>captured.add(id);head.hasPointerCapture=id=>captured.has(id);head.releasePointerCapture=id=>captured.delete(id);
  panel.getBoundingClientRect=()=>{const width=Math.min(360,f.w.innerWidth-24),height=Math.min(500,f.w.innerHeight-24);return {width,height,left:parseFloat(panel.style.left)||f.w.innerWidth-width-12,top:parseFloat(panel.style.top)||f.w.innerHeight-height-12};};
  return {...f,panel,head,captured};
}

test('pagehide 뒤 초기 프로필 읽기가 끝나도 모달을 다시 열지 않고 pageshow에서 정상 조회한다',async()=>{
  let release,held=false;const pending=new Promise(resolve=>{release=resolve;});
  const server=worker(),f=ui(server,1,w=>{const send=w.chrome.runtime.sendMessage;w.chrome.runtime.sendMessage=message=>{if(message.type==='gyeote:profile-get'&&!held){held=true;return pending.then(()=>send(message));}return send(message);};});
  try{
    await f.ready();assert.equal(held,true);const layer=f.root.querySelector('.modal-layer');
    f.w.dispatchEvent(new f.w.Event('pagehide'));release();await f.ready();
    assert.equal(layer.hidden,true);assert.equal(f.w.document.body.hasAttribute('inert'),false);assert.notEqual(f.w.document.documentElement.style.overflow,'hidden');
    const resume=new f.w.Event('pageshow');Object.defineProperty(resume,'persisted',{value:true});f.w.dispatchEvent(resume);await f.ready();
    assert.equal(layer.hidden,true);assert.match(f.root.querySelector('.profile-panel').textContent,/저장한 조건이 없습니다/);
  }finally{release();f.close();}
});

test('내 정보는 채팅을 가리는 설정 화면이며 닫아도 요청·초안·스크롤·미저장 입력을 보존한다',async()=>{
  const server=worker(),f=ui(server);try{
    await f.ready();await f.question('진행 중인 합성 질문');const port=f.ports.at(-1);
    const input=f.root.querySelector('#gyeote-question'),transcript=f.root.querySelector('.transcript'),body=f.root.querySelector('.body'),slot=f.root.querySelector('.profile-slot'),toggle=f.root.querySelector('.profile-toggle');
    input.value='아직 보내지 않은 초안';transcript.scrollTop=73;body.scrollTop=11;toggle.focus();
    const writes=server.calls.set.length;toggle.click();
    assert.equal(slot.parentElement,f.root.querySelector('.modal-layer'));assert.equal(slot.getAttribute('role'),'dialog');assert.equal(slot.getAttribute('aria-modal'),'true');assert.equal(slot.hidden,false);
    assert.equal(f.root.querySelector('.panel').inert,true);assert.equal(f.root.querySelector('.panel').getAttribute('aria-hidden'),'true');assert.equal(f.w.document.body.inert,true);
    assert.equal(slot.contains(f.root.activeElement),true);assert.equal(toggle.disabled,false);
    await f.click('내 정보 수정');f.root.querySelector('.profile-panel input').value='61';
    f.root.querySelector('.profile-dismiss').click();
    assert.equal(slot.hidden,true);assert.equal(f.root.querySelector('.panel').inert,false);assert.equal(f.w.document.body.hasAttribute('inert'),false);assert.equal(f.root.activeElement,toggle);
    assert.equal(transcript.scrollTop,73);assert.equal(body.scrollTop,11);assert.equal(input.value,'아직 보내지 않은 초안');
    assert.notEqual(port.disconnected,true);assert.equal(server.calls.set.length,writes);
    toggle.click();assert.equal(f.root.querySelector('.profile-panel input').value,'61');toggle.click();assert.equal(slot.hidden,true);
  }finally{f.close();}
});

test('설정 화면은 키보드 이동·Esc·접기·모드 변경 뒤 가려진 채팅 포커스를 남기지 않는다',async()=>{
  const f=ui(worker());try{
    await f.ready();const toggle=f.root.querySelector('.profile-toggle'),slot=f.root.querySelector('.profile-slot'),resize=f.root.querySelector('.resize-handle');
    toggle.focus();toggle.click();resize.focus();
    resize.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));
    assert.equal(slot.contains(f.root.activeElement),true);
    f.root.activeElement.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    assert.equal(slot.hidden,true);assert.equal(f.root.activeElement,toggle);
    toggle.click();f.root.querySelector('.collapse').click();assert.equal(f.root.querySelector('.body').hidden,true);
    f.root.querySelector('.collapse').click();assert.equal(slot.hidden,true);toggle.click();assert.equal(slot.hidden,false);
    await f.mode('screen');assert.equal(slot.hidden,true);assert.equal(f.root.querySelector('.panel').inert,false);assert.equal(f.w.document.body.hasAttribute('inert'),false);
    await f.mode('document');assert.equal(slot.hidden,true);
  }finally{f.close();}
});

test('설정 저장 뒤에도 화면은 사용자가 닫을 때까지 열려 있고 포커스를 유지한다',async()=>{
  const server=worker(),f=ui(server);try{
    await f.ready();await f.click('내 정보');await f.click('내 정보 수정');f.root.querySelector('.profile-panel input').value='70';
    await f.click('내 정보 저장');
    const slot=f.root.querySelector('.profile-slot');assert.equal(slot.hidden,false);assert.equal(server.data[profileKey].profile.age,70);
    assert.equal(slot.contains(f.root.activeElement),true);assert.equal(f.root.querySelector('.panel').inert,true);
    await f.click('설정 닫기');assert.equal(slot.hidden,true);assert.equal(f.root.querySelector('.panel').inert,false);
  }finally{f.close();}
});

test('상담 메뉴도 사이트 전체를 막는 단일 모달이며 전환·Esc·바깥 클릭은 원래 상태로 돌아온다',async()=>{
  const f=ui(worker());try{
    await f.ready();await f.question('메뉴를 연 동안 유지할 질문');const port=f.ports.at(-1),input=f.root.querySelector('#gyeote-question'),menu=f.root.querySelector('.menu-toggle'),tools=f.root.querySelector('.panel-tools'),layer=f.root.querySelector('.modal-layer');
    input.value='메뉴 뒤의 초안';f.root.querySelector('.transcript').scrollTop=91;menu.focus();menu.click();
    assert.equal(tools.parentElement,layer);assert.equal(tools.hidden,false);assert.equal(tools.getAttribute('aria-modal'),'true');assert.equal(f.w.document.body.inert,true);assert.equal(tools.contains(f.root.activeElement),true);
    const last=[...tools.querySelectorAll('button')].at(-1);last.focus();last.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));assert.equal(f.root.activeElement,tools.querySelector('button'));
    f.root.querySelector('.profile-toggle').click();assert.equal(tools.hidden,true);assert.equal(f.root.querySelector('.profile-slot').hidden,false);assert.equal(layer.hidden,false);
    f.root.activeElement.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));assert.equal(layer.hidden,true);assert.equal(f.w.document.body.hasAttribute('inert'),false);
    menu.focus();menu.click();layer.click();assert.equal(layer.hidden,true);assert.equal(f.root.activeElement,menu);assert.equal(input.value,'메뉴 뒤의 초안');assert.equal(f.root.querySelector('.transcript').scrollTop,91);assert.notEqual(port.disconnected,true);
  }finally{f.close();}
});

test('모달은 기존 사이트 inert를 보존하고 페이지 종료 때 자신이 추가한 차단을 해제한다',async()=>{
  const f=ui(worker());try{
    await f.ready();f.w.document.documentElement.style.setProperty('overflow','auto','important');f.w.document.body.inert=true;f.w.document.body.setAttribute('inert','site-owned');f.root.querySelector('.menu-toggle').click();assert.equal(f.w.document.documentElement.style.overflow,'hidden');f.root.querySelector('.menu-dismiss').click();assert.equal(f.w.document.body.inert,true);assert.equal(f.w.document.body.getAttribute('inert'),'site-owned');assert.equal(f.w.document.documentElement.style.overflow,'auto');assert.equal(f.w.document.documentElement.style.getPropertyPriority('overflow'),'important');
    const pageStyle=f.w.document.documentElement.style;pageStyle.removeProperty('overflow');pageStyle.setProperty('overflow-x','hidden','important');pageStyle.setProperty('overflow-y','scroll');f.root.querySelector('.menu-toggle').click();f.root.querySelector('.menu-dismiss').click();assert.equal(pageStyle.getPropertyValue('overflow-x'),'hidden');assert.equal(pageStyle.getPropertyPriority('overflow-x'),'important');assert.equal(pageStyle.getPropertyValue('overflow-y'),'scroll');assert.equal(pageStyle.getPropertyPriority('overflow-y'),'');
    f.w.document.body.inert=false;f.w.document.body.removeAttribute('inert');f.root.querySelector('.profile-toggle').click();f.w.dispatchEvent(new f.w.Event('pagehide'));assert.equal(f.w.document.body.hasAttribute('inert'),false);assert.equal(f.root.querySelector('.modal-layer').hidden,true);
  }finally{f.close();}
});

test('기본 상담은 문서 안내와 텍스트 입력을 제공하고 개발 강제 표시 경로가 없다',async()=>{
  const f=ui(worker());try{
    await f.ready();assert.match(f.root.querySelector('.panel').getAttribute('aria-label'),/복지 상담/);
    assert.doesNotMatch(f.root.querySelector('.mode-intro').textContent,/화면/);assert.equal(f.root.querySelector('.screen-controls').hidden,true);
    assert.equal(f.root.querySelector('[data-test],.body-test'),null);assert.doesNotMatch(f.root.textContent,/개발용 표시 검사|이미지 범위 검사/);
    assert.equal(f.root.querySelectorAll('.question-suggestions button').length,3);assert.equal(f.root.querySelector('#gyeote-question').placeholder,'질문을 입력하세요');
    await f.mode('screen');assert.equal(f.root.querySelector('.screen-controls').hidden,false);assert.match(f.root.querySelector('.mode-intro').textContent,/공개 복지로 화면/);assert.equal(f.root.querySelector('.screen-controls > p'),null);assert.ok(f.root.querySelector('.screen-settings'));assert.ok(f.root.querySelector('.voice-input'));assert.ok(f.root.querySelector('button[type=submit]'));
    assert.equal(f.root.querySelector('.question-suggestions').hidden,true);
    const css=[...f.root.querySelectorAll('style')].map(node=>node.textContent).join('');
    assert.match(css,/font-size:16px/);assert.match(css,/min-height:40px/);assert.match(css,/select:focus-visible/);assert.match(css,/\.transcript\{[^}]*overflow:auto/);assert.doesNotMatch(css,/font-size:(?:11|12)px/);
  }finally{f.close();}
});

test('닫기·다시 열기·접기·펼치기는 상태와 초안을 유지하고 포커스를 복원한다',async()=>{
  const f=ui(worker());try{
    await f.ready();const input=f.root.querySelector('#gyeote-question'),collapse=f.root.querySelector('.collapse');input.value='확인할 질문';
    f.root.querySelector('.close').click();assert.equal(f.root.activeElement,f.root.querySelector('.open'));
    f.root.querySelector('.open').click();assert.equal(f.root.activeElement,input);assert.equal(input.value,'확인할 질문');
    const status=f.root.querySelector('.status');status.textContent='합성 오류';collapse.focus();collapse.click();assert.equal(collapse.getAttribute('aria-expanded'),'false');assert.equal(collapse.getAttribute('aria-label'),'패널 펼치기');assert.equal(f.root.querySelector('.body').hidden,true);assert.equal(status.textContent,'합성 오류');
    f.root.querySelector('.close').click();f.root.querySelector('.open').click();assert.equal(f.root.activeElement,collapse);
    collapse.click();assert.equal(collapse.getAttribute('aria-expanded'),'true');assert.equal(collapse.getAttribute('aria-label'),'패널 접기');assert.equal(f.root.activeElement,input);assert.equal(input.value,'확인할 질문');assert.equal(status.textContent,'합성 오류');
    f.notify({type:'gyeote:toggle'});assert.equal(f.root.activeElement,f.root.querySelector('.open'));f.notify({type:'gyeote:toggle'});assert.equal(f.root.activeElement,input);
  }finally{f.close();}
});

test('진행 중 접기는 요청과 대기 표시를 지우고 접힘 안내를 남기지 않는다',async()=>{const f=ui(worker());try{await f.ready();await f.question('합성 질문');const port=f.ports.at(-1);assert.ok(f.root.querySelector('.pending-reply'));f.root.querySelector('.collapse').click();assert.equal(port.disconnected,true);assert.equal(f.root.querySelector('.pending-reply'),null);assert.doesNotMatch(f.root.querySelector('.status').textContent,/접었|펼쳤/);f.root.querySelector('.collapse').click();assert.doesNotMatch(f.root.querySelector('.status').textContent,/접었|펼쳤/);}finally{f.close();}});

test('첫 이용 폼이 열려 있으면 다시 열 때 조작 가능한 조건 입력에 포커스한다',async()=>{
  const f=ui(worker({[profileKey]:{schemaVersion:1,revision:0,onboardingCompleted:false,profile:null}}));try{
    await f.ready();assert.equal(f.root.querySelector('#gyeote-question').closest('form').hidden,false);assert.equal(f.root.querySelector('.profile-panel').hidden,true);
    f.root.querySelector('.close').click();f.root.querySelector('.open').click();assert.equal(f.root.activeElement,f.root.querySelector('#gyeote-question'));
    f.root.querySelector('.profile-toggle').click();f.root.querySelector('.close').click();f.root.querySelector('.open').click();assert.equal(f.root.activeElement,f.root.querySelector('#gyeote-question'));f.root.querySelector('.profile-toggle').click();assert.equal(f.root.activeElement,f.root.querySelector('.profile-panel input'));
  }finally{f.close();}
});

test('드래그 후 320×568 창으로 축소해도 위치를 보정하고 초안·상담을 유지한다',async()=>{
  const f=dragFixture();try{
    await f.ready();const input=f.root.querySelector('#gyeote-question');input.value='유지할 초안';const before=JSON.stringify(f.requests);
    const r=f.panel.getBoundingClientRect();pointer(f,'pointerdown',{x:r.left+10,y:r.top+10});pointer(f,'pointermove',{x:1400,y:1000});assert.equal(f.captured.size,1);
    f.w.innerWidth=320;f.w.innerHeight=568;f.w.dispatchEvent(new f.w.Event('resize'));
    assert.equal(f.captured.size,0);assert.equal(f.panel.style.left,'20px');assert.equal(f.panel.style.top,'64px');
    assert.equal(input.value,'유지할 초안');assert.equal(JSON.stringify(f.requests),before);
    pointer(f,'pointermove',{x:0,y:0});assert.equal(f.panel.style.left,'20px');
    pointer(f,'pointerdown',{x:30,y:74});pointer(f,'pointermove',{x:-100,y:-100});assert.equal(f.panel.style.left,'4px');assert.equal(f.panel.style.top,'4px');
  }finally{f.close();}
});

for(const type of ['pointerup','pointercancel','lostpointercapture'])test(`${type} 뒤 움직임은 패널을 이동하지 않는다`,async()=>{
  const f=dragFixture();try{
    await f.ready();pointer(f,'pointerdown',{x:500,y:300});pointer(f,'pointermove',{x:450,y:250});pointer(f,type);
    const left=f.panel.style.left,top=f.panel.style.top;pointer(f,'pointermove',{x:30,y:30});assert.equal(f.panel.style.left,left);assert.equal(f.panel.style.top,top);assert.equal(f.captured.size,0);
  }finally{f.close();}
});

test('헤더 버튼·보조 포인터·다른 포인터 이벤트는 드래그를 시작하거나 가로채지 않는다',async()=>{
  const f=dragFixture();try{
    await f.ready();for(const args of [{button:2},{primary:false},{target:f.root.querySelector('.collapse')},{target:f.root.querySelector('.ui-opacity')}]){pointer(f,'pointerdown',args);assert.equal(f.captured.size,0);}
    pointer(f,'pointerdown',{id:2,x:500,y:300});pointer(f,'pointermove',{id:3,x:0,y:0});assert.equal(f.panel.style.left,'');
    pointer(f,'pointercancel',{id:3});assert.equal(f.captured.has(2),true);pointer(f,'pointercancel',{id:2});assert.equal(f.captured.size,0);
  }finally{f.close();}
});

test('현재 DOM의 이름·역할로만 다중 범례를 만들고 모델 meaning을 기능 사실로 표시하지 않는다',async()=>{
  const f=ui(worker());try{
    const first=f.w.document.querySelector('main button'),link=f.w.document.createElement('a');link.href='/service';link.textContent='서비스 소개';first.after(link);
    [first,link].forEach((node,i)=>node.getBoundingClientRect=()=>({left:40,right:180,top:60+i*80,bottom:100+i*80,width:140,height:40}));
    f.w.document.elementFromPoint=(_x,y)=>y<120?first:link;
    await f.mode('screen');await f.question('공개 메뉴와 서비스 소개는 어디 있어?');const port=f.ports.at(-1),payload=port.packet.payload;
    await f.answer({reply:{snapshot_id:payload.snapshot_id,kind:'안내',answer:'공개 메뉴와 서비스 소개 항목을 확인해 주세요.',targets:payload.candidates.map(c=>({target_id:c.id,meaning:'신청하면 지원이 확정됩니다.'}))}});
    const shown=f.root.querySelector('.conversation').textContent;assert.equal(f.root.querySelector('.status').textContent,'');assert.match(shown,/① 파랑 테두리의 ‘공개 메뉴’ · 버튼/);assert.match(shown,/② 주황 테두리의 ‘서비스 소개’ · 링크/);assert.doesNotMatch(shown,/지원이 확정/);assert.equal(f.root.querySelectorAll('.badge').length,2);
    f.root.querySelector('.clear').click();assert.equal(f.root.querySelectorAll('.badge').length,0);assert.equal(f.root.querySelector('.status').textContent,'');
  }finally{f.close();}
});

test('없는 ID와 이전 snapshot 응답은 범례와 강조를 만들지 않는다',async()=>{
  for(const invalid of ['id','snapshot']){
    const f=ui(worker());try{
      await f.mode('screen');await f.question('공개 메뉴는 어디 있어?');const payload=f.ports.at(-1).packet.payload;
      await f.answer({reply:{snapshot_id:invalid==='snapshot'?'Z'.repeat(20):payload.snapshot_id,kind:'안내',answer:'공개 메뉴를 확인하세요.',targets:[{target_id:invalid==='id'?'Y'.repeat(20):payload.candidates[0].id,meaning:'공개 메뉴'}]}});
      assert.equal(f.root.querySelectorAll('.badge').length,0);assert.doesNotMatch(f.root.querySelector('.status').textContent,/테두리/);
    }finally{f.close();}
  }
});

test('패널 크기 보정 뒤 가려진 대상의 강조와 범례를 정리한다',async()=>{
  let resized;
  const f=ui(worker(),1,w=>{w.ResizeObserver=class{constructor(callback){resized=callback;}observe(){}disconnect(){}};});
  try{
    await f.mode('screen');await f.question('공개 메뉴는 어디 있어?');const payload=f.ports.at(-1).packet.payload;
    await f.answer({reply:{snapshot_id:payload.snapshot_id,kind:'안내',answer:'공개 메뉴를 확인하세요.',targets:[{target_id:payload.candidates[0].id,meaning:'공개 메뉴'}]}});
    assert.equal(f.root.querySelectorAll('.badge').length,1);
    const panel=f.root.querySelector('.panel');panel.getBoundingClientRect=()=>({left:900,top:700,width:360,height:500});
    f.w.document.elementFromPoint=()=>f.w.document.querySelector('[data-gyeote-host]');
    resized();await f.ready();
    assert.equal(panel.style.left,'');assert.equal(panel.style.top,'');assert.equal(panel.style.right,'');
    assert.equal(f.root.querySelectorAll('.badge').length,0);assert.doesNotMatch(f.w.document.querySelector('main button').className,/gyeote-/);
    assert.match(f.root.querySelector('.status').textContent,/가려져/);assert.doesNotMatch(f.root.querySelector('.status').textContent,/파랑 테두리/);
  }finally{f.close();}
});

function viewport(f,width,height){f.w.innerWidth=width;f.w.innerHeight=height;f.w.dispatchEvent(new f.w.Event('resize'));}
function docked(panel){return ['left','top','right','bottom'].every(side=>panel.style[side]==='');}

test('기본 오른쪽 배치는 열기·폭 축소·확대·접기 뒤에도 오른쪽 여백 기준을 유지한다',async()=>{
  const f=dragFixture();try{
    await f.ready();assert.equal(docked(f.panel),true);
    viewport(f,1440,900);viewport(f,900,900);assert.equal(docked(f.panel),true);
    viewport(f,1440,900);assert.equal(docked(f.panel),true);
    viewport(f,1440,480);viewport(f,1440,900);assert.equal(docked(f.panel),true);
    f.root.querySelector('.collapse').click();viewport(f,900,600);f.root.querySelector('.collapse').click();assert.equal(docked(f.panel),true);
    f.root.querySelector('.close').click();viewport(f,1440,900);f.root.querySelector('.open').click();assert.equal(docked(f.panel),true);
  }finally{f.close();}
});

test('직접 옮긴 위치는 창 축소 때만 화면 안으로 보정하고 다시 넓어지면 원래 위치로 돌아간다',async()=>{
  const f=dragFixture();try{
    await f.ready();viewport(f,1440,900);
    const r=f.panel.getBoundingClientRect();pointer(f,'pointerdown',{x:r.left+10,y:r.top+10});pointer(f,'pointermove',{x:810,y:110});pointer(f,'pointerup');
    assert.equal(f.panel.style.left,'800px');assert.equal(f.panel.style.top,'100px');assert.equal(f.panel.style.right,'auto');
    viewport(f,900,500);assert.equal(f.panel.style.left,'536px');assert.equal(f.panel.style.top,'20px');
    viewport(f,1440,900);assert.equal(f.panel.style.left,'800px');assert.equal(f.panel.style.top,'100px');
    f.root.querySelector('.collapse').click();viewport(f,900,900);assert.equal(f.panel.style.left,'536px');
    f.root.querySelector('.collapse').click();viewport(f,1440,900);assert.equal(f.panel.style.left,'800px');assert.equal(f.panel.style.top,'100px');
  }finally{f.close();}
});

test('헤더를 두 번 누르면 직접 옮긴 패널을 기본 오른쪽 배치로 되돌리고 버튼에서는 되돌리지 않는다',async()=>{
  const f=dragFixture();try{
    await f.ready();viewport(f,1440,900);
    const r=f.panel.getBoundingClientRect();pointer(f,'pointerdown',{x:r.left+10,y:r.top+10});pointer(f,'pointermove',{x:310,y:110});pointer(f,'pointerup');
    f.root.querySelector('.collapse').dispatchEvent(new f.w.MouseEvent('dblclick',{bubbles:true}));assert.equal(f.panel.style.left,'300px');
    f.head.dispatchEvent(new f.w.MouseEvent('dblclick',{bubbles:true}));assert.equal(docked(f.panel),true);
    viewport(f,900,900);viewport(f,1440,900);assert.equal(docked(f.panel),true);
  }finally{f.close();}
});

test('ResizeObserver가 반복 호출돼도 배치 좌표가 바뀌지 않는다',async()=>{
  let resized;
  const f=dragFixture(w=>{w.ResizeObserver=class{constructor(callback){resized=callback;}observe(){}disconnect(){}};});
  try{
    await f.ready();for(let i=0;i<5;i++)resized();assert.equal(docked(f.panel),true);
    viewport(f,1440,900);const r=f.panel.getBoundingClientRect();pointer(f,'pointerdown',{x:r.left+10,y:r.top+10});pointer(f,'pointermove',{x:510,y:210});pointer(f,'pointerup');
    for(let i=0;i<5;i++)resized();assert.equal(f.panel.style.left,'500px');assert.equal(f.panel.style.top,'200px');
  }finally{f.close();}
});
