const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('../../FrontEnd/node_modules/jsdom');
const source=fs.readFileSync(path.join(__dirname,'../dom.js'),'utf8');
function fixture(html){
  const dom=new JSDOM(html,{url:'https://www.bokjiro.go.kr/ssis-tbu/index.do',runScripts:'outside-only',pretendToBeVisual:true});
  const {window:w}=dom;
  w.Element.prototype.getBoundingClientRect=()=>({x:40,y:60,left:40,top:60,right:180,bottom:100,width:140,height:40});
  const computed=w.getComputedStyle.bind(w);
  w.getComputedStyle=node=>{const style=computed(node);return {display:style.display,visibility:style.visibility||'visible',opacity:style.opacity||'1',position:style.position||'static'};};
  w.eval(source);
  w.eval(fs.readFileSync(path.join(__dirname,'../protocol.js'),'utf8'));
  w.eval(fs.readFileSync(path.join(__dirname,'../capture.js'),'utf8'));
  return {w,api:w.GyeoteDOM,close:()=>{w.dispatchEvent(new w.Event('pagehide'));w.close();}};
}
test('원본 DOM의 숨겨진 CSS 자식·입력값·민감 영역은 공개 문구에 포함하지 않음',()=>{
  const f=fixture('<main><p id="copy">공개 설명 <span style="display:none">숨겨진 비밀</span><span style="visibility:hidden">가린 내용</span><span style="opacity:0">인증 123456</span><input value="개인 입력값"><span data-private>사용자 정보</span></p></main>');
  try{assert.equal(f.api.textOf(f.w.document.querySelector('#copy')),'공개 설명');}finally{f.close();}
});
test('열린 Shadow DOM의 비밀번호 입력도 수집 전에 동일하게 차단',()=>{
  const f=fixture('<main><div id="custom"></div></main>');
  try{const root=f.w.document.querySelector('#custom').attachShadow({mode:'open'});root.innerHTML='<input type="password" aria-label="비밀번호">';assert.equal(f.api.publicPage(),false);assert.throws(()=>f.api.collect(),/public_screen_required/);}finally{f.close();}
});
test('입력 요소 값 getter를 읽지 않고 표시 라벨과 임시 ID만 수집',()=>{
  const f=fixture('<main><label for="search">서비스 검색</label><input id="search"><button>검색하기</button></main>');
  try{
    const input=f.w.document.querySelector('input'),button=f.w.document.querySelector('button');
    Object.defineProperty(input,'value',{get(){throw new Error('입력값 읽기 금지');}});
    f.w.document.elementFromPoint=()=>button;
    const snapshot=f.api.collect('검색');assert.equal(snapshot.payload.candidates[0].label,'검색하기');assert.match(snapshot.payload.snapshot_id,/^[A-F0-9]{20}$/);assert.equal(snapshot.refs.get(snapshot.payload.candidates[0].id),button);
    assert.doesNotMatch(JSON.stringify(snapshot.payload),/outerHTML|cookie|value|href/);
  }finally{f.close();}
});
test('열린 Shadow DOM 후보는 실제 내부 hit와 공개 이름을 확인',()=>{
  const f=fixture('<main><div id="custom"></div></main>');
  try{
    const host=f.w.document.querySelector('#custom'),root=host.attachShadow({mode:'open'});root.innerHTML='<button>서비스 자세히 보기</button><p>공개 도움말<span style="display:none">비밀 본문</span></p>';
    const button=root.querySelector('button');f.w.document.elementFromPoint=()=>host;root.elementFromPoint=()=>button;
    const snapshot=f.api.collect();assert.equal(snapshot.payload.candidates[0].label,'서비스 자세히 보기');assert.equal(f.api.textOf(root.querySelector('p')),'공개 도움말');
  }finally{f.close();}
});
test('모달 뒤 요소·비활성 대상·가려진 대상은 후보에 포함하지 않음',()=>{
  const f=fixture('<main><button id="back">검색하기</button><div aria-modal="true"><button disabled>확인</button><button id="close">닫기</button></div></main>');
  try{const close=f.w.document.querySelector('#close');f.w.document.elementFromPoint=()=>close;const snapshot=f.api.collect();assert.deepEqual(Array.from(snapshot.payload.candidates,c=>c.label),['닫기']);assert.equal(snapshot.payload.modal_open,true);}finally{f.close();}
});

test('Shadow 대상 root에 테두리 스타일을 넣고 해제하며 사이트 클릭을 대신 수행하지 않음',()=>{
  const f=fixture('<main><div id="custom"></div></main>');
  try{
    const {w}=f,host=w.document.querySelector('#custom'),root=host.attachShadow({mode:'open'});root.innerHTML='<button>서비스 자세히 보기</button>';
    const button=root.querySelector('button');let clicks=0;button.addEventListener('click',()=>clicks++);
    w.document.elementFromPoint=()=>host;root.elementFromPoint=()=>button;
    const attach=w.Element.prototype.attachShadow;let panelRoot;
    w.Element.prototype.attachShadow=function(options){const result=attach.call(this,options);if(this.hasAttribute('data-gyeote-host'))panelRoot=result;return result;};
    w.chrome={runtime:{onMessage:{addListener(){}}}};
    w.eval(fs.readFileSync(path.join(__dirname,'../content.js'),'utf8'));
    panelRoot.querySelector('[data-test="1"]').click();
    assert.match(root.querySelector('style[data-gyeote-style]').textContent,/outline:4px solid/);
    assert.match(button.className,/gyeote-/);assert.equal(clicks,0);
    assert.match(panelRoot.querySelector('.status').textContent,/① 파랑 테두리의 ‘서비스 자세히 보기’/);
    panelRoot.querySelector('.clear').click();assert.equal(root.querySelector('style[data-gyeote-style]'),null);assert.equal(button.className,'');
    button.click();assert.equal(clicks,1);
  }finally{f.close();}
});

test('본문 검사는 상단 메뉴와 fixed·sticky 조상 안의 요소를 제외',()=>{
  const f=fixture('<header><button id="header">상단 메뉴</button></header><div style="position:sticky"><button id="sticky">고정 메뉴</button></div><main><button id="body">서비스 자세히 보기</button><div id="custom" style="position:fixed"></div></main>');
  try{
    const {document}=f.w,button=document.querySelector('#body');document.elementFromPoint=()=>button;
    assert.equal(f.api.bodyTarget(document.querySelector('#header')),false);assert.equal(f.api.bodyTarget(document.querySelector('#sticky')),false);
    const root=document.querySelector('#custom').attachShadow({mode:'open'});root.innerHTML='<button>고정 Shadow 메뉴</button>';
    assert.equal(f.api.bodyTarget(root.querySelector('button')),false);
    assert.deepEqual(Array.from(f.api.collect('',{bodyOnly:true}).payload.candidates,c=>c.label),['서비스 자세히 보기']);
  }finally{f.close();}
});

test('본문 대상이 스크롤로 이동하면 번호가 따라가고 화면 밖에서는 안내와 함께 해제',async()=>{
  const f=fixture('<main><button>서비스 자세히 보기</button></main>');
  try{
    const {w}=f,button=w.document.querySelector('main button');let top=200;
    button.getBoundingClientRect=()=>({x:40,y:top,left:40,top,right:180,bottom:top+40,width:140,height:40});
    w.document.elementFromPoint=()=>button;
    const attach=w.Element.prototype.attachShadow;let panelRoot;
    w.Element.prototype.attachShadow=function(options){const root=attach.call(this,options);if(this.hasAttribute('data-gyeote-host'))panelRoot=root;return root;};
    w.chrome={runtime:{onMessage:{addListener(){}}}};w.eval(fs.readFileSync(path.join(__dirname,'../content.js'),'utf8'));
    panelRoot.querySelector('.body-test').click();const badge=panelRoot.querySelector('.badge');assert.equal(badge.style.top,'170px');
    top=160;w.dispatchEvent(new w.Event('scroll'));await new Promise(resolve=>w.requestAnimationFrame(resolve));
    assert.equal(badge.style.top,'130px');assert.match(button.className,/gyeote-/);
    top=-50;w.dispatchEvent(new w.Event('scroll'));await new Promise(resolve=>w.requestAnimationFrame(resolve));
    assert.equal(panelRoot.querySelector('.badge'),null);assert.equal(button.className,'');assert.doesNotMatch(panelRoot.querySelector('.status').textContent,/파랑 테두리/);
  }finally{f.close();}
});

test('캡처 전 입력란을 가리고 값은 읽지 않으며 불투명 콘텐츠는 거부',()=>{
  const f=fixture('<main><label>검색어<input value="개인 입력값"></label></main>');
  try{
    const input=f.w.document.querySelector('input');Object.defineProperty(input,'value',{get(){throw Error('값 읽기 금지');}});
    let maskRoot;const attach=f.w.Element.prototype.attachShadow;
    f.w.Element.prototype.attachShadow=function(options){const root=attach.call(this,options);if(this.hasAttribute('data-gyeote-mask'))maskRoot=root;return root;};
    const plan=f.w.GyeoteCapture.plan();assert.equal(plan.masks.length,1);plan.mount();assert.equal(maskRoot.firstElementChild.style.background,'rgb(0, 0, 0)');plan.remove();assert.equal(f.w.document.querySelector('[data-gyeote-mask]'),null);
    const frame=f.w.document.createElement('iframe');f.w.document.querySelector('main').append(frame);assert.throws(()=>f.w.GyeoteCapture.plan(),/capture_not_safe/);
  }finally{f.close();}
});

test('질문 응답의 실제 ID 세 개와 색상·번호·요소명을 함께 적용하고 오류 때 현행 지시를 지움',async()=>{
  const f=fixture('<main><button>통합 검색</button><button>복지서비스 찾기</button><button>도움말</button></main>');
  try{
    const {w}=f,buttons=[...w.document.querySelectorAll('main button')];
    buttons.forEach((button,i)=>button.getBoundingClientRect=()=>({left:40,right:180,top:140+i*80,bottom:180+i*80,width:140,height:40}));
    w.document.elementFromPoint=(_x,y)=>buttons.find(b=>y>=b.getBoundingClientRect().top&&y<=b.getBoundingClientRect().bottom);
    const attach=w.Element.prototype.attachShadow;let panelRoot,receiver,packet,calls=0;
    w.Element.prototype.attachShadow=function(options){const root=attach.call(this,options);if(this.hasAttribute('data-gyeote-host'))panelRoot=root;return root;};
    w.chrome={runtime:{onMessage:{addListener(){}},sendMessage:async()=>({ok:true,imageEnabled:false}),connect:()=>({onMessage:{addListener(fn){receiver=fn;}},onDisconnect:{addListener(){}},postMessage(data){packet=data;calls++;},disconnect(){}})}};
    w.eval(fs.readFileSync(path.join(__dirname,'../content.js'),'utf8'));
    const send=async question=>{panelRoot.querySelector('input[type=text]').value=question;panelRoot.querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));await new Promise(setImmediate);};
    await send('검색과 복지서비스와 도움말 메뉴를 알려줘');
    const reply={snapshot_id:packet.payload.snapshot_id,kind:'설명',answer:'각 메뉴에서 관련 기능을 확인할 수 있어요.',targets:packet.payload.candidates.map(c=>({target_id:c.id,meaning:c.label}))};
    receiver({type:'result',requestId:packet.requestId,body:{reply}});
    assert.equal(panelRoot.querySelectorAll('.badge').length,3);assert.match(panelRoot.querySelector('.status').textContent,/① 파랑.*② 주황.*③ 보라/s);
    await send('검색은 어디서 해?');receiver({type:'error',requestId:packet.requestId,error:'connection_failed'});
    assert.equal(panelRoot.querySelectorAll('.badge').length,0);assert.doesNotMatch(panelRoot.querySelector('.status').textContent,/테두리/);assert.equal(calls,2);
    assert.doesNotMatch(panelRoot.querySelector('.conversation article:nth-child(2)').textContent,/①|②|③/);
  }finally{f.close();}
});

test('로컬 캡처 검사는 패널을 제외하고 스크롤이 바뀌면 서버 전송 없이 보류',async()=>{
  const f=fixture('<main><button>공개 메뉴</button><input aria-label="서비스 검색"></main>');
  try{
    const {w}=f,button=w.document.querySelector('main button');w.document.elementFromPoint=()=>button;
    const attach=w.Element.prototype.attachShadow;let panelRoot,calls=0;
    w.Element.prototype.attachShadow=function(options){const root=attach.call(this,options);if(this.hasAttribute('data-gyeote-host'))panelRoot=root;return root;};
    w.chrome={runtime:{onMessage:{addListener(){}},sendMessage:async packet=>{assert.equal(packet.type,'gyeote:capture');calls++;assert.equal(w.document.querySelector('[data-gyeote-host]').style.visibility,'hidden');assert.ok(w.document.querySelector('[data-gyeote-mask]'));w.scrollY=10;return {ok:true,image:'iVBORw0KGgo='};}}};
    w.eval(fs.readFileSync(path.join(__dirname,'../content.js'),'utf8'));
    [...panelRoot.querySelectorAll('button')].find(b=>b.textContent==='이미지 범위 검사 · 전송 없음').click();
    await new Promise(resolve=>w.setTimeout(resolve,80));assert.equal(calls,1);assert.match(panelRoot.querySelector('.status').textContent,/보류/);assert.equal(w.document.querySelector('[data-gyeote-mask]'),null);assert.equal(w.document.querySelector('[data-gyeote-host]').style.visibility,'');
  }finally{f.close();}
});
