(() => {
  const errors={conversation_conflict:'다른 탭에서 대화가 바뀌었습니다. 최신 대화를 다시 불러오세요.',conversation_access_changed:'문서 접근 상태가 바뀌었습니다.',conversation_profile_changed:'내 정보가 바뀌어 답변을 저장하지 않았습니다.',conversation_request_stopped:'중지된 요청의 답변은 저장하지 않았습니다.',conversation_bytes_limit:'대화 저장 공간 4MiB 한도입니다. 공간을 확인한 뒤 다시 저장하세요.',conversation_data_invalid:'저장된 대화의 형식을 확인하지 못했습니다. 원본은 유지했습니다.',conversation_storage_failed:'대화 저장소에 접근하지 못했습니다. 공간과 확장 상태를 확인하세요.'};
  errors.conversation_save_timeout='10초 안에 저장 완료를 확인하지 못했습니다. 대화를 다시 불러와 저장 여부를 확인하세요.';
  errors.conversation_context_conflict='요청 당시 대화 맥락과 현재 기록이 달라 자동 저장하지 않았습니다.';
  function create(slot,{invalidate,render,onStateChange=()=>{},alerts=slot,onError=()=>{}}){
    const details=document.createElement('details'),summary=document.createElement('summary'),notice=document.createElement('p'),actions=document.createElement('div'),confirmation=document.createElement('div'),unsaved=document.createElement('div');
    details.className='conversation-settings';summary.textContent='대화 저장 관리';notice.className='muted';notice.setAttribute('role','status');actions.className='row';confirmation.hidden=true;unsaved.hidden=true;unsaved.className='unsaved-conversation';unsaved.setAttribute('role','status');
    const warning=document.createElement('p');warning.className='conversation-warning';warning.setAttribute('role','status');
    details.append(summary,notice,actions,confirmation);slot.append(details);alerts.append(warning,unsaved);slot.hidden=true;
    let state=null,access=null,version=0,changing=false,pending=null,resetToken=null,notification=null,disposed=false,ownedPair=null,visibleNow=false,readOnly=false;
    const button=(label,action)=>{const node=document.createElement('button');node.type='button';node.textContent=label;node.addEventListener('click',action);return node;};
    const reload=button('대화 다시 불러오기',()=>{invalidate();void load(true);});
    const clearButton=button('전체 대화 삭제',()=>confirmDelete(null));
    const resetButton=button('대화 저장소 재설정',()=>confirmDelete('reset'));
    actions.append(clearButton,reload,resetButton);
    function current(){return state?.conversations.find(c=>c.id===state.lastActiveConversationId)||null;}
    function context(){
      if(!state||!access||access.mode!=='anonymous'||changing||disposed||resetToken||readOnly)throw new Error('conversation_storage_failed');
      // 기존 기록의 태그를 이어 쓰되 현재 저장 프로필과는 비교하지 않는다.
      return {expectedRevision:state.revision,generation:state.generation,conversationId:state.lastActiveConversationId,accessId:access.accessId,profileRevision:current()?.messages.at(-1)?.profileRevision??0};
    }
    function matches(value){return !!state&&!!access&&access.mode==='anonymous'&&value.expectedRevision===state.revision&&value.generation===state.generation&&value.conversationId===state.lastActiveConversationId&&value.accessId===access.accessId;}
    async function send(operation,fields={}){
      const response=await chrome.runtime.sendMessage({type:'gyeote:conversations-'+operation,accessId:access?.accessId,...fields});
      if(!response?.ok){const error=new Error(response?.error||'conversation_storage_failed');error.resetToken=response?.resetToken;throw error;}
      return response;
    }
    function show(){
      confirmation.hidden=true;resetButton.hidden=!resetToken;
      clearButton.disabled=changing||readOnly||!current()?.messages.length;reload.disabled=changing;resetButton.disabled=changing;
      onStateChange();
    }
    function apply(response,display=true){
      state=GyeoteConversations.record(response.state);resetToken=null;readOnly=!!response.warning;
      if(pending?.errorCode==='conversation_save_timeout'){
        const container=state.conversations.find(conversation=>conversation.messages.some(message=>message.pairId===pending.pairId)),stored=container?.messages.filter(message=>message.pairId===pending.pairId)||[];
        // 저장소에서 질문·답변·근거·요약 후보까지 일치할 때만 확인 대기를 해제한다.
        if(stored.length===2&&JSON.stringify(stored)===JSON.stringify(GyeoteConversations.retainedPair(container,GyeoteConversations.pair(pending.pairId,pending.question,pending.answer,pending.profileRevision,stored[0].createdAt)))){pending=null;unsaved.hidden=true;}
      }
      const latestMessage=current()?.messages.at(-1),latest=latestMessage?.contextUpdate;
      const failed=response.warning==='conversation_migration_unsaved'?'이전 대화 이관을 저장하지 못했습니다. 원본은 유지했습니다. 대화 저장 관리에서 다시 불러오세요.':response.warning?'개인정보 정제 결과를 저장하지 못했습니다. 원본은 유지했습니다. 다시 불러오세요.':'';
      notice.textContent=failed||'이 기기의 공개 대화만 저장합니다. 최근 대화와 제한된 요약을 참고하며, 이전 근거의 현재 유효성을 보장하지 않습니다.';
      warning.textContent=failed||(latest?.status==='failed'?'마지막 요약 갱신에 실패했습니다.':latest?.status==='omitted'||latestMessage?.contextUsage?.omitted?'일부 대화 맥락은 제외됐습니다.':'');
      if(failed){details.open=true;onError();}
      show();if(display)render(current());if(pending)showUnsaved(new Error(pending.errorCode));
    }
    function errorNotice(error){
      if(error.resetToken)resetToken=error.resetToken;
      notice.textContent=errors[error.message]||errors.conversation_storage_failed;warning.textContent=notice.textContent;details.open=true;onError();show();
    }
    async function load(display=true){
      if(!access||access.mode!=='anonymous'||disposed)return;
      const owner=++version;changing=true;show();
      try{
        const response=await send('get');
        if(owner===version){
          changing=false;apply(response,display);
        }
      }
      catch(error){if(owner===version){changing=false;state=null;errorNotice(error);}}
    }
    function confirmDelete(target){
      confirmation.replaceChildren();confirmation.hidden=false;
      const text=document.createElement('p');text.textContent=target==='reset'?'읽을 수 없는 대화 저장소만 비웁니다. 내 정보와 연결 설정은 유지됩니다.':'저장한 공개 대화를 모두 삭제합니다. 내 정보는 유지됩니다.';
      const yes=button('삭제 확인',()=>void mutate(target==='reset'?'reset':'clear',target==='reset'?{resetToken}:{}));
      confirmation.append(text,yes,button('취소',()=>{confirmation.hidden=true;}));yes.focus();
    }
    async function mutate(operation,fields={}){
      if(changing||disposed)return;
      let expected;
      try{expected=operation==='reset'?{}:context();}catch(error){errorNotice(error);return;}
      invalidate();changing=true;notification=null;const owner=++version;show();
      try{
        const response=await send(operation,{...(operation==='reset'?{}:{expectedRevision:expected.expectedRevision,generation:expected.generation}),...fields});
        if(owner===version){changing=false;apply(response);}
      }catch(error){if(owner===version){changing=false;errorNotice(error);if(error.message==='conversation_conflict')await load(true);}}
      finally{if(owner===version){changing=false;show();if(pending)showUnsaved(new Error(pending.errorCode));const message=notification;notification=null;if(message)changed(message.revision,message.generation);}}
    }
    function showUnsaved(error){
      if(pending)pending.errorCode=error.message;
      unsaved.replaceChildren();unsaved.hidden=false;
      const label=document.createElement('strong');label.textContent=error.message==='conversation_save_timeout'?'저장 확인이 필요한 답변':'저장되지 않은 답변';
      const reason=document.createElement('p');reason.textContent=(errors[error.message]||errors.conversation_storage_failed)+' 모델을 다시 호출하지 않고 저장을 재시도할 수 있습니다.';
      const body=document.createElement('div');body.style.whiteSpace='pre-wrap';body.textContent=pending?GyeoteProtocol.privacy.maskText(pending.question+'\n'+pending.answer.text,true):'';
      const retry=button('답변 저장 다시 시도',()=>void retrySave());
      retry.disabled=changing||readOnly||!pending||!state||pending.context.accessId!==access?.accessId||pending.context.generation!==state.generation;
      const destination=document.createElement('p');destination.textContent='현재 대화의 마지막에 저장합니다. 기록 삭제 후에는 이전 답변을 다시 삽입하지 않습니다.';
      const discard=button('미저장 답변 버리기',()=>{
        if(discard.dataset.confirmed){pending=null;unsaved.hidden=true;cancelRequest();onStateChange();return;}
        discard.dataset.confirmed='true';discard.textContent='미저장 답변 버리기 확인';
      });
      unsaved.append(label,reason,body,destination,retry,discard);
      onStateChange();
    }
    async function begin(value,pairId,revision,resume=false){
      if(!matches(value))throw new Error('conversation_conflict');
      ownedPair=pairId;changing=true;notification=null;const owner=version;show();
      try{
        const response=await send(resume?'resume':'begin',{...value,pairId,profileRevision:revision});
        if(owner!==version||!matches(value)||ownedPair!==pairId)throw new Error('conversation_request_stopped');
        if(response.state.revision!==value.expectedRevision+(resume?0:1))throw new Error('conversation_conflict');
        changing=false;apply(response,false);
        Object.assign(value,{expectedRevision:state.revision,conversationId:state.lastActiveConversationId});
        return response.input;
      }finally{if(owner===version){changing=false;show();const message=notification;notification=null;if(message)changed(message.revision,message.generation);}}
    }
    async function save(value,pairId,question,answer,revision,isOwner=()=>true){
      if(!matches(value)||!isOwner()||ownedPair!==pairId)throw new Error('conversation_request_stopped');
      pending={context:value,pairId,question,answer,profileRevision:revision};
      const owner=version;let timer;changing=true;notification=null;show();
      try{
        // 저장 확인만 제한하며 늦게 끝난 응답은 현재 화면에 적용하지 않는다.
        const response=await Promise.race([
          send('append',{...value,pairId,question,answer,profileRevision:revision}),
          new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('conversation_save_timeout')),10000);}),
        ]);
        if(owner!==version||!isOwner())return false;
        changing=false;pending=null;apply(response);unsaved.hidden=true;return true;
      }catch(error){if(owner===version&&isOwner()){changing=false;showUnsaved(error);}return false;}
      finally{clearTimeout(timer);if(owner===version){changing=false;show();const message=notification;notification=null;if(message)changed(message.revision,message.generation);}}
    }
    async function retrySave(){
      const retry=pending;if(!retry||changing)return;
      try{
        if(retry.context.accessId!==access?.accessId)throw new Error('conversation_access_changed');
        let value=retry.context;const moved=!matches(value);
        if(!matches(value)){
          if(retry.context.generation!==state?.generation)throw new Error('conversation_context_conflict');
          value=context();
        }
        await begin(value,retry.pairId,retry.profileRevision,true);
        const answer={...retry.answer};if(moved)delete answer.context_update;
        await save(value,retry.pairId,retry.question,answer,retry.profileRevision);
      }catch(error){if(pending===retry)showUnsaved(error);}
    }
    function cancelRequest(){
      if(ownedPair)void chrome.runtime.sendMessage({type:'gyeote:conversation-cancel',pairId:ownedPair}).catch(()=>{});
      ownedPair=null;
    }
    function changed(revision,generation){
      if(!access||access.mode!=='anonymous'||disposed||state&&Number.isSafeInteger(revision)&&revision<=state.revision&&generation===state.generation)return;
      if(changing){notification={revision,generation};return;}
      invalidate();cancelRequest();void load(true);
    }
    async function setAccess(value,visible=true){
      const same=access?.mode===value?.mode&&access?.accessId===value?.accessId;
      const becameVisible=visible&&!visibleNow;visibleNow=visible;
      slot.hidden=!visible||value?.mode!=='anonymous';
      if(alerts!==slot)alerts.hidden=slot.hidden;
      if(same){if(visible&&!state&&!changing)await load();else if(becameVisible&&state)render(current());return;}
      version++;cancelRequest();access=value;state=null;pending=null;resetToken=null;changing=false;unsaved.hidden=true;warning.textContent='';notification=null;readOnly=false;
      if(value?.mode==='anonymous'&&visible)await load();else show();
    }
    return {context,begin,save,changed,setAccess,cancelRequest,get state(){return state;},get ready(){return !!state&&!changing&&!resetToken&&!readOnly;},get hasUnsaved(){return !!pending;},history:revision=>GyeoteConversations.history(current(),revision),dispose(){disposed=true;version++;cancelRequest();},resume(){disposed=false;void load();}};
  }
  globalThis.GyeoteConversationPanel=Object.freeze({create});
})();
