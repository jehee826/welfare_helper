(() => {
  if(window.top!==window||!GyeoteDOM.official()||document.querySelector('[data-gyeote-host]'))return;
  const host=document.createElement('div');host.dataset.gyeoteHost='';
  host.style.cssText='position:fixed;inset:0;z-index:2147483647;pointer-events:none;contain:layout style;';
  const shadow=host.attachShadow({mode:'closed'});
  shadow.innerHTML=`<style>
    :host{all:initial;font:16px/1.6 "Malgun Gothic",sans-serif;color:#171717}*{box-sizing:border-box}
    button,input,select{font:inherit;min-width:0;max-width:100%}button,select{min-height:40px}button{cursor:pointer;padding:7px 11px;border:1px solid #ccc;border-radius:9px;background:#fff;color:#171717;white-space:normal;overflow-wrap:anywhere}
    button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible,a:focus-visible{outline:3px solid #155bd7;outline-offset:2px}
    .panel{position:fixed;right:12px;bottom:12px;width:400px;height:720px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow:hidden;display:flex;flex-direction:column;pointer-events:auto;background:#fff;border:1px solid #ddd;border-radius:24px;box-shadow:0 12px 48px #0002;font-size:16px;line-height:1.6;overflow-wrap:anywhere}
    .panel.is-collapsed{height:auto}.head{display:flex;align-items:center;gap:6px;padding:14px 16px;border-bottom:1px solid #eee;flex-shrink:0;cursor:move;touch-action:none;user-select:none}.head strong{font-size:22px;letter-spacing:-1px;flex:1}.head button{font-size:14px;border-color:transparent;border-radius:12px;padding:6px 9px}.head .menu-toggle,.head .collapse{width:40px;font-size:20px;padding:0}.body{display:flex;flex-direction:column;min-height:0;flex:1}.transcript{flex:1;min-height:72px;overflow:auto;overscroll-behavior:contain;padding:16px;scrollbar-width:thin}.panel-tools{padding:12px;background:#f7f7f7;border:1px solid #eee;border-radius:14px;margin-bottom:14px}.panel-tools p{margin:8px 0}.panel-tools label{display:grid;gap:6px}.panel-tools select{width:100%}.muted,small{font-size:13px;color:#666}.status{background:#f5f5f5;padding:9px 16px;margin:0;flex-shrink:0;max-height:100px;overflow:auto;font-size:13px;white-space:pre-wrap}.status:empty,.voice-status:empty,.conversation-warning:empty{display:none}.reply{white-space:pre-wrap}.row{display:flex;gap:6px;flex-wrap:wrap}.row>*{min-width:0}
    [hidden]{display:none!important}.open{position:fixed;right:12px;bottom:12px;pointer-events:auto;background:#171717;color:#fff;border-radius:30px}.badge{position:fixed;pointer-events:none;color:#fff;border:2px solid #fff;border-radius:8px;padding:3px 7px;font-size:13px;font-weight:bold;box-shadow:0 2px 8px #0004;max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}details{margin-top:14px}summary{cursor:pointer}
  </style><section class="panel" aria-label="곁에 복지 상담"><header class="head"><strong>곁에</strong><button class="profile-toggle" aria-expanded="false" aria-controls="gyeote-profile">내 정보</button><button class="menu-toggle" aria-label="상담 메뉴" aria-expanded="false" aria-controls="gyeote-tools">⋯</button><button class="collapse" aria-label="패널 접기" aria-expanded="true" aria-controls="gyeote-body">−</button></header><div class="body" id="gyeote-body"><div class="transcript" tabindex="0" aria-label="상담 내용"><section class="panel-tools" id="gyeote-tools" aria-label="상담 메뉴" hidden><p class="mode-intro muted"></p><div class="tool-actions row"><button class="settings">연결 설정</button><button class="documents" title="관리자 웹을 새 탭으로 엽니다">문서 관리</button><button class="reset">임시 대화 지우기</button><button class="close" aria-label="패널 닫기">패널 닫기</button></div><p class="scope-notice muted"></p></section><div class="profile-slot" id="gyeote-profile"></div><div class="conversation" role="log" aria-label="현재 상담 대화"></div><div class="screen-controls row" hidden><button class="clear">표시 지우기</button></div></div><p class="status" role="status" aria-live="polite"></p><div class="consultation"></div></div></section><button class="open" hidden>곁에 열기</button><div class="badges"></div>`;
  document.documentElement.append(host);
  const $=query=>shadow.querySelector(query),panel=$('.panel'),status=$('.status'),badges=$('.badges'),transcript=$('.transcript');
  const palette=[{name:'파랑',number:'①',color:'#175cde'},{name:'주황',number:'②',color:'#a74b00'},{name:'보라',number:'③',color:'#743abb'}];
  const roleNames={Button:'버튼',Hyperlink:'링크',Input:'입력란',ComboBox:'선택 상자',CheckBox:'체크 상자',RadioButton:'선택 항목',MenuItem:'메뉴 항목'};
  const suffix=GyeoteDOM.id().toLowerCase(),classes=palette.map((_,i)=>`gyeote-${suffix}-${i}`),style=document.createElement('style');
  // 키보드 포커스도 같은 색을 유지하되 이중 테두리로 별도 구분한다.
  style.dataset.gyeoteStyle='';style.textContent=palette.map((p,i)=>`.${classes[i]}{outline:4px solid ${p.color}!important;outline-offset:4px!important}.${classes[i]}:focus-visible{outline-style:double!important;outline-width:6px!important}`).join('\n');document.documentElement.append(style);
  let selected=[],snapshot=null,serial=0,frame=0,collapsed=false,ownMutation=false,observer,requestPort=null,busy=false,activeReply=null,history=[],historyUrl='',pageVersion=0,capturing=false,requestTimer;
  let mode='document',documentHistory=[],documentHistoryAccess=null,currentAccess=null,savedPanel=null,inputAssist=null,requestPending=false;
  let screenAllowed=false,localOrigin=false,configurationReady=false,pendingQuestion=null,pendingReply=null,accessVersion=0;
  try{screenAllowed=GyeoteProtocol.screenAvailable();localOrigin=GyeoteProtocol.isLocalOrigin();configurationReady=true;}catch{}
  const conversations={screen:[],document:[]};
  const rootStyles=new Map([[document,style]]);
  const observeOptions={subtree:true,childList:true,characterData:true,attributes:true,attributeOldValue:true,attributeFilter:['class','style','hidden','disabled','aria-disabled','aria-hidden','aria-modal','aria-label','aria-labelledby','title','role','href','type','id','for']};
  function setStatus(text){const follow=pendingReply?.isConnected&&atConversationEnd();status.textContent=text;if(follow)transcript.scrollTop=transcript.scrollHeight;}
  function clear(message){
    ownMutation=true;for(const {node,index} of selected)node.classList.remove(classes[index]);selected=[];badges.replaceChildren();ownMutation=false;
    for(const [root,sheet] of rootStyles)if(root!==document){sheet.remove();rootStyles.delete(root);}
    if(activeReply){activeReply.label.textContent='곁에 · 이전 답변';activeReply.text.textContent=activeReply.answer;activeReply=null;}
    if(message)setStatus(message);
  }
  function finishQuestion(message){
    if(!pendingQuestion)return;
    const notice=document.createElement('p');notice.className='request-outcome muted';notice.textContent=message;
    if(pendingQuestion.isConnected)pendingQuestion.append(notice);pendingQuestion=null;
  }
  function removePending(){pendingReply?.remove();pendingReply=null;}
  function showPending(){
    removePending();const follow=atConversationEnd();pendingReply=document.createElement('div');pendingReply.className='pending-reply';pendingReply.setAttribute('role','status');pendingReply.setAttribute('aria-live','polite');
    pendingReply.innerHTML='<span class="sr-only">곁에가 답변을 준비하고 있습니다.</span><span class="thinking-dots" aria-hidden="true"><span>•</span><span>•</span><span>•</span></span>';
    $('.conversation').append(pendingReply);if(follow)transcript.scrollTop=transcript.scrollHeight;
  }
  function cancel(message){removePending();finishQuestion(message||'요청을 중지했습니다.');serial++;savedPanel?.cancelRequest();clearTimeout(requestTimer);requestPort?.disconnect();requestPort=null;busy=false;requestPending=false;questionForm.querySelector('button[type="submit"]').disabled=false;cancelButton.hidden=true;requestNotice.hidden=true;clear(message);inputAssist?.invalidate();}
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
      return {node,index,candidate};
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
    const legends=checked.map(item=>`${palette[item.index].number} ${palette[item.index].name} 테두리의 ‘${item.candidate.label}’ · ${roleNames[item.candidate.role]||'요소'}`);
    setStatus([explanation,...(legends.length?['현재 요소 표시',...legends]:[])].join('\n'));
  }
  $('.clear').addEventListener('click',()=>cancel('표시를 지웠습니다.'));
  function focusPanel(){
    const target=collapsed?$('.collapse'):mode==='document'&&profileOpen?[...profileSlot.querySelectorAll('input,select,button')].find(node=>!node.disabled&&!node.closest('[hidden]')&&!node.closest('details:not([open])')):$('#gyeote-question');
    (target||$('.collapse')).focus();
  }
  function openPanel(){panel.hidden=false;$('.open').hidden=true;clampPanel();inputAssist?.update();focusPanel();}
  function closePanel(){finishDrag();cancel();panel.hidden=true;$('.open').hidden=false;$('.open').focus();}
  $('.close').addEventListener('click',closePanel);
  $('.open').addEventListener('click',openPanel);
  $('.collapse').addEventListener('click',()=>{finishDrag();collapsed=!collapsed;$('.body').hidden=collapsed;panel.classList.toggle('is-collapsed',collapsed);const button=$('.collapse');button.textContent=collapsed?'+':'−';button.setAttribute('aria-expanded',String(!collapsed));button.setAttribute('aria-label',collapsed?'패널 펼치기':'패널 접기');cancel(collapsed?'패널을 접어 표시를 지웠습니다.':'패널을 펼쳤습니다.');clampPanel();if(!collapsed)focusPanel();});
  const formStyle=document.createElement('style');formStyle.textContent=`
    .consultation{flex-shrink:0;padding:12px 16px 14px;border-top:1px solid #eee;background:#fff}.consultation form{display:grid;gap:8px;margin:0}.question-label{font-size:13px;font-weight:bold;color:#555}.compose-row{display:flex;align-items:center;gap:4px;padding:5px;border:1px solid #d8d8d8;background:#fafafa;border-radius:16px}.compose-row:focus-within{border-color:#777}.compose-row input[type=text]{min-width:0;flex:1;padding:8px;border:0;background:transparent;border-radius:8px}.consultation button[type=submit]{background:#171717;color:#fff;border:0;border-radius:11px;flex-shrink:0;width:42px;height:42px;display:grid;place-items:center;padding:0}.send-notice{margin:0;font-size:13px;color:#666}.composer-actions{display:flex;gap:8px;align-items:start}.composer-actions .cancel{margin-left:auto}.voice-input{margin:0;flex:1;font-size:13px}.voice-input summary{min-height:32px;padding:4px 0}.voice-input p{margin:6px 0}.voice-status{margin:0;font-size:13px}.question-suggestions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}.question-suggestions button{padding:8px 6px;border-color:#e7e7e7;background:#f7f7f7;font-size:13px;line-height:1.45;border-radius:12px}
    .onboarding{background:#f7f7f7;padding:12px;border-radius:14px;margin-bottom:12px;font-size:14px}.onboarding p{margin:0 0 10px}.onboarding button{font-size:14px}.conversation{white-space:pre-wrap;min-height:100px}.conversation:empty::before{content:'무엇을 도와드릴까요?';display:block;padding:50px 8px;color:#777;text-align:center;font-size:18px}.conversation article{width:fit-content;max-width:94%;padding:12px 14px;margin:0 0 14px;background:#f5f5f5;border-radius:16px 16px 16px 4px}.conversation article.user-message{margin-left:auto;background:#202020;color:#fff;border-radius:16px 16px 4px 16px}.conversation article.user-message small{color:#ddd}.conversation small{display:block;margin-bottom:4px;color:#666;font-size:13px}.conversation article p{margin:8px 0}.conversation details{font-size:13px;margin-top:8px}.conversation-warning{padding:10px;border:1px solid #bbb;border-radius:10px;font-size:13px}.conversation-alerts:empty{display:none}
    @media(max-height:600px){.head{padding:8px 12px}.transcript{padding:12px}.consultation{padding:8px 12px}.consultation form{gap:6px}.question-suggestions button{padding:6px 4px}.conversation:empty::before{padding:20px 4px}}`;
  shadow.append(formStyle);
  formStyle.textContent+=`.head{gap:4px;padding:10px 12px}.head strong{font-size:20px;letter-spacing:-1px;min-width:36px}.head .menu-toggle,.head .collapse{width:32px;flex-shrink:0}.head .profile-toggle{padding:6px;font-size:13px;flex-shrink:0}.mode-switch{display:flex;flex-shrink:0;border:1px solid #e5e5e5;border-radius:12px;background:#f6f6f6;padding:2px}.head .mode-switch button{font-size:13px;padding:4px 6px;min-height:40px;border-radius:9px;background:transparent}.head .mode-switch button[aria-pressed=true]{background:#fff;color:#111;box-shadow:0 1px 4px #0002}.head .mode-switch button:disabled{color:#888;cursor:not-allowed}.mode-reason{font-size:13px;margin:0;padding:4px 12px;color:#666;flex-shrink:0}.pending-reply{width:fit-content;padding:12px 16px;margin-bottom:14px;background:#f5f5f5;border-radius:16px 16px 16px 4px}.thinking-dots{display:flex;gap:5px;font-size:22px;line-height:1}.thinking-dots span{animation:gyeote-thinking 1.2s infinite ease-in-out}.thinking-dots span:nth-child(2){animation-delay:.15s}.thinking-dots span:nth-child(3){animation-delay:.3s}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.request-notice{margin:0;font-size:13px;color:#666;align-self:center}@keyframes gyeote-thinking{0%,80%,100%{opacity:.35;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}@media(prefers-reduced-motion:reduce){.thinking-dots span{animation:none;opacity:1}}`;
  formStyle.textContent+='.unsaved-conversation{padding:10px;border:1px solid #777;border-radius:9px;margin-top:10px}.unsaved-conversation>div{max-height:180px;overflow:auto;overflow-wrap:anywhere}';
  $('.consultation').innerHTML='<form><label class="question-label" for="gyeote-question">복지 상담</label><div class="compose-row"><input id="gyeote-question" type="text" maxlength="240" autocomplete="off" placeholder="개인정보 없이 질문하세요"><button type="submit" aria-label="질문 보내기" title="질문 보내기"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m21 3-7 18-4-7-7-4Z"/><path d="m10 14 11-11"/></svg></button></div><p class="send-notice"></p><div class="composer-actions"><button class="cancel" type="button" hidden>요청 취소</button></div></form>';
  const questionForm=$('.consultation form'),cancelButton=$('.cancel');
  const listeningOverlay=document.createElement('section');listeningOverlay.className='listening-overlay';listeningOverlay.hidden=true;listeningOverlay.setAttribute('role','dialog');listeningOverlay.setAttribute('aria-label','음성 입력');listeningOverlay.innerHTML='<strong role="status" aria-live="polite">듣고 있습니다...</strong>';panel.append(listeningOverlay);
  formStyle.textContent+=`.compose-row .voice-start{width:40px;height:42px;display:grid;place-items:center;flex-shrink:0;padding:0;border:0;background:transparent;color:#555}.voice-start[aria-pressed=true]{color:#175cde}.listening-overlay{position:absolute;inset:0;z-index:10;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;text-align:center;background:#ffffff88;border-radius:inherit}.listening-overlay strong{font-size:22px}.listening-overlay p{font-size:13px;line-height:1.6;margin:0;max-width:270px}.listening-overlay .voice-cancel{background:#171717;color:#fff}.panel.is-listening>.head,.panel.is-listening>.body,.panel.is-listening>.mode-reason{filter:blur(2px);opacity:.55}.panel.is-listening{animation:gyeote-listening-glow 2s ease-in-out infinite;box-shadow:0 0 0 2px #7ab7ff,0 0 28px #176cff66}@keyframes gyeote-listening-glow{0%,100%{box-shadow:0 0 0 2px #7ab7ff,-7px 0 28px #176cff77,7px 0 18px #7acbff44}50%{box-shadow:0 0 0 2px #7ab7ff,7px 0 28px #176cff77,-7px 0 18px #7acbff44}}@media(prefers-reduced-motion:reduce){.panel.is-listening{animation:none}}`;
  function showListening(listening){
    const changed=panel.classList.contains('is-listening')!==listening;panel.classList.toggle('is-listening',listening);listeningOverlay.hidden=!listening;
    $('.head').inert=listening;$('.body').inert=listening;
    if(changed&&listening)listeningOverlay.querySelector('.voice-cancel')?.focus();
    if(changed&&!listening&&!panel.hidden&&!collapsed&&!document.hidden)focusPanel();
  }
  addEventListener('keydown',event=>{if(event.key==='Escape'&&panel.classList.contains('is-listening')){event.preventDefault();inputAssist?.cancel();}});
  const requestNotice=document.createElement('p');requestNotice.className='request-notice';requestNotice.hidden=true;cancelButton.before(requestNotice);
  const tools=$('.panel-tools'),menuButton=$('.menu-toggle'),profileButton=$('.profile-toggle');
  formStyle.textContent+='.head .profile-toggle[aria-expanded=true]{background:#eaf1ff;color:#174b8d;border-color:#aac6ee;box-shadow:inset 0 1px 3px #174b8d18}.head .profile-toggle:active{transform:translateY(1px);background:#dce8fc}';
  function showMenu(open){tools.hidden=!open;menuButton.setAttribute('aria-expanded',String(open));if(open)transcript.scrollTop=0;}
  menuButton.addEventListener('click',()=>{if(collapsed)$('.collapse').click();showMenu(tools.hidden);if(!tools.hidden)$('.documents').focus();});
  const modeLabel=document.createElement('label'),modeSelect=document.createElement('select');modeSelect.className='mode';modeSelect.setAttribute('aria-label','질문 모드');
  for(const [value,text] of [['document','복지 상담'],['screen','화면 안내']]){const option=document.createElement('option');option.value=value;option.textContent=text;option.disabled=value==='screen'&&!screenAllowed;modeSelect.append(option);}
  modeSelect.value=mode;
  modeLabel.hidden=true;modeLabel.append(modeSelect);tools.prepend(modeLabel);
  const modeSwitch=document.createElement('div');modeSwitch.className='mode-switch';modeSwitch.setAttribute('role','group');modeSwitch.setAttribute('aria-label','질문 모드');
  for(const [value,label] of [['document','질문'],['screen','안내']]){
    const button=document.createElement('button');button.type='button';button.dataset.mode=value;button.textContent=label;button.setAttribute('aria-pressed',String(value===mode));button.disabled=value==='screen'&&!screenAllowed;
    button.addEventListener('click',()=>{modeSelect.value=value;modeSelect.dispatchEvent(new Event('change'));});modeSwitch.append(button);
  }
  profileButton.before(modeSwitch);
  const modeReason=document.createElement('p');modeReason.className='mode-reason';modeReason.textContent='이 패키지는 화면 안내를 제공하지 않습니다.';modeReason.hidden=screenAllowed;modeReason.id='gyeote-mode-reason';if(!screenAllowed)modeSwitch.querySelector('[data-mode=screen]').setAttribute('aria-describedby',modeReason.id);$('.head').after(modeReason);
  const modeNotice=document.createElement('p');modeNotice.className='muted';modeLabel.after(modeNotice);
  const accessNotice=document.createElement('p');accessNotice.className='muted document-access';modeNotice.after(accessNotice);
  const profileSlot=$('.profile-slot');
  const onboarding=document.createElement('section');onboarding.className='onboarding';onboarding.setAttribute('aria-label','상담 시작 안내');onboarding.hidden=true;
  onboarding.innerHTML='<p>내 정보는 선택이에요. 입력하거나 나중 입력을 선택하면 상담을 시작할 수 있어요.</p><div class="row"><button class="onboarding-edit">내 정보 입력</button><button class="onboarding-later">나중에 입력</button></div>';
  profileSlot.before(onboarding);
  let profilePanel,profileOpen=false,profileWasAllowed=false;
  function updateProfileView(){
    if(!profilePanel)return;
    const allowed=profilePanel.allowed;
    if(profileSlot.querySelector('.profile-error')?.textContent)profileOpen=true;
    if(allowed&&!profileWasAllowed)profileOpen=false;
    profileWasAllowed=allowed;
    profileSlot.hidden=mode!=='document'||!profileOpen;
    profilePanel.setVisible(mode==='document'&&profileOpen);profileButton.hidden=mode!=='document';
    profileButton.setAttribute('aria-expanded',String(mode==='document'&&profileOpen));
    onboarding.hidden=mode!=='document'||!profilePanel.state||profilePanel.state.onboardingCompleted||profileOpen;
    questionForm.querySelector('button[type="submit"]').disabled=busy||requestPending||mode==='document'&&!allowed;
    $('.onboarding-later').disabled=!profilePanel.state||profilePanel.busy;
    inputAssist?.update();
  }
  profileButton.addEventListener('click',()=>{if(collapsed)$('.collapse').click();profileOpen=!profileOpen;updateProfileView();if(profileOpen){showMenu(false);transcript.scrollTop=0;const target=profileSlot.querySelector('input')||profileSlot.querySelector('h2');if(target){if(target.tagName==='H2')target.tabIndex=-1;target.focus();}}else focusPanel();});
  transcript.addEventListener('keydown',event=>{if(event.key!=='Escape')return;if(profileSlot.contains(event.target)){profileOpen=false;updateProfileView();profileButton.focus();}else if(tools.contains(event.target)){showMenu(false);menuButton.focus();}});
  profilePanel=GyeoteProfilePanel.create(profileSlot,()=>{documentHistory=[];inputAssist?.invalidate();if(mode==='document')cancel('내 정보가 바뀌어 이전 요청을 중지했습니다. 확인한 뒤 다시 질문해 주세요.');},updateProfileView);
  const profileControls=document.createElement('details');profileControls.className='profile-controls';const managementSummary=document.createElement('summary');managementSummary.textContent='저장·확장 관리';profileControls.append(managementSummary);profileSlot.append(profileControls);
  $('.settings').textContent='확장 옵션';profileControls.append($('.settings'),modeLabel,modeNotice,accessNotice,$('.mode-intro'),$('.scope-notice'),$('.reset'));
  const closeButton=$('.close');closeButton.textContent='×';closeButton.title='패널 닫기';$('.head').append(closeButton);$('.documents').textContent='관리자 접근';
  const screenSettings=document.createElement('details'),screenSummary=document.createElement('summary'),screenPrivacy=document.createElement('p');screenSettings.className='screen-settings';screenSummary.textContent='화면·음성 안내';screenSettings.append(screenSummary);screenPrivacy.className='muted';$('.screen-controls').append(screenPrivacy,screenSettings);
  formStyle.textContent+='.head{gap:3px;padding:10px 8px}.head .menu-toggle,.head .collapse,.head .close{width:28px;padding:0;font-size:18px;flex-shrink:0}.head .profile-toggle{padding:6px 4px}.head .mode-switch button{padding:4px}.profile-controls{margin-top:12px}.profile-controls>.settings{margin-top:8px}.screen-controls>p,.screen-controls>details{flex-basis:100%;margin:8px 0}';
  profilePanel.ready.then(()=>{if(!profilePanel.state){profileOpen=true;updateProfileView();}});
  $('.onboarding-edit').addEventListener('click',()=>{if(!profileOpen)profileButton.click();});
  $('.onboarding-later').addEventListener('click',()=>void profilePanel.defer());
  const retentionNotice=document.createElement('p');retentionNotice.className='retention-notice muted';retentionNotice.textContent='대화내역은 30개까지 저장됩니다';transcript.prepend(retentionNotice);
  const savedSlot=document.createElement('div');savedSlot.className='saved-slot';modeNotice.after(savedSlot);
  const conversationAlerts=document.createElement('div');conversationAlerts.className='conversation-alerts';transcript.append(conversationAlerts);
  savedPanel=GyeoteConversationPanel.create(savedSlot,{
    invalidate:()=>{inputAssist?.invalidate();if(mode==='document'){cancel(busy||requestPending?'상담이 바뀌어 이전 요청을 중지했습니다.':undefined);documentHistory=[];}},
    alerts:conversationAlerts,
    onError:()=>{profileOpen=true;updateProfileView();profileControls.open=true;showMenu(false);transcript.scrollTop=0;},
    onStateChange:()=>inputAssist?.update(),
    profileRevision:()=>profilePanel.state?.revision,
    render:conversation=>{
      if(mode!=='document'||currentAccess?.mode!=='anonymous')return;
      const same=transcript.dataset.conversationId===(conversation?.id||''),follow=!same||atConversationEnd(),scroll=transcript.scrollTop;
      transcript.dataset.conversationId=conversation?.id||'';
      const pendingNodes=[pendingQuestion,pendingReply].filter(node=>node?.isConnected);
      $('.conversation').replaceChildren();
      for(const message of conversation?.messages||[]){
        if(message.role==='user')appendMessage('user',message.content,GyeoteConversations.limits.messages+2);
        else appendDocumentAnswer({kind:message.kind,text:message.content,evidence:message.evidence,evidenceTruncated:message.evidenceTruncated,context_usage:message.contextUsage},true);
      }
      $('.conversation').append(...pendingNodes);
      transcript.scrollTop=follow?transcript.scrollHeight:scroll;
      inputAssist?.update();
    }
  });
  const accessKey=state=>[state?.mode||'anonymous',state?.status||'anonymous',state?.accessId||'initial'].join(':');
  function resetDocumentHistory(){documentHistory=[];documentHistoryAccess=null;conversations.document=[];if(mode==='document')$('.conversation').replaceChildren();inputAssist?.invalidate();}
  function showDocumentAccess(state){
    if(configurationReady&&(state?.origin!==GyeoteProtocol.documentOrigin()&&!(state?.origin===undefined&&localOrigin)))throw new Error('document_access_changed');
    currentAccess=state;
    retentionNotice.hidden=mode!=='document'||state?.mode!=='anonymous';
    conversationAlerts.hidden=mode!=='document'||state?.mode!=='anonymous';
    accessNotice.textContent=state?.mode==='admin'?(state.status==='ready'?'문서 접근: 관리자 연결됨':'문서 접근: 관리자 세션 만료 · Chrome 확장 옵션에서 다시 로그인하세요.'):'문서 접근: 공개 문서 (익명)';
    $('.reset').hidden=mode==='document'&&state?.mode==='anonymous';$('.reset').textContent=mode==='document'?'임시 대화 지우기':'안내 대화 지우기';
    const result=savedPanel.setAccess(state,mode==='document');inputAssist?.update();return result;
  }
  async function refreshDocumentAccess(){
    const version=++accessVersion;
    try{const state=await chrome.runtime.sendMessage({type:'gyeote:document-access'});if(version===accessVersion&&mode==='document'&&host.isConnected){if(!['admin','anonymous'].includes(state?.mode))throw new Error();if(documentHistoryAccess&&documentHistoryAccess!==accessKey(state))resetDocumentHistory();showDocumentAccess(state);}}
    catch{if(version===accessVersion&&mode==='document'&&host.isConnected){accessNotice.textContent='문서 접근 상태 확인 필요 · Chrome 확장 옵션을 확인하세요.';setStatus('문서 연결 상태를 확인하지 못했습니다. 내 정보의 저장·확장 관리에서 확장 옵션을 확인하세요.');}}
  }
  const imageLabel=document.createElement('label'),imageOption=document.createElement('input');imageOption.type='checkbox';imageOption.className='image-option';imageLabel.append(imageOption,document.createTextNode('이번 질문에 개인정보 없는 공개 화면 한 장을 연결 서버로 전송합니다. SSH 연결 시 EC2로 전송됨을 확인합니다.'));screenSettings.append(imageLabel);
  const imageNotice=document.createElement('p');imageNotice.className='muted';imageNotice.textContent='이 체크는 이미지 첨부 여부만 바꿉니다. 모델은 연결 서버에서 정합니다. 사용 시 확장 아이콘을 먼저 눌러 탭 권한을 허용하세요. 입력란·프레임·캔버스·영상은 가리고 나머지 공개 영역만 보냅니다. 모든 민감정보를 자동 확인할 수는 없습니다. 이미지 저장 없음.';imageLabel.after(imageNotice);
  const imageReminder=document.createElement('p');imageReminder.className='send-notice';imageReminder.hidden=true;imageReminder.textContent='이번 질문에 마스킹한 공개 화면 이미지 1장도 전송합니다.';questionForm.append(imageReminder);
  imageOption.addEventListener('change',()=>imageReminder.hidden=!imageOption.checked);
  function updateMode(){
    const documentMode=mode==='document',input=$('#gyeote-question');
    (documentMode?profileControls:$('.screen-controls')).append($('.reset'));screenSettings.hidden=documentMode;const voiceHelp=$('.voice-input');if(voiceHelp)(documentMode?profileControls:screenSettings).append(voiceHelp);
    screenPrivacy.textContent=localOrigin?'공개 화면의 요소 이름·주변 문구를 연결 서버로 보냅니다. 로그인·개인정보 화면은 보내지 마세요.':'공개 화면의 요소 이름·주변 문구를 연결 서버로 보냅니다. 이미지·입력값·내 정보는 보내지 않습니다.';
    retentionNotice.hidden=!documentMode||currentAccess?.mode==='admin';
    $('.reset').hidden=documentMode&&currentAccess?.mode==='anonymous';$('.reset').textContent=documentMode?'임시 대화 지우기':'안내 대화 지우기';
    for(const button of modeSwitch.querySelectorAll('button'))button.setAttribute('aria-pressed',String(button.dataset.mode===mode));
    panel.setAttribute('aria-label',documentMode?'곁에 복지 상담':'곁에 화면 안내');
    imageOption.checked=false;imageOption.disabled=documentMode||!localOrigin;imageLabel.hidden=documentMode||!localOrigin;imageNotice.hidden=documentMode||!localOrigin;$('.screen-controls').hidden=documentMode;
    imageReminder.hidden=true;
    input.maxLength=documentMode?300:240;input.value='';
    questionForm.querySelector('label').textContent=documentMode?'복지 상담':'화면 안내';
    $('.send-notice').textContent=documentMode?'질문·내 조건·대화 맥락을 연결 서버로 보냅니다. 개인정보는 입력하지 마세요.':'공개 화면의 요소 이름·주변 문구를 연결 서버로 보냅니다. 클릭은 직접 해 주세요.';
    modeNotice.textContent=documentMode?'질문·현재 조건·제한한 최근 대화와 누적 요약으로 문서를 다시 검색합니다. 화면·이미지는 수집하지 않습니다. 개인정보는 입력하지 마세요. 비공개 자료는 Chrome 확장 옵션에서 관리자 로그인 후 질문하세요.':localOrigin?'현재 공개 화면의 정보로 설명하고 필요한 요소를 표시합니다.':'질문을 보낼 때 공개 화면의 요소 이름·주변 문구를 연결 서버로 전송합니다. 이미지·입력값·내 정보는 보내지 않습니다. 클릭은 직접 해 주세요.';
    accessNotice.hidden=!documentMode;if(documentMode){accessNotice.textContent='문서 접근 상태 확인 중';void refreshDocumentAccess();}
    $('.mode-intro').textContent=documentMode?'등록된 문서의 원문 근거로 답변합니다.':'현재 공개 복지로 화면을 함께 봅니다. 클릭은 직접 해 주세요.';
    $('.scope-notice').textContent=documentMode?'복지 정보는 등록 문서를 기준으로 안내합니다. 개인정보는 입력하지 마세요.'+(!screenAllowed?' 이 패키지는 원격 화면 안내를 제공하지 않습니다.':''):'다른 사이트·로그인·개인정보 화면은 지원하지 않습니다.';
    setStatus('');
    if(!configurationReady)setStatus('설치 패키지의 서버 설정을 확인하지 못했습니다. 올바른 패키지로 다시 설치해 주세요.');
    updateProfileView();
    if(!documentMode)void savedPanel.setAccess(currentAccess,false);
    conversationAlerts.hidden=!documentMode||currentAccess?.mode!=='anonymous';
  }
  modeSelect.addEventListener('change',()=>{
    if(modeSelect.value==='screen'&&!screenAllowed){modeSelect.value=mode;setStatus('이 패키지는 원격 화면 안내를 제공하지 않습니다. 복지 상담을 이용해 주세요.');return;}
    if(!['screen','document'].includes(modeSelect.value)||modeSelect.value===mode)return;
    cancel();accessVersion++;snapshot=null;conversations[mode]=[...$('.conversation').children];mode=modeSelect.value;
    $('.conversation').replaceChildren(...conversations[mode]);updateMode();
  });
  inputAssist=GyeoteInputAssist.create(questionForm,{controls:profileControls,overlay:listeningOverlay,onListening:showListening,state:()=>{
    const saved=savedPanel.state,conversation=saved?.conversations.find(c=>c.id===saved.lastActiveConversationId);
    const anonymous=currentAccess?.mode==='anonymous';
    return {mode,key:[mode,serial,accessKey(currentAccess),profilePanel.state?.revision,saved?.generation,saved?.revision,saved?.lastActiveConversationId].join('|'),
      available:host.isConnected&&!panel.hidden&&!collapsed&&!document.hidden&&!questionForm.hidden,
      blocked:!configurationReady||busy||requestPending||mode==='document'&&(!profilePanel.allowed||!currentAccess||anonymous&&(!savedPanel.ready||savedPanel.hasUnsaved)||!anonymous&&currentAccess.status!=='ready'),
      hasHistory:anonymous?!!conversation?.messages.some(m=>m.role==='assistant'):documentHistory.some(m=>m.role==='assistant'),limit:$('#gyeote-question').maxLength};
  }});
  updateMode();
  async function capture(source,version){
    if(!localOrigin)throw new Error('remote_screen_unavailable');
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
  function atConversationEnd(){return transcript.scrollHeight-transcript.clientHeight-transcript.scrollTop<48;}
  function appendMessage(role,text,limit=mode==='document'&&currentAccess?.mode==='anonymous'?GyeoteConversations.limits.messages+2:12){
    const follow=atConversationEnd(),article=document.createElement('article'),label=document.createElement('small'),body=document.createElement('div');article.className=role==='user'?'user-message':'assistant-message';label.textContent=role==='user'?'나':'곁에 · 현재 답변';body.textContent=text;article.append(label,body);$('.conversation').append(article);
    while($('.conversation').children.length>limit)$('.conversation').firstElementChild.remove();if(follow)transcript.scrollTop=transcript.scrollHeight;return {article,label,text:body,answer:text,follow};
  }
  function appendDocumentAnswer(answer,restored=false){
    const message=appendMessage('assistant',answer.text);message.label.textContent=answer.kind==='answer'?'곁에 · 문서 답변':'곁에 · 문서에서 확인하지 못함';
    if(restored){const notice=document.createElement('p');notice.className='muted';notice.textContent='저장한 당시의 답변입니다. 근거의 현재 유효성은 다시 확인하지 않았습니다.'+(answer.evidenceTruncated?' 근거는 일부 인용·참조만 저장했습니다.':'');message.article.append(notice);}
    if(answer.context_usage?.omitted){const notice=document.createElement('p');notice.className='muted';notice.textContent='이 답변은 입력 예산에 따라 일부 대화 맥락을 제외했습니다.';message.article.append(notice);}
    if(!answer.evidence.length){if(message.follow)transcript.scrollTop=transcript.scrollHeight;return;}
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
    if(message.follow)transcript.scrollTop=transcript.scrollHeight;
  }
  const errors={connection_configuration_invalid:'설치 패키지의 서버 설정을 확인하지 못했습니다. 올바른 패키지로 다시 설치해 주세요.',remote_screen_unavailable:'이 패키지는 원격 화면 안내를 제공하지 않습니다.',connection_required:'Chrome 확장 옵션에서 서버 연결 파일을 먼저 불러오세요.',feature_disabled:'서버의 화면 상담 기능이 꺼져 있습니다.',busy:'서버가 이전 요청을 처리 중입니다. 잠시 후 직접 다시 질문하세요.',input_budget:'공개 화면 정보가 입력 한도를 넘거나 형식을 확인하지 못했습니다.',image_disabled:'이미지 옵션이 꺼져 있습니다. 이미지를 빼고 다시 질문하세요.',image_unsupported:'현재 모델은 이미지 입력을 지원하지 않습니다. 이미지를 무시하지 않고 중지했습니다.',private_connection:'허용된 로컬 연결을 확인하지 못했습니다.',request_stopped:'요청이 취소되거나 설정된 처리 시간을 넘었습니다. 서버 확인 후 직접 다시 질문하세요.',connection_failed:'서버 연결이 끊겼습니다. 연결 확인 후 직접 다시 질문하세요.',generation_failed:'화면 답변을 확인하지 못했습니다. 서버 모델 상태를 확인하세요.',invalid_reply:'응답의 대상 또는 화면 버전을 확인하지 못해 표시하지 않았습니다.'};
  errors.chat_rate_limited='질문 요청이 많습니다. 잠시 기다린 뒤 직접 다시 질문해 주세요.';
  async function ask(question){
    cancel();const version=serial,documentMode=mode==='document';
    if(!configurationReady){setStatus('설치 패키지의 서버 설정을 확인하지 못했습니다. 올바른 패키지로 다시 설치해 주세요.');return;}
    if(!documentMode&&!screenAllowed){setStatus('이 패키지는 원격 화면 안내를 제공하지 않습니다.');return;}
    if(documentMode&&!profilePanel.allowed){setStatus('내 정보를 저장하거나 나중 입력을 선택한 뒤 질문해 주세요.');return;}
    let requestProfile,conversationContext,requestAccess,requestInput,publicRequest=false;
    const requestId=GyeoteDOM.id();
    const startedAt=Date.now();let budgetSeconds;
    const stoppedText=()=>budgetSeconds?`요청이 취소되거나 설정된 ${budgetSeconds}초를 넘었습니다. 서버 확인 후 직접 다시 질문하세요.`:errors.request_stopped;
    const includeImage=!documentMode&&localOrigin&&imageOption.checked;imageOption.checked=false;imageReminder.hidden=true;
    if(documentMode?(!question.trim()||question.length>300):!GyeoteProtocol.text(question,240)){setStatus(`개인정보 없이 질문을 ${documentMode?300:240}자 이내로 입력하세요.`);return;}
    requestPending=true;const follow=atConversationEnd(),questionMessage=appendMessage('user',GyeoteProtocol.privacy.maskText(question,true));if(documentMode)pendingQuestion=questionMessage.article;showPending();questionForm.querySelector('button[type="submit"]').disabled=true;cancelButton.hidden=false;requestNotice.hidden=false;requestNotice.textContent='취소할 수 있어요.';setStatus('');inputAssist.update();if(follow)transcript.scrollTop=transcript.scrollHeight;
    try{
      let source=null,payload;
      if(documentMode){
        requestProfile=profilePanel.state;await profilePanel.confirm(requestProfile);if(version!==serial)return;
        const access=await chrome.runtime.sendMessage({type:'gyeote:document-access'});if(version!==serial)return;
        if(!['anonymous','admin'].includes(access?.mode))throw new Error('connection_failed');
        if(currentAccess&&accessKey(currentAccess)!==accessKey(access))resetDocumentHistory();
        await showDocumentAccess(access);if(version!==serial)return;requestAccess=accessKey(access);publicRequest=access.mode==='anonymous';
        if(!pendingQuestion?.isConnected){pendingQuestion=appendMessage('user',GyeoteProtocol.privacy.maskText(question,true)).article;showPending();}
        if(publicRequest){conversationContext=savedPanel.context();requestInput=await savedPanel.begin(conversationContext,requestId,requestProfile.revision);if(version!==serial)return;}
        payload=GyeoteProtocol.documentRequest({query:question,...(publicRequest?requestInput:{history:documentHistory}),profile:requestProfile.profile});
      }
      else{
        snapshot=GyeoteDOM.collect(question);source=snapshot;
        if(historyUrl!==source.url){history=[];historyUrl=source.url;}
        payload={...source.payload,question,history:history.slice(-4)};
        if(!localOrigin){delete payload.title;GyeoteProtocol.remoteScreenRequest(payload);}else GyeoteProtocol.request(payload);
      }
      busy=true;
      requestTimer=setTimeout(()=>{if(version===serial)cancel(errors.connection_failed);},10000);
      const prepared=await chrome.runtime.sendMessage({type:'gyeote:prepare',mode});if(version!==serial)return;
      if(!prepared?.ok)throw new Error(prepared?.error||'connection_failed');
      if(documentMode){
        const access=accessKey(prepared.documentAccess);
        if(access!==requestAccess)throw new Error('document_access_changed');
        // 알림이 늦어져도 이전 관리자 이력을 다른 접근 상태의 요청에 싣지 않는다.
        if(documentHistoryAccess&&documentHistoryAccess!==access){resetDocumentHistory();payload.history=[];pendingQuestion=appendMessage('user',GyeoteProtocol.privacy.maskText(question,true)).article;showPending();}
        documentHistoryAccess=access;
        if(prepared.documentAccess)showDocumentAccess(prepared.documentAccess);
      }
      budgetSeconds=GyeoteProtocol.timeoutSeconds(prepared);
      const remaining=budgetSeconds*1000-(Date.now()-startedAt);
      if(remaining<=0)throw new Error('request_stopped');
      clearTimeout(requestTimer);requestTimer=setTimeout(()=>{if(version===serial)cancel(stoppedText());},remaining);
      const followPending=atConversationEnd();requestNotice.textContent=`최대 ${budgetSeconds}초${documentMode?' · 취소해도 서버 계산은 이어질 수 있어요.':''}`;if(followPending)transcript.scrollTop=transcript.scrollHeight;
      if(includeImage){if(!prepared.imageEnabled)throw new Error('image_disabled');setStatus('입력란과 확인 불가 영역을 가린 공개 화면 한 장을 수집해 연결 서버로 전송합니다.');const captured=await capture(source,version);payload.image=captured.image;payload.partial=payload.partial||captured.partial;}
      if(version!==serial)return;
      const port=chrome.runtime.connect({name:'gyeote:guide'});requestPort=port;let finished=false;
      port.onDisconnect.addListener(()=>{if(version===serial&&requestPort===port&&!finished)cancel(errors.connection_failed);});
      port.onMessage.addListener(async packet=>{
        if(version!==serial||requestPort!==port||finished||packet.requestId!==requestId)return;
        finished=true;
        try{
          if(packet.type!=='result')throw new Error(packet.error||'invalid_reply');
          if(documentMode){
            await profilePanel.confirm(requestProfile);if(version!==serial||requestPort!==port)return;
            if(Date.now()>=startedAt+budgetSeconds*1000)throw new Error('request_stopped');
          }
          if(documentMode){
            const answer=GyeoteProtocol.documentReply(packet.body,requestInput?.conversation_context??null);removePending();pendingQuestion=null;setStatus('문서 답변입니다. 원문 근거를 함께 확인하세요.');appendDocumentAnswer(answer);
            if(publicRequest){
              clearTimeout(requestTimer);
              const saved=await savedPanel.save(conversationContext,requestId,question,answer,requestProfile.revision,()=>version===serial&&requestPort===port&&mode==='document');
              if(version===serial&&requestPort===port)setStatus(saved?'답변을 이 기기에 저장했습니다. 당시 근거의 현재 유효성은 다시 확인하지 않았습니다.'+(answer.context_update?.status==='failed'?' 요약 갱신은 실패해 제한한 최근 대화로 답변했습니다.':'')+(requestInput?.conversation_context.omitted||answer.context_update?.status==='omitted'||answer.context_usage?.omitted?' 일부 대화 맥락은 제외됐습니다.':''):'답변과 요약 후보의 저장을 확인하지 못했습니다. 아래의 저장 상태와 재시도를 확인하세요.');
              return;
            }
            // 기존 /chat은 이력을 수용하지만 현재 문서 검색·생성에는 마지막 질문만 사용한다.
            if(answer.text.length<=6000){documentHistory.push({role:'user',content:question},{role:'assistant',content:GyeoteProtocol.privacy.maskText(answer.text,true)});while(documentHistory.length>12||documentHistory.reduce((n,m)=>n+m.content.length,0)>6000)documentHistory.splice(0,2);}
            return;
          }
          const answer=GyeoteProtocol.reply(packet.body,payload);
          if(snapshot!==source||!GyeoteDOM.current(source))throw new Error('invalid_reply');
          removePending();
          apply(source,answer.targets,answer.answer);
          if(answer.targets.length&&!selected.length)throw new Error('invalid_reply');
          activeReply=appendMessage('assistant',status.textContent);activeReply.answer=answer.answer;
          history.push({role:'user',text:question},{role:'assistant',text:answer.answer});while(history.length>4||history.reduce((n,m)=>n+m.text.length,0)>1000)history.shift();
        }catch(error){if(version!==serial||requestPort!==port)return;if(documentMode&&['document_auth_required','document_access_changed'].includes(error.message)){resetDocumentHistory();void refreshDocumentAccess();}const message=error.message==='request_stopped'?stoppedText():documentMode?documentError(error.message):errors[error.message]||errors.invalid_reply;finishQuestion(message);clear(message);}
        finally{if(version===serial&&requestPort===port){removePending();clearTimeout(requestTimer);busy=false;cancelButton.hidden=true;requestNotice.hidden=true;questionForm.querySelector('button[type="submit"]').disabled=false;requestPort=null;inputAssist.update();}port.disconnect();}
      });
      port.postMessage({requestId,mode,payload,...(documentMode?{documentAccess:documentHistoryAccess,profileRevision:requestProfile.revision}:{}),...(conversationContext?{conversationContext:{revision:conversationContext.expectedRevision,generation:conversationContext.generation}}:{}),deadlineAt:startedAt+budgetSeconds*1000});delete payload.image;
    }catch(error){
      if(version!==serial)return;
      cancel(error.message.startsWith('capture_')?'탭 권한·민감 영역·화면 일치를 확인하지 못해 이미지를 전송하지 않았습니다.':error.message==='request_stopped'?stoppedText():documentMode?documentError(error.message):errors[error.message]||'현재 공개 화면을 확인하지 못했습니다. 개인정보 없는 화면에서 다시 질문하세요.');
      if(documentMode&&['document_auth_required','document_access_changed'].includes(error.message)){resetDocumentHistory();void refreshDocumentAccess();}
    }
    finally{if(version===serial){requestPending=false;inputAssist.update();}}
  }
  function documentError(code){return ({chat_rate_limited:'질문 요청이 많습니다. 잠시 기다린 뒤 직접 다시 질문해 주세요.',invalid_profile:'내 정보의 입력값을 확인한 뒤 다시 질문해 주세요.',profile_changed:'내 정보가 바뀌어 이전 답변을 표시하지 않았습니다. 확인한 뒤 다시 질문해 주세요.',profile_storage_failed:'내 정보를 확인하지 못해 질문을 보내거나 답변을 표시하지 않았습니다. 내 정보에서 다시 불러오세요.',profile_data_invalid:'저장된 내 정보를 확인하지 못했습니다. 내 정보에서 재설정을 확인해 주세요.',sensitive_input:'개인정보가 포함된 질문은 보낼 수 없습니다. 개인정보를 제외하고 다시 질문해 주세요.',document_auth_required:'관리자 세션이 없거나 만료됐습니다. Chrome 확장 옵션에서 다시 로그인하거나 익명으로 전환하세요.',document_access_changed:'문서 접근 상태가 바뀌어 이전 대화를 지웠습니다. 현재 접근 상태에서 직접 다시 질문하세요.',generation_failed:'문서 검색이나 답변 처리에 실패했습니다. 잠시 후 다시 질문해 주세요.',connection_failed:'서버에 연결하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.',request_timeout:'요청 처리 시간을 넘었습니다. 잠시 후 다시 질문해 주세요.',request_cancelled:'요청이 취소되었습니다. 다시 질문할 수 있습니다.',input_budget:'문서 질문은 300자, 대화 이력은 전체 6000자 이내여야 합니다.',invalid_reply:'문서 응답 형식을 확인하지 못해 표시하지 않았습니다.'})[code]||errors[code]||'문서 요청을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.';}
  questionForm.addEventListener('submit',event=>{event.preventDefault();inputAssist.cancel();if(busy||requestPending)return;if(mode==='document'&&!profilePanel.allowed){setStatus('내 정보를 저장하거나 나중 입력을 선택한 뒤 질문해 주세요.');return;}if(mode==='document'&&currentAccess?.mode==='anonymous'&&!savedPanel.ready){setStatus('대화 저장 상태를 확인한 뒤 다시 질문해 주세요. 대화 저장 관리에서 다시 불러올 수 있습니다.');return;}if(mode==='document'&&currentAccess?.mode==='anonymous'&&savedPanel.hasUnsaved){setStatus('미저장 답변을 보관하거나 명시적으로 버린 뒤 다음 질문을 보내세요.');return;}const input=$('#gyeote-question'),question=input.value.trim();if(question.length>input.maxLength){setStatus(`질문을 ${input.maxLength}자 이내로 수정한 뒤 전송해 주세요.`);input.focus();return;}input.value='';void ask(question);});
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
  $('.reset').addEventListener('click',()=>{if(mode==='document'&&currentAccess?.mode==='anonymous')return;cancel('새 질문을 입력하세요.');if(mode==='document')resetDocumentHistory();else{history=[];historyUrl='';}conversations[mode]=[];$('.conversation').replaceChildren();snapshot=null;});
  let drag=null;
  const head=$('.head');
  function clampPanel(left,top){
    if(panel.hidden)return;
    const rect=panel.getBoundingClientRect(),width=Math.min(rect.width,innerWidth-8),height=Math.min(rect.height,innerHeight-8);
    panel.style.left=Math.max(4,Math.min(innerWidth-width-4,left??rect.left))+'px';panel.style.top=Math.max(4,Math.min(innerHeight-height-4,top??rect.top))+'px';panel.style.right='auto';panel.style.bottom='auto';
  }
  function finishDrag(event){
    if(!drag||event&&event.pointerId!==drag.id)return;
    const id=drag.id;drag=null;
    try{if(head.hasPointerCapture(id))head.releasePointerCapture(id);}catch{}
  }
  head.addEventListener('pointerdown',event=>{
    if(drag||event.button!==0||event.isPrimary===false||event.target.closest('button'))return;
    const r=panel.getBoundingClientRect();drag={id:event.pointerId,x:event.clientX-r.left,y:event.clientY-r.top};
    try{head.setPointerCapture(event.pointerId);}catch{drag=null;}
  });
  head.addEventListener('pointermove',event=>{if(!drag||event.pointerId!==drag.id)return;clampPanel(event.clientX-drag.x,event.clientY-drag.y);schedule();});
  for(const type of ['pointerup','pointercancel','lostpointercapture'])head.addEventListener(type,finishDrag);
  const sizeObserver=typeof ResizeObserver==='function'?new ResizeObserver(()=>{clampPanel();schedule();}):null;
  sizeObserver?.observe(panel);
  addEventListener('scroll',()=>{if(capturing)pageVersion++;schedule();},{passive:true,capture:true});addEventListener('resize',()=>{finishDrag();clampPanel();pageVersion++;schedule();});
  addEventListener('pagehide',()=>{accessVersion++;finishDrag();sizeObserver?.disconnect();cancel();snapshot=null;inputAssist.dispose();profilePanel.dispose();savedPanel.dispose();});
  addEventListener('pageshow',event=>{if(event.persisted){profilePanel.resume();savedPanel.resume();inputAssist.resume();if(mode==='document')void refreshDocumentAccess();sizeObserver?.observe(panel);clampPanel();}});
  addEventListener('hashchange',()=>{if(mode==='screen')cancel('화면이 바뀌어 이전 표시를 지웠습니다.');else inputAssist.invalidate();snapshot=null;history=[];});
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){
      finishDrag();
      if(mode==='screen')cancel('탭을 떠나 이전 표시를 지웠습니다.');
      else inputAssist.cancel();
    }else inputAssist.update();
  });
  observer=new MutationObserver(records=>{
    if(!host.isConnected){if(typeof document!=='undefined'){finishDrag();sizeObserver?.disconnect();cancel();inputAssist.dispose();profilePanel.dispose();savedPanel.dispose();style.remove();observer.disconnect();}return;}
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
      accessVersion++;
      resetDocumentHistory();
      if(mode==='document'){cancel('문서 접근 상태가 바뀌어 이전 문서 요청과 대화를 지웠습니다.');snapshot=null;}
      showDocumentAccess(message.state);
      sendResponse({ok:true});return;
    }
    if(message?.type==='gyeote:toggle'){if(panel.hidden)openPanel();else closePanel();sendResponse({ok:true});}
  });
})();
