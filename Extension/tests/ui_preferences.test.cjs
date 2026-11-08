const {test}=require('node:test'),assert=require('node:assert/strict');
const {worker,ui,profileKey,profile,key,settle}=require('./conversation_fixture.cjs');
const uiKey='gyeote.uiPreferences';
const base={width:400,height:720,backgroundOpacity:100,dock:'right',left:null,top:null};
const stored=(revision,values={})=>({schemaVersion:1,revision,...base,...values});
const get=f=>f.send({type:'gyeote:ui-preferences-get'});
const set=(f,expectedRevision,preferences,from)=>f.send({type:'gyeote:ui-preferences-set',expectedRevision,preferences},from);
const sets=f=>f.calls.set.filter(value=>uiKey in value);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('저장값이 없으면 기본값 revision0을 돌려주고 검증된 설정만 별도 키에 저장한다',async()=>{
  const f=worker();
  assert.deepEqual(await get(f),{ok:true,state:stored(0)});
  const result=await set(f,0,{...base,width:480,height:600,backgroundOpacity:90});
  assert.deepEqual(result,{ok:true,state:stored(1,{width:480,height:600,backgroundOpacity:90})});
  assert.deepEqual(f.data[uiKey],stored(1,{width:480,height:600,backgroundOpacity:90}));
  assert.deepEqual(f.data[profileKey],profile);assert.equal(f.data[key],undefined);
  assert.deepEqual(Object.keys(sets(f)[0]),[uiKey]);
});

test('경계값은 허용하고 범위 밖·추가·누락 필드와 잘못된 위치 조합은 저장하지 않는다',async()=>{
  const f=worker();let revision=0;
  for(const ok of [{width:320},{width:640},{height:360},{height:900},{backgroundOpacity:10},{backgroundOpacity:11},{backgroundOpacity:85},{backgroundOpacity:87},{backgroundOpacity:100},{dock:'free',left:0,top:0},{dock:'free',left:10000,top:10000}]){
    const result=await set(f,revision,{...base,...ok});assert.equal(result.ok,true,JSON.stringify(ok));revision=result.state.revision;
  }
  const before=sets(f).length;
  for(const bad of [{width:319},{width:16385},{width:400.5},{height:359},{height:16385},{backgroundOpacity:9},{backgroundOpacity:101},{backgroundOpacity:10.5},{dock:'right',left:10,top:10},{dock:'free',left:null,top:null},{dock:'free',left:-1,top:0},{dock:'left'},{extra:1}]){
    assert.equal((await set(f,revision,{...base,...bad})).error,'invalid_ui_preferences',JSON.stringify(bad));
  }
  const {top,...missing}=base;assert.equal((await set(f,revision,missing)).error,'invalid_ui_preferences');
  assert.equal((await f.send({type:'gyeote:ui-preferences-set',expectedRevision:revision,preferences:base,key:profileKey})).error,'invalid_ui_preferences');
  assert.equal((await f.send({type:'gyeote:ui-preferences-get',key:profileKey})).error,'invalid_ui_preferences');
  assert.equal(sets(f).length,before);
});

test('공식 최상위 동일 탭 외 sender는 화면 설정 저장소를 열지 않는다',async()=>{
  const f=worker();
  for(const change of [{id:'other'},{frameId:1},{url:'https://example.invalid/'},{tab:{id:1,url:'https://www.bokjiro.go.kr/changed'}},{tab:{id:-1,url:'https://www.bokjiro.go.kr/'}}]){
    assert.equal(await f.send({type:'gyeote:ui-preferences-set',expectedRevision:0,preferences:base},{...f.sender(1),...change}),undefined);
  }
  assert.equal(f.calls.get.filter(name=>name===uiKey).length,0);assert.equal(sets(f).length,0);
});

test('오래된 revision은 충돌로 거절하고 저장 실패는 기존 값을 바꾸지 않는다',async()=>{
  const f=worker({[profileKey]:profile,[uiKey]:stored(3,{width:500})});
  assert.equal((await set(f,2,{...base,width:600})).error,'ui_preferences_conflict');
  f.failure.set=true;assert.equal((await set(f,3,{...base,width:600})).error,'ui_preferences_storage_failed');
  assert.deepEqual(f.data[uiKey],stored(3,{width:500}));
});

test('손상된 설정은 기본값과 invalid 표시만 돌려주고 사용자 기본값 복원 전에는 원본을 덮지 않는다',async()=>{
  const broken={schemaVersion:1,revision:5,width:16385,height:720,backgroundOpacity:100,dock:'right',left:null,top:null};
  const f=worker({[profileKey]:profile,[uiKey]:broken});
  assert.deepEqual(await get(f),{ok:true,state:stored(5),invalid:true});
  assert.equal((await set(f,5,base)).error,'ui_preferences_invalid');assert.deepEqual(f.data[uiKey],broken);
  assert.equal((await f.send({type:'gyeote:ui-preferences-reset',expectedRevision:4})).error,'ui_preferences_conflict');
  assert.deepEqual(await f.send({type:'gyeote:ui-preferences-reset',expectedRevision:5}),{ok:true,state:stored(6)});
  assert.deepEqual(f.data[uiKey],stored(6));
});

test('변경 통지는 설정값 없이 revision만 각 탭에 보낸다',async()=>{
  const f=worker(),seen=[];f.clients.set(7,message=>seen.push(message));
  await set(f,0,{...base,backgroundOpacity:95});await settle();
  assert.deepEqual(seen,[{type:'gyeote:ui-preferences-changed',revision:1}]);
});

test('큰 화면 크기와 예전 저장값은 같은 형식으로 허용하고 안전 상한은 유지한다',async()=>{
  const f=worker();let revision=0;
  for(const dimensions of [[400,720],[640,900],[1912,1072],[2552,1432],[16384,16384]]){
    const response=await set(f,revision,{...base,width:dimensions[0],height:dimensions[1]});assert.equal(response.ok,true);revision=response.state.revision;
  }
  assert.equal((await set(f,revision,{...base,width:16385})).error,'invalid_ui_preferences');
});

function panelFixture(data,failure={}){
  const server=worker({[profileKey]:profile,...data},failure),f=ui(server),handle=f.root.querySelector('.resize-handle'),panel=f.root.querySelector('.panel');
  handle.setPointerCapture=()=>{};handle.hasPointerCapture=()=>true;handle.releasePointerCapture=()=>{};
  const pointer=(type,x,y,target=handle)=>{const event=new f.w.Event(type,{bubbles:true});Object.assign(event,{pointerId:1,clientX:x,clientY:y,button:0,isPrimary:true});target.dispatchEvent(event);};
  const uiRequests=()=>f.requests.filter(message=>message.type==='gyeote:ui-preferences-set');
  return {...f,server,handle,panel,pointer,uiRequests};
}
const size=panel=>[panel.style.getPropertyValue('--gyeote-width'),panel.style.getPropertyValue('--gyeote-height'),panel.style.opacity];

test('손잡이는1920화면을 거의 덮고 창을 줄였다 넓혀도 저장 선호크기를 보존한다',async()=>{
  const f=panelFixture();try{
    f.w.innerWidth=1920;f.w.innerHeight=1080;await f.ready();
    f.pointer('pointerdown',200,200);f.pointer('pointermove',-5000,-5000);assert.equal(f.uiRequests().length,0);
    assert.deepEqual(size(f.panel).slice(0,2),['1912px','1072px']);f.pointer('pointerup',-5000,-5000);await settle();
    assert.deepEqual(f.server.data[uiKey],stored(1,{width:1912,height:1072}));
    f.w.innerWidth=320;f.w.innerHeight=568;f.w.dispatchEvent(new f.w.Event('resize'));
    f.w.innerWidth=1920;f.w.innerHeight=1080;f.w.dispatchEvent(new f.w.Event('resize'));await settle();
    assert.deepEqual(size(f.panel).slice(0,2),['1912px','1072px']);assert.equal(f.uiRequests().length,1);
  }finally{f.close();}
});

test('스크롤바가 차지한 폭은 최대 크기와 자유 위치 계산에서 제외한다',async()=>{
  const f=panelFixture();try{
    f.w.innerWidth=1920;f.w.innerHeight=1080;Object.defineProperty(f.w.document.documentElement,'clientWidth',{value:1905});await f.ready();
    f.pointer('pointerdown',200,200);f.pointer('pointermove',-5000,-5000);f.pointer('pointerup',-5000,-5000);await settle();assert.equal(size(f.panel)[0],'1897px');assert.equal(f.server.data[uiKey].width,1897);
    const head=f.root.querySelector('.head');head.setPointerCapture=()=>{};head.hasPointerCapture=()=>true;head.releasePointerCapture=()=>{};f.panel.getBoundingClientRect=()=>({width:1897,height:1072,left:4,top:4});
    f.pointer('pointerdown',10,10,head);f.pointer('pointermove',5000,10,head);f.pointer('pointerup',5000,10,head);await settle();assert.equal(f.panel.style.left,'4px');
  }finally{f.close();}
});

test('헤더 슬라이더는 입력 중 즉시 반영하고 포인터 종료 때만 한 번 저장한다',async()=>{
  const f=panelFixture();try{
    await f.ready();const slider=f.root.querySelector('.head input[type=range]');assert.ok(slider);assert.equal(slider.getAttribute('aria-label'),'플로팅 UI 불투명도');
    assert.equal(slider.min,'10');assert.equal(slider.max,'100');assert.equal(slider.step,'1');
    assert.equal(f.root.querySelectorAll('.ui-opacity').length,1);assert.equal(f.root.querySelector('.profile-slot .ui-opacity'),null);
    assert.equal(slider.nextElementSibling,f.root.querySelector('.mode-switch'));
    f.pointer('pointerdown',20,20,slider);
    for(const value of ['99','87','11','10']){slider.value=value;slider.dispatchEvent(new f.w.Event('input',{bubbles:true}));}
    assert.equal(size(f.panel)[2],'0.1');assert.equal(f.uiRequests().length,0);
    f.pointer('pointerup',20,20,slider);slider.dispatchEvent(new f.w.Event('change'));await settle();
    assert.equal(f.uiRequests().length,1);assert.equal(f.server.data[uiKey].backgroundOpacity,10);
    slider.value='100';slider.dispatchEvent(new f.w.Event('input'));slider.dispatchEvent(new f.w.Event('change'));await settle();assert.equal(size(f.panel)[2],'1');
  }finally{f.close();}
});

test('슬라이더 방향키의 연속 변경은 한 번 저장하며 초기 읽기와 저장 실패가 현재 값을 되돌리지 않는다',async()=>{
  let release,held=false;const pending=new Promise(resolve=>{release=resolve;});
  const f=panelFixture(undefined,{beforeGet:async name=>{if(name===uiKey&&!held){held=true;await pending;}}});try{
    await f.ready();const slider=f.root.querySelector('.ui-opacity');
    slider.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));
    for(const value of ['95','90','85']){slider.value=value;slider.dispatchEvent(new f.w.Event('input'));slider.dispatchEvent(new f.w.Event('change'));}
    release();await settle();assert.equal(size(f.panel)[2],'0.85');assert.equal(f.uiRequests().length,0);
    f.server.failure.set=true;await wait(450);await settle();assert.equal(f.uiRequests().length,1);assert.equal(size(f.panel)[2],'0.85');assert.match(f.root.querySelector('.status').textContent,/저장하지 못/);
  }finally{release();f.close();}
});

test('슬라이더 조절 중 초기 읽기가 끝나고 저장이 지연돼도 pointerup 다음 change가 옛 값을 적용하지 않는다',async()=>{
  let releaseRead,releaseWrite,held=false;const read=new Promise(resolve=>{releaseRead=resolve;}),write=new Promise(resolve=>{releaseWrite=resolve;});
  const f=panelFixture(undefined,{beforeGet:async name=>{if(name===uiKey&&!held){held=true;await read;}},beforeSet:async value=>{if(uiKey in value)await write;}});try{
    await f.ready();const slider=f.root.querySelector('.ui-opacity');f.pointer('pointerdown',10,10,slider);slider.value='85';slider.dispatchEvent(new f.w.Event('input'));releaseRead();await settle();
    f.pointer('pointerup',10,10,slider);slider.dispatchEvent(new f.w.Event('change'));await settle();assert.equal(size(f.panel)[2],'0.85');assert.equal(f.uiRequests().length,1);
    releaseWrite();await settle();assert.equal(size(f.panel)[2],'0.85');assert.equal(f.server.data[uiKey].backgroundOpacity,85);
  }finally{releaseRead();releaseWrite();f.close();}
});

for(const endBeforeRead of [false,true])test(`초기 설정 읽기가 조절 ${endBeforeRead?'종료 후':'중'} 끝나도 조절값을 저장한다`,async()=>{
  let release,entered=false;
  const pending=new Promise(resolve=>{release=resolve;});
  const f=panelFixture(undefined,{beforeGet:async name=>{if(name===uiKey&&!entered){entered=true;await pending;}}});
  try{
    await f.ready();assert.equal(entered,true);
    f.pointer('pointerdown',100,100);f.pointer('pointermove',20,100);
    assert.equal(size(f.panel)[0],'480px');
    if(endBeforeRead)f.pointer('pointerup',20,100);
    release();await settle();assert.equal(size(f.panel)[0],'480px');
    if(!endBeforeRead)f.pointer('pointerup',20,100);
    await settle();assert.deepEqual(f.server.data[uiKey],stored(1,{width:480}));
  }finally{release();f.close();}
});

test('초기 읽기를 미룬 조절의 저장 실패는 현재 크기를 옛 저장값으로 되돌리지 않는다',async()=>{
  let release,entered=false;
  const pending=new Promise(resolve=>{release=resolve;});
  const f=panelFixture(undefined,{set:true,beforeGet:async name=>{if(name===uiKey&&!entered){entered=true;await pending;}}});
  try{
    await f.ready();f.pointer('pointerdown',100,100);f.pointer('pointermove',20,100);
    release();await settle();f.pointer('pointerup',20,100);await settle();
    assert.equal(f.server.data[uiKey],undefined);assert.equal(size(f.panel)[0],'480px');
    assert.match(f.root.querySelector('.status').textContent,/저장하지 못했어요/);
  }finally{release();f.close();}
});

test('새로고침 뒤 저장된 크기·투명도·직접 옮긴 위치를 복원한다',async()=>{
  const f=panelFixture({[uiKey]:stored(2,{width:480,height:600,backgroundOpacity:90,dock:'free',left:500,top:200})});
  try{
    await f.ready();assert.deepEqual(size(f.panel),['480px','600px','0.9']);
    assert.equal(f.panel.style.left,'500px');assert.equal(f.panel.style.top,'200px');assert.equal(f.root.querySelector('.ui-opacity').value,'90');
    for(const node of f.root.querySelectorAll('.modal-dialog,.open'))assert.equal(node.style.opacity,'0.9');
  }finally{f.close();}
});

test('저장보다 늦게 도착한 옛 설정 읽기는 최신 revision과 화면을 되돌리지 않는다',async()=>{
  const f=panelFixture();let release;
  const pending=new Promise(resolve=>{release=resolve;});
  try{
    await f.ready();const send=f.w.chrome.runtime.sendMessage;let held=false;
    f.w.chrome.runtime.sendMessage=async message=>{
      const result=await send(message);
      if(message.type==='gyeote:ui-preferences-get'&&!held){held=true;await pending;}
      return result;
    };
    f.notify({type:'gyeote:ui-preferences-changed',revision:1});await settle();
    f.pointer('pointerdown',100,100);f.pointer('pointermove',20,100);f.pointer('pointerup',20,100);await settle();
    assert.deepEqual(f.server.data[uiKey],stored(1,{width:480}));
    release();await settle();assert.equal(size(f.panel)[0],'480px');
    f.pointer('pointerdown',100,100);f.pointer('pointermove',80,100);f.pointer('pointerup',80,100);await settle();
    assert.deepEqual(f.server.data[uiKey],stored(2,{width:500}));
  }finally{release();f.close();}
});

test('이전 저장이 늦어도 다음 조절을 덮지 않고 마지막 조절값을 순서대로 저장한다',async()=>{
  let release,held=false;
  const pending=new Promise(resolve=>{release=resolve;});
  const f=panelFixture(undefined,{beforeSet:async value=>{if(uiKey in value&&!held){held=true;await pending;}}});
  try{
    await f.ready();f.pointer('pointerdown',100,100);f.pointer('pointermove',20,100);f.pointer('pointerup',20,100);await settle();
    f.pointer('pointerdown',100,100);f.pointer('pointermove',60,100);assert.equal(size(f.panel)[0],'520px');
    release();await settle();assert.equal(size(f.panel)[0],'520px');
    f.pointer('pointerup',60,100);await settle();assert.deepEqual(f.server.data[uiKey],stored(2,{width:520}));
  }finally{release();f.close();}
});

test('손잡이 끌기는 조절 중에는 저장하지 않고 놓을 때 한 번 저장한다',async()=>{
  const f=panelFixture();
  try{
    await f.ready();f.pointer('pointerdown',100,100);f.pointer('pointermove',70,80);f.pointer('pointermove',40,60);
    assert.deepEqual(size(f.panel).slice(0,2),['460px','760px']);assert.equal(f.uiRequests().length,0);
    f.pointer('pointerup',40,60);await settle();
    assert.equal(f.uiRequests().length,1);assert.deepEqual(f.server.data[uiKey],stored(1,{width:460,height:760}));
    f.pointer('pointerdown',100,100);f.pointer('pointermove',-900,-900);f.pointer('pointerup',-900,-900);await settle();
    assert.deepEqual(f.server.data[uiKey],stored(2,{width:1016,height:760}));
  }finally{f.close();}
});

test('손잡이 방향키는 20px씩 바꾸고 최소값 아래로 줄이지 않으며 입력이 끝난 뒤 저장한다',async()=>{
  const f=panelFixture();
  try{
    await f.ready();const key=name=>f.handle.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:name,bubbles:true,cancelable:true}));
    key('ArrowLeft');key('ArrowLeft');key('ArrowUp');assert.deepEqual(size(f.panel).slice(0,2),['440px','740px']);assert.equal(f.uiRequests().length,0);
    await wait(450);await settle();assert.equal(f.uiRequests().length,1);assert.deepEqual(f.server.data[uiKey],stored(1,{width:440,height:740}));
    for(let i=0;i<10;i++)key('ArrowRight');assert.equal(size(f.panel)[0],'320px');
  }finally{f.close();}
});

test('전체 창 불투명도는 말풍선·입력·버튼·별도 모달에 한 번만 합성하고 사이트·배경막은 유지한다',async()=>{
  const f=panelFixture();
  try{
    await f.ready();await f.question('합성 질문');await f.answer({kind:'answer',text:'합성 답변',evidence:[]});
    const select=f.root.querySelector('.ui-opacity'),roots=[f.panel,f.root.querySelector('.profile-slot'),f.root.querySelector('.panel-tools'),f.root.querySelector('.open')];
    const effective=node=>{let alpha=1;for(let parent=node;parent;parent=parent.parentElement)alpha*=Number(parent.style.opacity||f.w.getComputedStyle(parent).opacity);return alpha;};
    const content=[...f.root.querySelectorAll('.head button,.compose-row input,.compose-row button,.conversation article,.conversation article small,.profile-usage-toggle,.status')].map(node=>({node,original:Number(f.w.getComputedStyle(node).opacity)}));assert.ok(content.length>=15);
    for(const value of [10,11,85,100]){
      select.value=String(value);select.dispatchEvent(new f.w.Event('change'));await settle();
      for(const root of roots)assert.equal(effective(root),value/100,root.className+":"+root.getAttribute("style"));
      for(const {node,original} of content){assert.equal(Number(f.w.getComputedStyle(node).opacity),original);assert.equal(effective(node),original*(value/100));}
      for(const selector of ['.modal-layer','.badges'])assert.equal(effective(f.root.querySelector(selector)),1);
      assert.equal(f.w.getComputedStyle(f.root.host).opacity,'1');assert.equal(f.w.getComputedStyle(f.w.document.body).opacity,'1');assert.equal(f.server.data[uiKey].backgroundOpacity,value);
      f.root.querySelector('.profile-toggle').click();if(!f.root.querySelector('.profile-slot input'))await f.click('내 정보 수정');assert.equal(effective(f.root.querySelector('.profile-slot input')),value/100);assert.equal(f.w.document.body.inert,true);f.root.querySelector('.profile-dismiss').click();assert.equal(f.w.document.body.hasAttribute('inert'),false);
    }
    const css=[...f.root.querySelectorAll('style')].map(node=>node.textContent).join('');
    assert.doesNotMatch(css,/--gyeote-background/);assert.match(css,/\.body\{background:#fff\}/);
  }finally{f.close();}
});

test('다른 탭이 먼저 저장했으면 최신 설정을 적용하고 다시 조절하도록 안내한다',async()=>{
  const f=panelFixture();
  try{
    await f.ready();f.server.data[uiKey]=stored(4,{width:600});
    const select=f.root.querySelector('.ui-opacity');select.value='90';select.dispatchEvent(new f.w.Event('change'));await settle();
    assert.equal(size(f.panel)[0],'600px');assert.equal(size(f.panel)[2],'1');assert.deepEqual(f.server.data[uiKey],stored(4,{width:600}));
    assert.match(f.root.querySelector('.status').textContent,/다른 탭에서 화면 설정이 바뀌어/);
  }finally{f.close();}
});

test('저장에 실패해도 지금 화면의 조절은 유지하고 저장 성공으로 알리지 않는다',async()=>{
  const f=panelFixture();
  try{
    await f.ready();f.server.failure.set=true;
    const select=f.root.querySelector('.ui-opacity');select.value='95';select.dispatchEvent(new f.w.Event('change'));await settle();
    assert.equal(size(f.panel)[2],'0.95');assert.equal(f.server.data[uiKey],undefined);
    for(const node of f.root.querySelectorAll('.modal-dialog,.open'))assert.equal(node.style.opacity,'0.95');
    assert.match(f.root.querySelector('.status').textContent,/저장하지 못했어요/);
  }finally{f.close();}
});

test('화면 설정 변경 통지는 진행 중 상담을 취소하지 않고 같은 revision은 다시 읽지 않는다',async()=>{
  const f=panelFixture();
  try{
    await f.ready();await f.question('합성 질문');const port=f.ports.at(-1);
    const reads=()=>f.requests.filter(message=>message.type==='gyeote:ui-preferences-get').length,before=reads();
    f.notify({type:'gyeote:ui-preferences-changed',revision:0});await settle();assert.equal(reads(),before);
    f.server.data[uiKey]=stored(1,{width:520});f.notify({type:'gyeote:ui-preferences-changed',revision:1});await settle();
    assert.equal(reads(),before+1);assert.equal(size(f.panel)[0],'520px');assert.equal(port.disconnected,undefined);
  }finally{f.close();}
});

test('손상된 설정은 기본 표시와 안내를 보여 주고 기본값 버튼으로만 정리한다',async()=>{
  const f=panelFixture({[uiKey]:{schemaVersion:1,revision:2,width:'wide'}});
  try{
    await f.ready();assert.deepEqual(size(f.panel),['400px','720px','1']);
    assert.match(f.root.querySelector('.ui-status').textContent,/읽지 못해 기본값/);
    const select=f.root.querySelector('.ui-opacity');select.value='90';select.dispatchEvent(new f.w.Event('change'));await settle();
    assert.deepEqual(f.server.data[uiKey],{schemaVersion:1,revision:2,width:'wide'});
    f.root.querySelector('.ui-reset').click();await settle();
    assert.deepEqual(f.server.data[uiKey],stored(3));assert.equal(f.root.querySelector('.ui-status').textContent,'');assert.deepEqual(size(f.panel),['400px','720px','1']);
    for(const node of f.root.querySelectorAll('.modal-dialog,.open'))assert.equal(node.style.opacity,'1');
  }finally{f.close();}
});

test('패널을 옮기면 놓을 때 위치를 저장하고 제목줄 두 번 누르기는 기본 위치를 저장한다',async()=>{
  const f=panelFixture();
  try{
    await f.ready();const head=f.root.querySelector('.head');head.setPointerCapture=()=>{};head.hasPointerCapture=()=>true;head.releasePointerCapture=()=>{};
    f.pointer('pointerdown',60,70,head);f.pointer('pointermove',320,270,head);assert.equal(f.uiRequests().length,0);f.pointer('pointerup',320,270,head);await settle();
    assert.deepEqual(f.server.data[uiKey],stored(1,{dock:'free',left:300,top:260}));
    head.dispatchEvent(new f.w.MouseEvent('dblclick',{bubbles:true}));await settle();
    assert.deepEqual(f.server.data[uiKey],stored(2));
  }finally{f.close();}
});

test('조절 중 도착한 변경 통지는 방향키 조절을 되돌리지 않고 저장이 끝난 뒤에 다시 읽는다',async()=>{
  const f=panelFixture();
  try{
    await f.ready();const key=name=>f.handle.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:name,bubbles:true,cancelable:true}));
    key('ArrowLeft');f.notify({type:'gyeote:ui-preferences-changed',revision:5});await settle();
    assert.equal(size(f.panel)[0],'420px');
    await wait(450);await settle();
    assert.deepEqual(f.server.data[uiKey],stored(1,{width:420}));assert.equal(size(f.panel)[0],'420px');
    f.server.clients.clear();f.pointer('pointerdown',100,100);f.pointer('pointermove',60,100);f.notify({type:'gyeote:ui-preferences-changed',revision:9});await settle();
    f.pointer('pointerup',60,100);await settle();
    assert.deepEqual(f.server.data[uiKey],stored(2,{width:460}));assert.equal(size(f.panel)[0],'460px');
  }finally{f.close();}
});
