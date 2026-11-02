(() => {
  const initial=['내 조건에 맞는 복지서비스를 찾아줘.','지원 대상을 확인하려면 어떤 정보가 필요해?','복지서비스를 신청하려면 무엇을 확인해야 해?'];
  const followup=['그 서비스의 지원 대상을 알려줘.','그 서비스의 지원 내용을 알려줘.','그 서비스는 어떻게 신청해?'];
  const errors={'not-allowed':'마이크 권한이 거부됐습니다. 브라우저 권한을 확인하거나 직접 입력해 주세요.',
    'service-not-allowed':'브라우저가 음성 인식 서비스를 허용하지 않습니다. 직접 입력해 주세요.',
    'audio-capture':'마이크를 사용할 수 없습니다. 연결 상태를 확인하거나 직접 입력해 주세요.',
    'network':'음성 인식 서비스에 연결하지 못했습니다. 직접 입력하거나 다시 시도해 주세요.',
    'no-speech':'음성을 듣지 못했습니다. 직접 입력하거나 다시 눌러 주세요.',
    'language-not-supported':'한국어 음성 인식을 지원하지 않는 환경입니다. 직접 입력해 주세요.',
    aborted:'음성 입력이 중지됐습니다. 직접 입력하거나 다시 눌러 주세요.'};
  function create(form,{state,controls=form,overlay=null,onListening=()=>{}}){
    const input=form.querySelector('input[type=text]'),suggestions=document.createElement('div'),voice=document.createElement('details');
    suggestions.className='question-suggestions row';suggestions.setAttribute('role','group');suggestions.setAttribute('aria-label','추천 질문');
    voice.className='voice-input';
    const start=document.createElement('button'),cancel=document.createElement('button'),notice=document.createElement('p'),status=document.createElement('p');
    start.type=cancel.type='button';start.className='voice-start';cancel.className='voice-cancel';start.setAttribute('aria-label','음성 입력');start.title='음성 입력, 브라우저의 음성 인식 서비스로 전송될 수 있습니다.';start.innerHTML='<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true" focusable="false"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg>';cancel.textContent='음성 입력 취소';cancel.hidden=true;
    start.setAttribute('aria-pressed','false');notice.className=status.className='muted';status.classList.add('voice-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    notice.textContent='음성이 브라우저의 외부 인식 서비스로 전송될 수 있습니다. 민감정보는 말하지 마세요. 결과는 확인·수정 후 직접 전송하세요.';
    const summary=document.createElement('summary');summary.textContent='음성 입력 안내';
    voice.append(summary);(overlay||voice).append(notice,cancel);controls.append(voice);const row=input.closest('.compose-row');if(row)row.querySelector('[type=submit]').before(start);else input.after(start);(row||input).after(suggestions);form.append(status);
    const ctor=window.SpeechRecognition||window.webkitSpeechRecognition;
    const supported=typeof ctor==='function';
    let recognition=null,ownerKey=null,voiceVersion=0,recommendationVersion=0,viewKey='',timer=null,disposed=false;
    const support=document.createElement('p');support.className='muted';support.textContent=supported?'마이크를 누르면 최대 30초 동안 한국어를 듣습니다.':'이 브라우저는 음성 입력을 지원하지 않습니다. 입력란에 직접 입력해 주세요.';voice.append(support);if(!supported)start.title=support.textContent;
    function stop(message){
      voiceVersion++;const prior=recognition;recognition=null;ownerKey=null;clearTimeout(timer);timer=null;
      if(prior){prior.onresult=prior.onerror=prior.onend=null;try{prior.abort();}catch{}}
      if(message!==undefined)status.textContent=message;
      update();
    }
    function update(){
      if(disposed){suggestions.hidden=true;start.disabled=true;cancel.hidden=true;onListening(false);return;}
      const current=state();
      if(recognition&&(!current.available||current.blocked||ownerKey!==current.key)){
        stop('');return;
      }
      const listening=!!recognition,blocked=!current.available||current.blocked;
      start.disabled=blocked||listening||!supported;start.setAttribute('aria-pressed',String(listening));cancel.hidden=!listening;voice.setAttribute('aria-busy',String(listening));
      onListening(listening);
      suggestions.hidden=current.mode!=='document';
      const key=JSON.stringify([current.key,current.mode,current.hasHistory,blocked,listening]);
      if(key===viewKey)return;
      viewKey=key;const owner=++recommendationVersion;suggestions.replaceChildren();
      if(current.mode!=='document')return;
      for(const question of current.hasHistory?followup:initial){
        const button=document.createElement('button');button.type='button';button.textContent=question;button.disabled=blocked||listening;
        button.addEventListener('click',()=>{
          const latest=state();
          if(disposed||owner!==recommendationVersion||latest.key!==current.key||latest.mode!=='document'||!latest.available||latest.blocked||recognition)return;
          if(input.value.length){status.textContent='작성 중인 질문을 유지했습니다. 입력란을 비운 뒤 추천 질문을 선택해 주세요.';input.focus();return;}
          input.value=question;input.focus();status.textContent='추천 질문을 초안에 넣었습니다. 확인·수정 후 직접 전송하세요.';
        });
        suggestions.append(button);
      }
    }
    function begin(){
      if(disposed||recognition)return;
      const current=state();
      if(!current.available||current.blocked)return;
      if(!supported){status.textContent='이 브라우저는 음성 입력을 지원하지 않습니다. 직접 입력해 주세요.';return;}
      if(input.value.length){status.textContent='작성 중인 질문을 유지했습니다. 입력란을 비운 뒤 음성 입력을 시작해 주세요.';input.focus();return;}
      let next;
      try{next=new ctor();}catch{status.textContent='음성 입력을 시작하지 못했습니다. 직접 입력하거나 다시 눌러 주세요.';return;}
      const owner=++voiceVersion;ownerKey=current.key;recognition=next;
      const owns=()=>recognition===next&&voiceVersion===owner&&!disposed;
      next.lang='ko-KR';next.continuous=false;next.interimResults=false;next.maxAlternatives=1;
      next.onresult=event=>{
        if(!owns())return;
        const latest=state();
        if(latest.key!==current.key||!latest.available||latest.blocked){stop('입력 상태가 바뀌어 음성 결과를 적용하지 않았습니다.');return;}
        const index=Number.isInteger(event.resultIndex)&&event.resultIndex>=0?event.resultIndex:0,result=event.results?.[index];
        if(!result?.isFinal||typeof result[0]?.transcript!=='string')return;
        const text=result[0].transcript.trim();
        if(!text){stop(errors['no-speech']);return;}
        if(input.value.length){stop('작성 중인 질문을 유지하고 음성 결과는 적용하지 않았습니다.');return;}
        stop(text.length>latest.limit?`음성 초안이 ${latest.limit}자를 넘습니다. 내용을 줄인 뒤 직접 전송하세요.`:'음성 결과를 초안에 넣었습니다. 확인·수정 후 직접 전송하세요.');
        input.value=text;input.focus();
      };
      next.onerror=event=>{if(owns())stop(Object.hasOwn(errors,event.error)?errors[event.error]:'음성 인식을 완료하지 못했습니다. 직접 입력하거나 다시 시도해 주세요.');};
      next.onend=()=>{if(owns())stop(errors['no-speech']);};
      status.textContent='';
      update();timer=setTimeout(()=>{if(owns())stop('');},30000);
      try{next.start();}catch(error){if(owns())stop(error?.name==='NotAllowedError'?errors['not-allowed']:'음성 입력을 시작하지 못했습니다. 직접 입력하거나 다시 눌러 주세요.');}
    }
    function edit(){if(recognition)stop('');}
    start.addEventListener('click',begin);cancel.addEventListener('click',()=>stop(''));
    input.addEventListener('input',edit);update();
    return {update,invalidate(){recommendationVersion++;viewKey='';if(recognition)stop('');else update();},
      cancel:()=>{if(recognition)stop('');},
      dispose(){disposed=true;recommendationVersion++;stop();input.removeEventListener('input',edit);},
      resume(){disposed=false;viewKey='';input.addEventListener('input',edit);update();}};
  }
  globalThis.GyeoteInputAssist=Object.freeze({create});
})();
