(() => {
  if(window.top!==window||!GyeoteDOM.official()||document.querySelector('[data-gyeote-host]'))return;
  const host=document.createElement('div');host.dataset.gyeoteHost='';
  host.style.cssText='position:fixed;inset:0;z-index:2147483647;pointer-events:none;contain:layout style;';
  const shadow=host.attachShadow({mode:'closed'});
  shadow.innerHTML=`<style>
    :host{all:initial;font-family:"Malgun Gothic",sans-serif;color:#171717}*{box-sizing:border-box}button,input{font:inherit}button{cursor:pointer;min-height:36px;padding:7px 11px;border:1px solid #ccc;border-radius:9px;background:#fff;color:#171717}button:focus-visible,input:focus-visible{outline:3px solid #155bd7;outline-offset:2px}.panel{position:fixed;right:20px;bottom:24px;width:360px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow:auto;pointer-events:auto;background:#fff;border:1px solid #bbb;border-radius:16px;box-shadow:0 8px 30px #0003;padding:16px;font-size:14px;line-height:1.6}.head{display:flex;align-items:center;gap:7px;cursor:move;touch-action:none;user-select:none}.head strong{font-size:21px;flex:1}.head button{font-size:16px}.muted{font-size:12px;color:#666}.status{background:#f0f3f8;padding:12px;border-radius:12px;white-space:pre-wrap}.reply{white-space:pre-wrap}.row{display:flex;gap:6px;flex-wrap:wrap}.body[hidden],.panel[hidden],.open[hidden]{display:none}.open{position:fixed;right:20px;bottom:20px;pointer-events:auto;background:#171717;color:#fff;border-radius:30px}.badge{position:fixed;pointer-events:none;color:#fff;border:2px solid #fff;border-radius:8px;padding:3px 7px;font-size:13px;font-weight:bold;box-shadow:0 2px 8px #0004;max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}details{margin-top:14px}summary{cursor:pointer}
  </style><section class="panel" aria-label="곁에 화면 상담"><header class="head"><strong>곁에</strong><button class="collapse" aria-label="패널 접기">−</button><button class="close" aria-label="패널 닫기">×</button></header><div class="body"><p class="muted">현재 공개 복지로 화면을 함께 봅니다. 클릭은 직접 해 주세요.</p><p class="status" role="status" aria-live="polite">공개 화면에서 궁금한 내용을 질문하세요.</p><div class="conversation" role="log"></div><div class="consultation"></div><details><summary>개발용 표시 검사</summary><p class="muted">모델을 사용하지 않는 테두리 검사입니다.</p><div class="row"><button data-test="1">실제 요소 1개 표시</button><button data-test="3">실제 요소 3개 표시</button><button class="clear">표시 지우기</button></div></details><p class="muted">다른 사이트·로그인·개인정보 화면은 지원하지 않습니다.</p></div></section><button class="open" hidden>곁에 열기</button><div class="badges"></div>`;
  document.documentElement.append(host);
  const $=query=>shadow.querySelector(query),panel=$('.panel'),status=$('.status'),badges=$('.badges');
  const palette=[{name:'파랑',number:'①',color:'#175cde'},{name:'주황',number:'②',color:'#a74b00'},{name:'보라',number:'③',color:'#743abb'}];
  const suffix=GyeoteDOM.id().toLowerCase(),classes=palette.map((_,i)=>`gyeote-${suffix}-${i}`),style=document.createElement('style');
  // 키보드 포커스도 같은 색을 유지하되 이중 테두리로 별도 구분한다.
  style.dataset.gyeoteStyle='';style.textContent=palette.map((p,i)=>`.${classes[i]}{outline:4px solid ${p.color}!important;outline-offset:4px!important}.${classes[i]}:focus-visible{outline-style:double!important;outline-width:6px!important}`).join('\n');document.documentElement.append(style);
  let selected=[],snapshot=null,serial=0,frame=0,collapsed=false,ownMutation=false,observer,requestPort=null,busy=false,activeReply=null,history=[],historyUrl='',pageVersion=0,capturing=false,requestTimer;
  const rootStyles=new Map([[document,style]]);
  function setStatus(text){status.textContent=text;}
  function clear(message){
    ownMutation=true;for(const {node,index} of selected)node.classList.remove(classes[index]);selected=[];badges.replaceChildren();ownMutation=false;
    for(const [root,sheet] of rootStyles)if(root!==document){sheet.remove();rootStyles.delete(root);}
    if(activeReply){activeReply.label.textContent='곁에 · 이전 답변';activeReply.text.textContent=activeReply.answer;activeReply=null;}
    if(message)setStatus(message);
  }
  function cancel(message){serial++;clearTimeout(requestTimer);requestPort?.disconnect();requestPort=null;busy=false;questionForm.querySelector('button[type="submit"]').disabled=false;cancelButton.hidden=true;clear(message);}
  function position(){
    frame=0;
    if(!selected.length)return;
    if(selected.some(item=>!GyeoteDOM.usable(item.node))){clear('대상이 가려지거나 화면 밖으로 이동해 표시를 지웠습니다. 현재 화면으로 다시 질문하세요.');return;}
    for(const {node,badge} of selected){const r=node.getBoundingClientRect();badge.style.left=Math.max(4,Math.min(innerWidth-badge.offsetWidth-4,r.left))+'px';badge.style.top=Math.max(4,r.top-30)+'px';}
  }
  function schedule(){if(!frame)frame=requestAnimationFrame(position);}
  function apply(next,targets,explanation){
    clear();
    if(snapshot!==next||!GyeoteDOM.current(next))throw new Error('stale_snapshot');
    if(!Array.isArray(targets)||targets.length>3||new Set(targets.map(t=>t.target_id)).size!==targets.length)throw new Error('invalid_targets');
    const checked=targets.map((item,index)=>{
      const node=next.refs.get(item.target_id),candidate=next.payload.candidates.find(c=>c.id===item.target_id);
      if(!node||!candidate||!GyeoteDOM.usable(node)||GyeoteDOM.nameOf(node)!==candidate.label)throw new Error('stale_target');
      return {node,index,candidate,meaning:GyeoteDOM.safeText(item.meaning,120)};
    });
    ownMutation=true;
    for(const item of checked){
      const root=item.node.getRootNode();
      if(!rootStyles.has(root)||!rootStyles.get(root).isConnected){
        const sheet=document.createElement('style');sheet.dataset.gyeoteStyle='';sheet.textContent=style.textContent;
        (root===document?document.documentElement:root).append(sheet);rootStyles.set(root,sheet);
        observer?.observe(root,{subtree:true,childList:true,characterData:true,attributes:true,attributeOldValue:true,attributeFilter:['class','style','hidden','disabled','aria-disabled','aria-hidden','aria-modal']});
      }
      const p=palette[item.index],badge=document.createElement('span');badge.className='badge';badge.style.background=p.color;badge.textContent=`${p.number} ${item.candidate.label}`;badges.append(badge);item.node.classList.add(classes[item.index]);selected.push({...item,badge});
    }
    ownMutation=false;position();
    if(checked.length&&!selected.length)return;
    const legends=checked.map(item=>`${palette[item.index].number} ${palette[item.index].name} 테두리의 ‘${item.candidate.label}’${item.meaning?' · '+item.meaning:''}`);
    setStatus([explanation,...legends].join('\n'));
  }
  async function renderingTest(count,bodyOnly=false){
    cancel();
    try{
      snapshot=GyeoteDOM.collect('',{bodyOnly});
      const targets=snapshot.payload.candidates.slice(0,count).map(c=>({target_id:c.id,meaning:'실제 요소 표시 검사'}));
      if(bodyOnly&&!targets.length){setStatus('현재 보이는 본문 대상이 없습니다. 직접 조금 스크롤해 본문 버튼이나 링크를 보이게 한 뒤 다시 눌러 주세요.');return;}
      apply(snapshot,targets,bodyOnly?'본문 요소 표시 검사입니다. 요소가 보이는 범위에서 직접 조금 스크롤해 주세요. 화면 밖으로 나가면 표시를 지웁니다.':'개발용 표시 검사입니다. 모델 답변이 아닙니다.');
    }
    catch{setStatus('공개 화면의 실제 요소를 확인하지 못해 표시하지 않았습니다.');}
  }
  shadow.querySelectorAll('[data-test]').forEach(button=>button.addEventListener('click',()=>renderingTest(Number(button.dataset.test))));
  const bodyTest=document.createElement('button');bodyTest.className='body-test';bodyTest.textContent='본문 요소 표시';bodyTest.addEventListener('click',()=>renderingTest(1,true));$('.clear').before(bodyTest);
  $('.clear').addEventListener('click',()=>cancel('표시를 지웠습니다.'));
  $('.close').addEventListener('click',()=>{cancel();panel.hidden=true;$('.open').hidden=false;});
  $('.open').addEventListener('click',()=>{panel.hidden=false;$('.open').hidden=true;});
  $('.collapse').addEventListener('click',()=>{collapsed=!collapsed;$('.body').hidden=collapsed;$('.collapse').textContent=collapsed?'+':'−';cancel('패널을 접어 표시를 지웠습니다.');});
  const formStyle=document.createElement('style');formStyle.textContent='.consultation form{display:grid;gap:8px;margin:14px 0}.consultation input[type=text]{width:100%;padding:10px;border:1px solid #bbb;border-radius:8px}.consultation button[type=submit]{background:#171717;color:#fff}.conversation{max-height:190px;overflow:auto;white-space:pre-wrap}.conversation article{padding:8px 0;border-top:1px solid #eee}.conversation small{color:#666}';shadow.append(formStyle);
  $('.consultation').innerHTML='<form><label for="gyeote-question">현재 화면에서 궁금한 점</label><input id="gyeote-question" type="text" maxlength="240" autocomplete="off" placeholder="개인정보 없이 질문하세요"><button type="submit">현재 화면에 질문</button></form><div class="row"><button class="cancel" hidden>요청 취소</button><button class="settings">연결 설정</button><button class="reset">대화 지우기</button></div>';
  const questionForm=$('.consultation form'),cancelButton=$('.cancel');
  const imageLabel=document.createElement('label'),imageOption=document.createElement('input');imageOption.type='checkbox';imageOption.className='image-option';imageLabel.append(imageOption,document.createTextNode('이번 질문에 개인정보 없는 공개 화면 한 장을 연결 서버로 전송합니다. SSH 연결 시 EC2로 전송됨을 확인합니다.'));questionForm.querySelector('button[type="submit"]').before(imageLabel);
  const imageNotice=document.createElement('p');imageNotice.className='muted';imageNotice.textContent='이미지는 기본 꺼짐입니다. 사용 시 확장 아이콘을 먼저 눌러 탭 권한을 허용하세요. 입력란을 가리지만 모든 민감정보를 자동 확인할 수는 없습니다. 이미지 저장 없음.';imageLabel.after(imageNotice);
  async function capture(source,version){
    const before={revision:pageVersion,url:location.href,x:scrollX,y:scrollY,width:innerWidth,height:innerHeight},mask=GyeoteCapture.plan(),prior=host.style.visibility;
    capturing=true;host.style.visibility='hidden';mask.mount();let result,timer;
    try{
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      result=await Promise.race([chrome.runtime.sendMessage({type:'gyeote:capture',masks:mask.masks,viewport:mask.viewport}),new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('capture_failed')),8000))]);
    }finally{clearTimeout(timer);mask.remove();host.style.visibility=prior;capturing=false;}
    if(version!==serial||before.revision!==pageVersion||before.url!==location.href||before.x!==scrollX||before.y!==scrollY||before.width!==innerWidth||before.height!==innerHeight||!GyeoteDOM.current(source))throw new Error('capture_screen_changed');
    if(!result?.ok)throw new Error(result?.error||'capture_failed');
    if(typeof result.image!=='string'||result.image.length>2*1024*1024||!/^iVBOR[A-Za-z0-9+/=]+$/.test(result.image))throw new Error('capture_failed');
    return result.image;
  }
  const captureTest=document.createElement('button');captureTest.textContent='이미지 범위 검사 · 전송 없음';captureTest.addEventListener('click',async()=>{cancel();const version=serial;try{snapshot=GyeoteDOM.collect();await capture(snapshot,version);if(version===serial)setStatus('공개 탭 한 장의 마스킹과 화면 일치를 확인했습니다. 서버로 전송하거나 저장하지 않았습니다.');}catch{if(version===serial)setStatus('공개 화면 범위 또는 탭 캡처 권한을 확인하지 못해 검사를 보류했습니다. 확장 아이콘을 누른 뒤 개인정보 없는 화면에서 다시 시도하세요.');}});$('.clear').after(captureTest);
  function appendMessage(role,text){
    const article=document.createElement('article'),label=document.createElement('small'),body=document.createElement('div');label.textContent=role==='user'?'나':'곁에 · 현재 답변';body.textContent=text;article.append(label,body);$('.conversation').append(article);
    while($('.conversation').children.length>12)$('.conversation').firstElementChild.remove();$('.conversation').scrollTop=$('.conversation').scrollHeight;return {label,text:body,answer:text};
  }
  const errors={connection_required:'연결 설정에서 서버 연결 파일을 먼저 불러오세요.',feature_disabled:'서버의 화면 상담 기능이 꺼져 있습니다.',busy:'서버가 이전 요청을 처리 중입니다. 잠시 후 직접 다시 질문하세요.',input_budget:'공개 화면 정보가 입력 한도를 넘거나 형식을 확인하지 못했습니다.',image_disabled:'이미지 옵션이 꺼져 있습니다. 이미지를 빼고 다시 질문하세요.',image_unsupported:'현재 모델은 이미지 입력을 지원하지 않습니다. 이미지를 무시하지 않고 중지했습니다.',private_connection:'허용된 로컬 연결을 확인하지 못했습니다.',request_stopped:'요청이 취소되거나 90초 제한을 넘었습니다. 서버 확인 후 직접 다시 질문하세요.',connection_failed:'서버 연결이 끊겼습니다. 연결 확인 후 직접 다시 질문하세요.',generation_failed:'화면 답변을 확인하지 못했습니다. 서버 모델 상태를 확인하세요.',invalid_reply:'응답의 대상 또는 화면 버전을 확인하지 못해 표시하지 않았습니다.'};
  async function ask(question){
    cancel();const version=serial;
    const includeImage=imageOption.checked;imageOption.checked=false;
    if(!GyeoteProtocol.text(question,240)){setStatus('개인정보 없이 질문을 240자 이내로 입력하세요.');return;}
    try{
      snapshot=GyeoteDOM.collect(question);const source=snapshot;
      if(historyUrl!==source.url){history=[];historyUrl=source.url;}
      const payload={...source.payload,question,history:history.slice(-4)};GyeoteProtocol.request(payload);
      appendMessage('user',question);busy=true;questionForm.querySelector('button[type="submit"]').disabled=true;cancelButton.hidden=false;setStatus('현재 공개 화면을 확인해 답변하고 있습니다.');
      requestTimer=setTimeout(()=>{if(version===serial)cancel(errors.request_stopped);},90000);
      const prepared=await chrome.runtime.sendMessage({type:'gyeote:prepare'});if(version!==serial)return;
      if(!prepared?.ok)throw new Error(prepared?.error||'connection_failed');
      if(includeImage){if(!prepared.imageEnabled)throw new Error('image_disabled');setStatus('입력란을 가린 공개 화면 한 장을 수집해 연결 서버로 전송합니다.');payload.image=await capture(source,version);}
      if(version!==serial)return;
      const port=chrome.runtime.connect({name:'gyeote:guide'}),requestId=GyeoteDOM.id();requestPort=port;let finished=false;
      port.onDisconnect.addListener(()=>{clearTimeout(requestTimer);if(version===serial&&!finished){cancel(errors.connection_failed);}});
      port.onMessage.addListener(packet=>{
        if(version!==serial||packet.requestId!==requestId)return;
        finished=true;clearTimeout(requestTimer);busy=false;cancelButton.hidden=true;questionForm.querySelector('button[type="submit"]').disabled=false;
        try{
          if(packet.type!=='result')throw new Error(packet.error||'invalid_reply');
          const answer=GyeoteProtocol.reply(packet.body,payload);
          if(snapshot!==source||!GyeoteDOM.current(source))throw new Error('invalid_reply');
          apply(source,answer.targets,answer.answer);
          if(answer.targets.length&&!selected.length)throw new Error('invalid_reply');
          activeReply=appendMessage('assistant',status.textContent);activeReply.answer=answer.answer;
          history.push({role:'user',text:question},{role:'assistant',text:answer.answer});while(history.length>4||history.reduce((n,m)=>n+m.text.length,0)>1000)history.shift();
        }catch(error){clear(errors[error.message]||errors.invalid_reply);}
        finally{port.disconnect();if(requestPort===port)requestPort=null;}
      });
      port.postMessage({requestId,payload});delete payload.image;
    }catch(error){if(version===serial)cancel(error.message.startsWith('capture_')?'탭 권한·민감 영역·화면 일치를 확인하지 못해 이미지를 전송하지 않았습니다.':errors[error.message]||'현재 공개 화면을 확인하지 못했습니다. 개인정보 없는 화면에서 다시 질문하세요.');}
  }
  questionForm.addEventListener('submit',event=>{event.preventDefault();if(busy)return;const input=$('#gyeote-question'),question=input.value.trim();input.value='';void ask(question);});
  cancelButton.addEventListener('click',()=>cancel('요청과 표시를 중지했습니다.'));
  $('.settings').addEventListener('click',()=>{void chrome.runtime.sendMessage({type:'gyeote:options'}).catch(()=>setStatus('확장 관리 화면에서 곁에의 옵션을 열어 주세요.'));});
  $('.reset').addEventListener('click',()=>{cancel('새 질문을 입력하세요.');history=[];historyUrl='';$('.conversation').replaceChildren();snapshot=null;});
  let drag=null;
  $('.head').addEventListener('pointerdown',event=>{if(event.target.closest('button'))return;const r=panel.getBoundingClientRect();drag={x:event.clientX-r.left,y:event.clientY-r.top};event.currentTarget.setPointerCapture(event.pointerId);});
  $('.head').addEventListener('pointermove',event=>{if(!drag)return;panel.style.left=Math.max(4,Math.min(innerWidth-panel.offsetWidth-4,event.clientX-drag.x))+'px';panel.style.top=Math.max(4,Math.min(innerHeight-panel.offsetHeight-4,event.clientY-drag.y))+'px';panel.style.right='auto';panel.style.bottom='auto';schedule();});
  $('.head').addEventListener('pointerup',()=>drag=null);
  addEventListener('scroll',()=>{if(capturing)pageVersion++;schedule();},{passive:true,capture:true});addEventListener('resize',()=>{pageVersion++;schedule();});
  addEventListener('pagehide',()=>{cancel();snapshot=null;});
  addEventListener('hashchange',()=>{cancel('화면이 바뀌어 이전 표시를 지웠습니다.');snapshot=null;history=[];});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){cancel('탭을 떠나 이전 표시를 지웠습니다.');}});
  observer=new MutationObserver(records=>{
    if(!host.isConnected){if(typeof document!=='undefined'){cancel();style.remove();observer.disconnect();}return;}
    const owned=node=>node===host||node===style||node.nodeType===1&&node.matches('[data-gyeote-host],[data-gyeote-mask],[data-gyeote-style]');
    const siteClasses=value=>String(value||'').split(/\s+/).filter(name=>name&&!classes.includes(name)).sort().join(' ');
    const relevant=records.filter(r=>!owned(r.target)&&!(r.type==='childList'&&[...r.addedNodes,...r.removedNodes].every(owned))&&!(r.type==='attributes'&&r.attributeName==='class'&&siteClasses(r.oldValue)===siteClasses(r.target.className)));
    if(ownMutation||!relevant.length)return;
    pageVersion++;
    if(capturing)return;
    if(snapshot&&!GyeoteDOM.current(snapshot)||selected.some(s=>!s.node.isConnected||!rootStyles.get(s.node.getRootNode())?.isConnected||!GyeoteDOM.usable(s.node)||GyeoteDOM.nameOf(s.node)!==s.candidate.label)){cancel('화면 또는 대상이 바뀌어 이전 표시를 지웠습니다.');snapshot=null;history=[];}
    else schedule();
  });observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeOldValue:true,attributeFilter:['class','style','hidden','disabled','aria-disabled','aria-hidden','aria-modal']});
  chrome.runtime.onMessage.addListener((message,_sender,sendResponse)=>{
    if(message?.type==='gyeote:toggle'){panel.hidden=!panel.hidden;$('.open').hidden=!panel.hidden;if(panel.hidden)cancel();sendResponse({ok:true});}
  });
})();
