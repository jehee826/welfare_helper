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
  let mode='document',documentHistory=[],documentHistoryAccess=null,currentAccess=null,savedPanel=null,inputAssist=null,requestPending=false;
  const conversations={screen:[],document:[]};
  const rootStyles=new Map([[document,style]]);
  const observeOptions={subtree:true,childList:true,characterData:true,attributes:true,attributeOldValue:true,attributeFilter:['class','style','hidden','disabled','aria-disabled','aria-hidden','aria-modal','aria-label','aria-labelledby','title','role','href','type','id','for']};
  function setStatus(text){status.textContent=text;}
  function clear(message){
    ownMutation=true;for(const {node,index} of selected)node.classList.remove(classes[index]);selected=[];badges.replaceChildren();ownMutation=false;
    for(const [root,sheet] of rootStyles)if(root!==document){sheet.remove();rootStyles.delete(root);}
    if(activeReply){activeReply.label.textContent='곁에 · 이전 답변';activeReply.text.textContent=activeReply.answer;activeReply=null;}
    if(message)setStatus(message);
  }
  function cancel(message){serial++;savedPanel?.cancelRequest();clearTimeout(requestTimer);requestPort?.disconnect();requestPort=null;busy=false;requestPending=false;questionForm.querySelector('button[type="submit"]').disabled=false;cancelButton.hidden=true;clear(message);inputAssist?.invalidate();}
  function position(){
    frame=0;
    if(!selected.length)return;
    if(selected.some(item=>!GyeoteDOM.usable(item.node)||!GyeoteDOM.currentCandidate(snapshot,item.candidate))){clear('대상이 바뀌거나 가려져 표시를 지웠습니다. 현재 화면으로 다시 질문하세요.');return;}
    for(const {node,badge} of selected){const r=node.getBoundingClientRect();badge.style.left=Math.max(4,Math.min(innerWidth-badge.offsetWidth-4,r.left))+'px';badge.style.top=Math.max(4,r.top-30)+'px';}
  }
  function schedule(){if(!frame)frame=requestAnimationFrame(position);}
  function apply(next,targets,explanation){
    clear();
    if(snapshot!==next||!GyeoteDOM.current(next))throw new Error('stale_snapshot');
    if(!Array.isArray(targets)||targets.length>3||new Set(targets.map(t=>t.target_id)).size!==targets.length)throw new Error('invalid_targets');
    const checked=targets.map((item,index)=>{
      const node=next.refs.get(item.target_id),candidate=next.payload.candidates.find(c=>c.id===item.target_id);
      if(!node||!candidate||!GyeoteDOM.usable(node)||!GyeoteDOM.currentCandidate(next,candidate))throw new Error('stale_target');
      return {node,index,candidate,meaning:GyeoteDOM.safeText(item.meaning,120)};
    });
    ownMutation=true;
    for(const item of checked){
      const root=item.node.getRootNode();
      if(!rootStyles.has(root)||!rootStyles.get(root).isConnected){
        const sheet=document.createElement('style');sheet.dataset.gyeoteStyle='';sheet.textContent=style.textContent;
        (root===document?document.documentElement:root).append(sheet);rootStyles.set(root,sheet);
        observer?.observe(root,observeOptions);
      }
      const p=palette[item.index],badge=document.createElement('span');badge.className='badge';badge.style.background=p.color;badge.textContent=`${p.number} ${item.candidate.label}`;badges.append(badge);item.node.classList.add(classes[item.index]);selected.push({...item,badge});
    }
    ownMutation=false;position();
    if(checked.length&&!selected.length)return;
    const legends=checked.map(item=>`${palette[item.index].number} ${palette[item.index].name} 테두리의 ‘${item.candidate.label}’${item.meaning?' · '+item.meaning:''}`);
    setStatus([explanation,...legends].join('\n'));
  }
  async function renderingTest(count,bodyOnly=false){
    if(mode!=='screen')return;
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
  $('.open').addEventListener('click',()=>{panel.hidden=false;$('.open').hidden=true;inputAssist?.update();});
  $('.collapse').addEventListener('click',()=>{collapsed=!collapsed;$('.body').hidden=collapsed;$('.collapse').textContent=collapsed?'+':'−';cancel('패널을 접어 표시를 지웠습니다.');});
  const formStyle=document.createElement('style');formStyle.textContent='.consultation form{display:grid;gap:8px;margin:14px 0}.consultation input[type=text]{width:100%;padding:10px;border:1px solid #bbb;border-radius:8px}.consultation button[type=submit]{background:#171717;color:#fff}.conversation{max-height:190px;overflow:auto;white-space:pre-wrap}.conversation article{padding:8px 0;border-top:1px solid #eee}.conversation small{color:#666}';shadow.append(formStyle);
  formStyle.textContent+='.saved-conversation-list{max-height:160px;overflow:auto}.saved-conversation{padding:6px 0;border-bottom:1px solid #eee}.saved-conversation button:first-child{max-width:100%;overflow-wrap:anywhere;text-align:left}.saved-conversation small{font-size:11px;color:#666}.unsaved-conversation{padding:10px;border:1px solid #777;border-radius:9px;margin-top:10px}.unsaved-conversation>div{max-height:180px;overflow:auto;overflow-wrap:anywhere}';
  $('.consultation').innerHTML='<form><label for="gyeote-question">현재 화면에서 궁금한 점</label><input id="gyeote-question" type="text" maxlength="240" autocomplete="off" placeholder="개인정보 없이 질문하세요"><button type="submit">현재 화면에 질문</button></form><div class="row"><button class="cancel" hidden>요청 취소</button><button class="settings">연결 설정</button><button class="documents" type="button" title="관리자 웹을 새 탭으로 엽니다">문서 관리</button><button class="reset">대화 지우기</button></div>';
  const questionForm=$('.consultation form'),cancelButton=$('.cancel');
  const modeLabel=document.createElement('label'),modeSelect=document.createElement('select');modeSelect.className='mode';modeSelect.setAttribute('aria-label','질문 모드');
  for(const [value,text] of [['document','복지 상담'],['screen','화면 안내']]){const option=document.createElement('option');option.value=value;option.textContent=text;modeSelect.append(option);}
  modeSelect.value=mode;
  modeLabel.append(document.createTextNode('질문 모드 '),modeSelect);questionForm.before(modeLabel);
  const modeNotice=document.createElement('p');modeNotice.className='muted';modeLabel.after(modeNotice);
  const accessNotice=document.createElement('p');accessNotice.className='muted document-access';modeNotice.after(accessNotice);
  const profileSlot=document.createElement('div');questionForm.before(profileSlot);
  let profilePanel;
  function updateProfileView(){if(!profilePanel)return;profilePanel.setVisible(mode==='document');questionForm.hidden=mode==='document'&&!profilePanel.allowed;inputAssist?.update();}
  profilePanel=GyeoteProfilePanel.create(profileSlot,()=>{documentHistory=[];inputAssist?.invalidate();if(mode==='document')cancel('내 정보가 바뀌어 이전 요청을 중지했습니다. 확인한 뒤 다시 질문해 주세요.');},updateProfileView);
  const savedSlot=document.createElement('div');savedSlot.className='saved-slot';modeNotice.after(savedSlot);
  savedPanel=GyeoteConversationPanel.create(savedSlot,{
    invalidate:()=>{inputAssist?.invalidate();if(mode==='document'){cancel('상담이 바뀌어 이전 요청을 중지했습니다.');documentHistory=[];}},
    onStateChange:()=>inputAssist?.update(),
    profileRevision:()=>profilePanel.state?.revision,
    render:conversation=>{
      if(mode!=='document'||currentAccess?.mode!=='anonymous')return;
      $('.conversation').replaceChildren();
      for(const message of conversation?.messages||[]){
        if(message.role==='user')appendMessage('user',message.content,100);
        else appendDocumentAnswer({kind:message.kind,text:message.content,evidence:message.evidence,evidenceTruncated:message.evidenceTruncated,context_usage:message.contextUsage},true);
      }
      inputAssist?.update();
    }
  });
  const accessKey=state=>[state?.mode||'anonymous',state?.status||'anonymous',state?.accessId||'initial'].join(':');
  function resetDocumentHistory(){documentHistory=[];documentHistoryAccess=null;conversations.document=[];if(mode==='document')$('.conversation').replaceChildren();inputAssist?.invalidate();}
  function showDocumentAccess(state){
    currentAccess=state;
    accessNotice.textContent=state?.mode==='admin'?(state.status==='ready'?'문서 접근: 관리자 연결됨':'문서 접근: 관리자 세션 만료 · 연결 설정에서 다시 로그인하세요.'):'문서 접근: 공개 문서 (익명)';
    $('.reset').textContent=state?.mode==='anonymous'?'새 상담':'임시 대화 지우기';
    const result=savedPanel.setAccess(state,mode==='document');inputAssist?.update();return result;
  }
  async function refreshDocumentAccess(){
    const version=serial;
    try{const state=await chrome.runtime.sendMessage({type:'gyeote:document-access'});if(version===serial&&mode==='document'){if(!['admin','anonymous'].includes(state?.mode))throw new Error();if(documentHistoryAccess&&documentHistoryAccess!==accessKey(state))resetDocumentHistory();showDocumentAccess(state);}}
    catch{if(version===serial&&mode==='document')accessNotice.textContent='문서 접근 상태 확인 필요 · 연결 설정을 확인하세요.';}
  }
  const imageLabel=document.createElement('label'),imageOption=document.createElement('input');imageOption.type='checkbox';imageOption.className='image-option';imageLabel.append(imageOption,document.createTextNode('이번 질문에 개인정보 없는 공개 화면 한 장을 연결 서버로 전송합니다. SSH 연결 시 EC2로 전송됨을 확인합니다.'));questionForm.querySelector('button[type="submit"]').before(imageLabel);
  const imageNotice=document.createElement('p');imageNotice.className='muted';imageNotice.textContent='이 체크는 이미지 첨부 여부만 바꿉니다. 모델은 연결 서버에서 정합니다. 사용 시 확장 아이콘을 먼저 눌러 탭 권한을 허용하세요. 입력란·프레임·캔버스·영상은 가리고 나머지 공개 영역만 보냅니다. 모든 민감정보를 자동 확인할 수는 없습니다. 이미지 저장 없음.';imageLabel.after(imageNotice);
  function updateMode(){
    const documentMode=mode==='document',input=$('#gyeote-question');
    panel.setAttribute('aria-label',documentMode?'곁에 복지 상담':'곁에 화면 안내');
    imageOption.checked=false;imageOption.disabled=documentMode;imageLabel.hidden=documentMode;imageNotice.hidden=documentMode;$('.body > details').hidden=documentMode;
    input.maxLength=documentMode?300:240;input.value='';
    questionForm.querySelector('label').textContent=documentMode?'등록 문서에 궁금한 점':'현재 화면에서 궁금한 점';
    questionForm.querySelector('button[type="submit"]').textContent=documentMode?'문서에 질문':'현재 화면에 질문';
    modeNotice.textContent=documentMode?'질문·현재 조건·제한한 최근 대화와 누적 요약으로 문서를 다시 검색합니다. 화면·이미지는 수집하지 않습니다. 개인정보는 입력하지 마세요. 비공개 자료는 연결 설정에서 관리자 로그인 후 질문하세요.':'현재 공개 화면의 정보로 설명하고 필요한 요소를 표시합니다.';
    accessNotice.hidden=!documentMode;if(documentMode){accessNotice.textContent='문서 접근 상태 확인 중';void refreshDocumentAccess();}
    $('.body > p.muted').textContent=documentMode?'등록된 문서의 원문 근거로 답변합니다.':'현재 공개 복지로 화면을 함께 봅니다. 클릭은 직접 해 주세요.';
    setStatus(documentMode?'등록 문서에 질문하세요. 개인정보는 입력하지 마세요.':'공개 화면에서 궁금한 내용을 질문하세요.');
    updateProfileView();
    if(!documentMode)void savedPanel.setAccess(currentAccess,false);
  }
  modeSelect.addEventListener('change',()=>{
    if(!['screen','document'].includes(modeSelect.value)||modeSelect.value===mode)return;
    cancel();snapshot=null;conversations[mode]=[...$('.conversation').children];mode=modeSelect.value;
    $('.conversation').replaceChildren(...conversations[mode]);updateMode();
  });
  inputAssist=GyeoteInputAssist.create(questionForm,{state:()=>{
    const saved=savedPanel.state,conversation=saved?.conversations.find(c=>c.id===saved.lastActiveConversationId);
    const anonymous=currentAccess?.mode==='anonymous';
    return {mode,key:[mode,serial,accessKey(currentAccess),profilePanel.state?.revision,saved?.generation,saved?.revision,saved?.lastActiveConversationId].join('|'),
      available:host.isConnected&&!panel.hidden&&!collapsed&&!document.hidden&&!questionForm.hidden,
      blocked:busy||requestPending||mode==='document'&&(!profilePanel.allowed||!currentAccess||anonymous&&(!savedPanel.ready||savedPanel.hasUnsaved)||!anonymous&&currentAccess.status!=='ready'),
      hasHistory:anonymous?!!conversation?.messages.some(m=>m.role==='assistant'):documentHistory.some(m=>m.role==='assistant'),limit:$('#gyeote-question').maxLength};
  }});
  updateMode();
  async function capture(source,version){
    const before={revision:pageVersion,url:location.href,x:scrollX,y:scrollY,width:innerWidth,height:innerHeight},mask=GyeoteCapture.plan(),prior=host.style.visibility;
    capturing=true;host.style.visibility='hidden';mask.mount();let result,timer;
    try{
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      if(!mask.current())throw new Error('capture_screen_changed');
      result=await Promise.race([chrome.runtime.sendMessage({type:'gyeote:capture',masks:mask.masks,viewport:mask.viewport}),new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('capture_failed')),8000))]);
    }finally{clearTimeout(timer);mask.remove();host.style.visibility=prior;capturing=false;}
    if(version!==serial||before.revision!==pageVersion||before.url!==location.href||before.x!==scrollX||before.y!==scrollY||before.width!==innerWidth||before.height!==innerHeight||!mask.current()||!GyeoteDOM.current(source))throw new Error('capture_screen_changed');
    if(!result?.ok)throw new Error(result?.error||'capture_failed');
    if(typeof result.image!=='string'||result.image.length>2*1024*1024||!/^iVBOR[A-Za-z0-9+/=]+$/.test(result.image))throw new Error('capture_failed');
    return {image:result.image,partial:mask.partial};
  }
  const captureErrors={capture_public_required:'공개 화면 조건 미충족',capture_tab_hidden:'선택 탭 아님',capture_modal_open:'열린 대화상자',capture_expanded_combo:'열린 선택 목록',capture_closed_shadow:'내부를 확인할 수 없는 화면 구성요소',capture_mask_limit:'가릴 영역 한도 초과',capture_offscreen_failed:'확장 내부 문서 준비 실패',capture_permission_or_failed:'탭 캡처 권한 또는 Chrome 캡처 실패',capture_tab_changed:'캡처 중 탭·창 변경',capture_processing_failed:'PNG 변환·크기·마스크 처리 실패',capture_screen_changed:'캡처 중 화면 변경',capture_failed:'캡처 응답·시간·PNG 형식 확인 실패',screen_scope_limit:'공개 화면 수집 범위 초과',public_screen_required:'공개 화면 조건 미충족'};
  const captureTest=document.createElement('button');captureTest.textContent='이미지 범위 검사 · 전송 없음';captureTest.addEventListener('click',async()=>{cancel();const version=serial;try{snapshot=GyeoteDOM.collect();await capture(snapshot,version);if(version===serial)setStatus('공개 탭 한 장의 마스킹과 화면 일치를 확인했습니다. 서버로 전송하거나 저장하지 않았습니다.');}catch(error){if(version===serial)setStatus('이미지 검사를 보류했습니다. 원인: '+(captureErrors[error.message]||'공개 화면 확인 실패')+'. 서버로 전송하지 않았습니다.');}});$('.clear').after(captureTest);
  function appendMessage(role,text,limit=mode==='document'&&currentAccess?.mode==='anonymous'?100:12){
    const article=document.createElement('article'),label=document.createElement('small'),body=document.createElement('div');label.textContent=role==='user'?'나':'곁에 · 현재 답변';body.textContent=text;article.append(label,body);$('.conversation').append(article);
    while($('.conversation').children.length>limit)$('.conversation').firstElementChild.remove();$('.conversation').scrollTop=$('.conversation').scrollHeight;return {article,label,text:body,answer:text};
  }
  function appendDocumentAnswer(answer,restored=false){
    const message=appendMessage('assistant',answer.text);message.label.textContent=answer.kind==='answer'?'곁에 · 문서 답변':'곁에 · 문서에서 확인하지 못함';
    if(restored){const notice=document.createElement('p');notice.className='muted';notice.textContent='저장한 당시의 답변입니다. 근거의 현재 유효성은 다시 확인하지 않았습니다.'+(answer.evidenceTruncated?' 근거는 일부 인용·참조만 저장했습니다.':'');message.article.append(notice);}
    if(answer.context_usage?.omitted){const notice=document.createElement('p');notice.className='muted';notice.textContent='이 답변은 입력 예산에 따라 일부 대화 맥락을 제외했습니다.';message.article.append(notice);}
    if(!answer.evidence.length)return;
    const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent=`원문 근거 보기 (${answer.evidence.length}건)`;details.append(summary);
    for(const item of answer.evidence){
      const section=document.createElement('section');
      if(item.redacted){const notice=document.createElement('p');notice.textContent='개인정보 형식을 가린 자료입니다. 원문 그대로의 인용이 아닙니다.';section.append(notice);}
      const lines=[item.role==='retrieved'?'검색 원문, 모델 답변의 정확한 인용으로 검증한 내용은 아닙니다.':item.role==='required_context'?'답변과 함께 확인할 원문 조건·예외':'답변 인용',item.quote,item.context,`쪽: ${item.pages.length?item.pages.join(', '):'미확인'} · 원문 블록: ${item.source_blocks.join(', ')}`,`출처: ${item.source_url||'미확인'}`,`지역: ${item.region_scope||'미확인'} · 자료 수정일: ${item.source_updated_at||'미확인'} · 기준연도: ${item.basis_year||'미기재'}`,'자료 수정일은 현행 운영 확인일이 아닙니다. 신청 전 관할 기관의 최신 기준을 확인하세요.'];
      for(const text of lines){if(!text)continue;const p=document.createElement('p');p.textContent=text;section.append(p);}
      const url=GyeoteConversations.sourceUrl(item.source_url);
      if(url){const link=document.createElement('a');link.textContent='출처 열기';link.href=url;link.target='_blank';link.rel='noopener noreferrer';section.append(link);}
      details.append(section);
    }
    message.article.append(details);
  }
  const errors={connection_required:'연결 설정에서 서버 연결 파일을 먼저 불러오세요.',feature_disabled:'서버의 화면 상담 기능이 꺼져 있습니다.',busy:'서버가 이전 요청을 처리 중입니다. 잠시 후 직접 다시 질문하세요.',input_budget:'공개 화면 정보가 입력 한도를 넘거나 형식을 확인하지 못했습니다.',image_disabled:'이미지 옵션이 꺼져 있습니다. 이미지를 빼고 다시 질문하세요.',image_unsupported:'현재 모델은 이미지 입력을 지원하지 않습니다. 이미지를 무시하지 않고 중지했습니다.',private_connection:'허용된 로컬 연결을 확인하지 못했습니다.',request_stopped:'요청이 취소되거나 설정된 처리 시간을 넘었습니다. 서버 확인 후 직접 다시 질문하세요.',connection_failed:'서버 연결이 끊겼습니다. 연결 확인 후 직접 다시 질문하세요.',generation_failed:'화면 답변을 확인하지 못했습니다. 서버 모델 상태를 확인하세요.',invalid_reply:'응답의 대상 또는 화면 버전을 확인하지 못해 표시하지 않았습니다.'};
  async function ask(question){
    cancel();const version=serial,documentMode=mode==='document';
    if(documentMode&&!profilePanel.allowed){setStatus('내 정보를 저장하거나 나중 입력을 선택한 뒤 질문해 주세요.');return;}
    let requestProfile,conversationContext,requestAccess,requestInput,publicRequest=false;
    const requestId=GyeoteDOM.id();
    const startedAt=Date.now();let budgetSeconds;
    const stoppedText=()=>budgetSeconds?`요청이 취소되거나 설정된 ${budgetSeconds}초를 넘었습니다. 서버 확인 후 직접 다시 질문하세요.`:errors.request_stopped;
    const includeImage=!documentMode&&imageOption.checked;imageOption.checked=false;
    if(documentMode?(!question.trim()||question.length>300):!GyeoteProtocol.text(question,240)){setStatus(`개인정보 없이 질문을 ${documentMode?300:240}자 이내로 입력하세요.`);return;}
    requestPending=true;inputAssist.update();
    try{
      let source=null,payload;
      if(documentMode){
        requestProfile=profilePanel.state;await profilePanel.confirm(requestProfile);if(version!==serial)return;
        const access=await chrome.runtime.sendMessage({type:'gyeote:document-access'});if(version!==serial)return;
        if(!['anonymous','admin'].includes(access?.mode))throw new Error('connection_failed');
        if(currentAccess&&accessKey(currentAccess)!==accessKey(access))resetDocumentHistory();
        await showDocumentAccess(access);if(version!==serial)return;requestAccess=accessKey(access);publicRequest=access.mode==='anonymous';
        if(publicRequest){conversationContext=savedPanel.context();requestInput=await savedPanel.begin(conversationContext,requestId,requestProfile.revision);if(version!==serial)return;}
        payload=GyeoteProtocol.documentRequest({query:question,...(publicRequest?requestInput:{history:documentHistory}),profile:requestProfile.profile});
      }
      else{
        snapshot=GyeoteDOM.collect(question);source=snapshot;
        if(historyUrl!==source.url){history=[];historyUrl=source.url;}
        payload={...source.payload,question,history:history.slice(-4)};GyeoteProtocol.request(payload);
      }
      appendMessage('user',question);busy=true;questionForm.querySelector('button[type="submit"]').disabled=true;cancelButton.hidden=false;setStatus(documentMode?'등록 문서에서 답변을 찾고 있습니다.':'현재 공개 화면을 확인해 답변하고 있습니다.');
      requestTimer=setTimeout(()=>{if(version===serial)cancel(errors.connection_failed);},10000);
      const prepared=await chrome.runtime.sendMessage({type:'gyeote:prepare',mode});if(version!==serial)return;
      if(!prepared?.ok)throw new Error(prepared?.error||'connection_failed');
      if(documentMode){
        const access=accessKey(prepared.documentAccess);
        if(access!==requestAccess)throw new Error('document_access_changed');
        // 알림이 늦어져도 이전 관리자 이력을 다른 접근 상태의 요청에 싣지 않는다.
        if(documentHistoryAccess&&documentHistoryAccess!==access){resetDocumentHistory();payload.history=[];appendMessage('user',question);}
        documentHistoryAccess=access;
        if(prepared.documentAccess)showDocumentAccess(prepared.documentAccess);
      }
      budgetSeconds=GyeoteProtocol.timeoutSeconds(prepared);
      const remaining=budgetSeconds*1000-(Date.now()-startedAt);
      if(remaining<=0)throw new Error('request_stopped');
      clearTimeout(requestTimer);requestTimer=setTimeout(()=>{if(version===serial)cancel(stoppedText());},remaining);
      setStatus(`${documentMode?'등록 문서에서 답변을 찾고 있습니다.':'현재 공개 화면을 확인해 답변하고 있습니다.'} 최대 ${budgetSeconds}초까지 기다립니다.${documentMode?' 취소해도 서버 계산이 즉시 멈추지는 않을 수 있습니다.':''}`);
      if(includeImage){if(!prepared.imageEnabled)throw new Error('image_disabled');setStatus('입력란과 확인 불가 영역을 가린 공개 화면 한 장을 수집해 연결 서버로 전송합니다.');const captured=await capture(source,version);payload.image=captured.image;payload.partial=payload.partial||captured.partial;}
      if(version!==serial)return;
      const port=chrome.runtime.connect({name:'gyeote:guide'});requestPort=port;let finished=false;
      port.onDisconnect.addListener(()=>{if(version===serial&&requestPort===port&&!finished)cancel(errors.connection_failed);});
      port.onMessage.addListener(async packet=>{
        if(version!==serial||requestPort!==port||finished||packet.requestId!==requestId)return;
        finished=true;
        try{
          if(documentMode){await profilePanel.confirm(requestProfile);if(version!==serial||requestPort!==port)return;}
          if(packet.type!=='result')throw new Error(packet.error||'invalid_reply');
          if(documentMode){
            const answer=GyeoteProtocol.documentReply(packet.body,requestInput?.conversation_context??null);setStatus('문서 답변입니다. 원문 근거를 함께 확인하세요.');appendDocumentAnswer(answer);
            if(publicRequest){
              clearTimeout(requestTimer);
              const saved=await savedPanel.save(conversationContext,requestId,question,answer,requestProfile.revision,()=>version===serial&&requestPort===port&&mode==='document');
              if(version===serial&&requestPort===port)setStatus(saved?'답변을 이 기기에 저장했습니다. 당시 근거의 현재 유효성은 다시 확인하지 않았습니다.'+(answer.context_update?.status==='failed'?' 요약 갱신은 실패해 제한한 최근 대화로 답변했습니다.':'')+(requestInput?.conversation_context.omitted||answer.context_update?.status==='omitted'||answer.context_usage?.omitted?' 일부 대화 맥락은 제외됐습니다.':''):'답변과 요약 후보가 저장되지 않았습니다. 아래의 저장 재시도를 확인하세요.');
              return;
            }
            // 기존 /chat은 이력을 수용하지만 현재 문서 검색·생성에는 마지막 질문만 사용한다.
            if(answer.text.length<=6000){documentHistory.push({role:'user',content:question},{role:'assistant',content:GyeoteProtocol.privacy.maskText(answer.text,true)});while(documentHistory.length>12||documentHistory.reduce((n,m)=>n+m.content.length,0)>6000)documentHistory.splice(0,2);}
            return;
          }
          const answer=GyeoteProtocol.reply(packet.body,payload);
          if(snapshot!==source||!GyeoteDOM.current(source))throw new Error('invalid_reply');
          apply(source,answer.targets,answer.answer);
          if(answer.targets.length&&!selected.length)throw new Error('invalid_reply');
          activeReply=appendMessage('assistant',status.textContent);activeReply.answer=answer.answer;
          history.push({role:'user',text:question},{role:'assistant',text:answer.answer});while(history.length>4||history.reduce((n,m)=>n+m.text.length,0)>1000)history.shift();
        }catch(error){if(version!==serial||requestPort!==port)return;if(documentMode&&['document_auth_required','document_access_changed'].includes(error.message)){resetDocumentHistory();void refreshDocumentAccess();}clear(error.message==='request_stopped'?stoppedText():documentMode?documentError(error.message):errors[error.message]||errors.invalid_reply);}
        finally{if(version===serial&&requestPort===port){clearTimeout(requestTimer);busy=false;cancelButton.hidden=true;questionForm.querySelector('button[type="submit"]').disabled=false;requestPort=null;inputAssist.update();}port.disconnect();}
      });
      port.postMessage({requestId,mode,payload,...(documentMode?{documentAccess:documentHistoryAccess,profileRevision:requestProfile.revision}:{}),...(conversationContext?{conversationContext:{revision:conversationContext.expectedRevision,generation:conversationContext.generation}}:{}),deadlineAt:startedAt+budgetSeconds*1000});delete payload.image;
    }catch(error){
      if(version!==serial)return;
      cancel(error.message.startsWith('capture_')?'탭 권한·민감 영역·화면 일치를 확인하지 못해 이미지를 전송하지 않았습니다.':error.message==='request_stopped'?stoppedText():documentMode?documentError(error.message):errors[error.message]||'현재 공개 화면을 확인하지 못했습니다. 개인정보 없는 화면에서 다시 질문하세요.');
      if(documentMode&&['document_auth_required','document_access_changed'].includes(error.message)){resetDocumentHistory();void refreshDocumentAccess();}
    }
    finally{if(version===serial){requestPending=false;inputAssist.update();}}
  }
  function documentError(code){return ({invalid_profile:'내 정보의 입력값을 확인한 뒤 다시 질문해 주세요.',profile_changed:'내 정보가 바뀌어 이전 답변을 표시하지 않았습니다. 확인한 뒤 다시 질문해 주세요.',profile_storage_failed:'내 정보를 확인하지 못해 질문을 보내거나 답변을 표시하지 않았습니다. 내 정보에서 다시 불러오세요.',profile_data_invalid:'저장된 내 정보를 확인하지 못했습니다. 내 정보에서 재설정을 확인해 주세요.',sensitive_input:'개인정보가 포함된 질문은 보낼 수 없습니다. 개인정보를 제외하고 다시 질문해 주세요.',document_auth_required:'관리자 세션이 없거나 만료됐습니다. 연결 설정에서 다시 로그인하거나 익명으로 전환하세요.',document_access_changed:'문서 접근 상태가 바뀌어 이전 대화를 지웠습니다. 현재 접근 상태에서 직접 다시 질문하세요.',generation_failed:'문서 검색이나 답변 처리에 실패했습니다. 잠시 후 다시 질문해 주세요.',connection_failed:'서버에 연결하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.',request_timeout:'요청 처리 시간을 넘었습니다. 잠시 후 다시 질문해 주세요.',request_cancelled:'요청이 취소되었습니다. 다시 질문할 수 있습니다.',input_budget:'문서 질문은 300자, 대화 이력은 전체 6000자 이내여야 합니다.',invalid_reply:'문서 응답 형식을 확인하지 못해 표시하지 않았습니다.'})[code]||errors[code]||'문서 요청을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.';}
  questionForm.addEventListener('submit',event=>{event.preventDefault();inputAssist.cancel();if(busy||requestPending)return;if(mode==='document'&&currentAccess?.mode==='anonymous'&&savedPanel.hasUnsaved){setStatus('미저장 답변을 보관하거나 명시적으로 버린 뒤 다음 질문을 보내세요.');return;}const input=$('#gyeote-question'),question=input.value.trim();if(question.length>input.maxLength){setStatus(`질문을 ${input.maxLength}자 이내로 수정한 뒤 전송해 주세요.`);input.focus();return;}input.value='';void ask(question);});
  cancelButton.addEventListener('click',()=>cancel('요청과 표시를 중지했습니다.'));
  $('.settings').addEventListener('click',()=>{void chrome.runtime.sendMessage({type:'gyeote:options'}).catch(()=>setStatus('확장 관리 화면에서 곁에의 옵션을 열어 주세요.'));});
  const managerButton=$('.documents');
  managerButton.addEventListener('click',async()=>{
    managerButton.disabled=true;
    try{
      const result=await chrome.runtime.sendMessage({type:'gyeote:document-manager'});
      if(!result?.ok)throw new Error();
      setStatus('문서 관리용 새 탭을 열었습니다.');
    }
    catch{setStatus('문서 관리 페이지를 열지 못했습니다. 잠시 후 다시 눌러 주세요.');}
    finally{managerButton.disabled=false;}
  });
  $('.reset').addEventListener('click',()=>{if(mode==='document'&&currentAccess?.mode==='anonymous'){void savedPanel.newConversation();return;}cancel('새 질문을 입력하세요.');if(mode==='document')resetDocumentHistory();else{history=[];historyUrl='';}conversations[mode]=[];$('.conversation').replaceChildren();snapshot=null;});
  let drag=null;
  $('.head').addEventListener('pointerdown',event=>{if(event.target.closest('button'))return;const r=panel.getBoundingClientRect();drag={x:event.clientX-r.left,y:event.clientY-r.top};event.currentTarget.setPointerCapture(event.pointerId);});
  $('.head').addEventListener('pointermove',event=>{if(!drag)return;panel.style.left=Math.max(4,Math.min(innerWidth-panel.offsetWidth-4,event.clientX-drag.x))+'px';panel.style.top=Math.max(4,Math.min(innerHeight-panel.offsetHeight-4,event.clientY-drag.y))+'px';panel.style.right='auto';panel.style.bottom='auto';schedule();});
  $('.head').addEventListener('pointerup',()=>drag=null);
  addEventListener('scroll',()=>{if(capturing)pageVersion++;schedule();},{passive:true,capture:true});addEventListener('resize',()=>{pageVersion++;schedule();});
  addEventListener('pagehide',()=>{cancel();snapshot=null;inputAssist.dispose();profilePanel.dispose();savedPanel.dispose();});
  addEventListener('pageshow',event=>{if(event.persisted){profilePanel.resume();savedPanel.resume();inputAssist.resume();}});
  addEventListener('hashchange',()=>{if(mode==='screen')cancel('화면이 바뀌어 이전 표시를 지웠습니다.');else inputAssist.invalidate();snapshot=null;history=[];});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){cancel('탭을 떠나 이전 표시를 지웠습니다.');}else inputAssist.update();});
  observer=new MutationObserver(records=>{
    if(!host.isConnected){if(typeof document!=='undefined'){cancel();inputAssist.dispose();profilePanel.dispose();savedPanel.dispose();style.remove();observer.disconnect();}return;}
    const owned=node=>node===host||node===style||node.nodeType===1&&node.matches('[data-gyeote-host],[data-gyeote-mask],[data-gyeote-style]');
    const siteClasses=value=>String(value||'').split(/\s+/).filter(name=>name&&!classes.includes(name)).sort().join(' ');
    const relevant=records.filter(r=>!owned(r.target)&&!(r.type==='childList'&&[...r.addedNodes,...r.removedNodes].every(owned))&&!(r.type==='attributes'&&r.attributeName==='class'&&siteClasses(r.oldValue)===siteClasses(r.target.className)));
    if(ownMutation||!relevant.length)return;
    pageVersion++;
    if(capturing)return;
    if(snapshot&&!GyeoteDOM.current(snapshot)||selected.some(s=>!s.node.isConnected||!rootStyles.get(s.node.getRootNode())?.isConnected||!GyeoteDOM.usable(s.node)||!GyeoteDOM.currentCandidate(snapshot,s.candidate))){cancel('화면 또는 대상이 바뀌어 이전 표시를 지웠습니다.');snapshot=null;history=[];}
    else schedule();
  });observer.observe(document.documentElement,observeOptions);
  chrome.runtime.onMessage.addListener((message,_sender,sendResponse)=>{
    if(message?.type==='gyeote:conversations-changed'&&_sender.id===chrome.runtime.id&&!_sender.tab){savedPanel.changed(message.revision,message.generation);sendResponse({ok:true});return;}
    if(message?.type==='gyeote:profile-changed'&&_sender.id===chrome.runtime.id&&!_sender.tab){profilePanel.changed(message.revision);sendResponse({ok:true});return;}
    if(message?.type==='gyeote:document-access-changed'){
      if(_sender.id!==chrome.runtime.id||_sender.tab)return;
      resetDocumentHistory();
      if(mode==='document'){cancel('문서 접근 상태가 바뀌어 이전 문서 요청과 대화를 지웠습니다.');snapshot=null;}
      showDocumentAccess(message.state);
      sendResponse({ok:true});return;
    }
    if(message?.type==='gyeote:toggle'){panel.hidden=!panel.hidden;$('.open').hidden=!panel.hidden;if(panel.hidden)cancel();else inputAssist.update();sendResponse({ok:true});}
  });
})();
