(() => {
  const errors={conversation_conflict:'다른 탭에서 상담이 바뀌었습니다. 최신 목록을 다시 불러오세요.',conversation_access_changed:'문서 접근 상태가 바뀌었습니다.',conversation_profile_changed:'내 정보가 바뀌어 답변을 저장하지 않았습니다.',conversation_request_stopped:'중지된 요청의 답변은 저장하지 않았습니다.',conversation_count_limit:'상담은 최대 30개입니다. 필요한 기록을 직접 삭제한 뒤 다시 저장하세요.',conversation_messages_limit:'상담당 100개 메시지 한도입니다. 새 상담을 시작하세요.',conversation_bytes_limit:'상담 저장 공간 4MiB 한도입니다. 필요한 기록을 직접 삭제하세요.',conversation_data_invalid:'저장된 상담의 형식을 확인하지 못했습니다. 상담 저장소만 재설정할 수 있습니다.',conversation_storage_failed:'상담 저장소에 접근하지 못했습니다. 공간과 확장 상태를 확인하세요.'};
  function create(slot,{invalidate,render,profileRevision,onStateChange=()=>{}}){
    const details=document.createElement('details'),summary=document.createElement('summary'),notice=document.createElement('p'),list=document.createElement('div'),actions=document.createElement('div'),confirmation=document.createElement('div'),unsaved=document.createElement('div');
    details.className='saved-conversations';summary.textContent='이전 상담';notice.className='muted';notice.setAttribute('role','status');list.className='saved-conversation-list';actions.className='row';confirmation.hidden=true;unsaved.hidden=true;unsaved.className='unsaved-conversation';unsaved.setAttribute('role','status');
    details.append(summary,notice,actions,list,confirmation);slot.append(details,unsaved);slot.hidden=true;
    let state=null,access=null,version=0,changing=false,pending=null,resetToken=null,notification=null,disposed=false,ownedPair=null,visibleNow=false;
    const button=(label,action)=>{const node=document.createElement('button');node.type='button';node.textContent=label;node.addEventListener('click',action);return node;};
    const reload=button('목록 다시 불러오기',()=>{invalidate();void load(true);});
    const newButton=button('새 상담',()=>void mutate('new'));
    const clearButton=button('전체 상담 삭제',()=>confirmDelete(null));
    const resetButton=button('상담 저장소 재설정',()=>confirmDelete('reset'));
    actions.append(newButton,clearButton,reload,resetButton);
    function current(){return state?.conversations.find(c=>c.id===state.lastActiveConversationId)||null;}
    function context(){
      if(!state||!access||access.mode!=='anonymous'||changing||disposed||resetToken)throw new Error('conversation_storage_failed');
      return {expectedRevision:state.revision,generation:state.generation,conversationId:state.lastActiveConversationId,accessId:access.accessId};
    }
    function matches(value){return !!state&&!!access&&access.mode==='anonymous'&&value.expectedRevision===state.revision&&value.generation===state.generation&&value.conversationId===state.lastActiveConversationId&&value.accessId===access.accessId;}
    async function send(operation,fields={}){
      const response=await chrome.runtime.sendMessage({type:'gyeote:conversations-'+operation,accessId:access?.accessId,...fields});
      if(!response?.ok){const error=new Error(response?.error||'conversation_storage_failed');error.resetToken=response?.resetToken;throw error;}
      return response;
    }
    function show(){
      list.replaceChildren();confirmation.hidden=true;resetButton.hidden=!resetToken;
      summary.textContent=`이전 상담 (${state?.conversations.length||0}/30)`;
      newButton.disabled=changing||!state;clearButton.disabled=changing||!state?.conversations.length;
      for(const conversation of [...(state?.conversations||[])].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))){
        const row=document.createElement('div');row.className='saved-conversation row';
        const select=button(conversation.title,()=>void mutate('select',{conversationId:conversation.id}));select.setAttribute('aria-pressed',String(state.lastActiveConversationId===conversation.id));select.disabled=changing;
        const time=document.createElement('small');time.textContent=new Date(conversation.updatedAt).toLocaleString('ko-KR');
        const remove=button('삭제',()=>confirmDelete(conversation.id));remove.setAttribute('aria-label',conversation.title+' 상담 삭제');remove.disabled=changing;
        row.append(select,time,remove);list.append(row);
      }
      onStateChange();
    }
    function apply(response,display=true){
      state=GyeoteConversations.record(response.state);resetToken=null;
      const latestMessage=current()?.messages.at(-1),latest=latestMessage?.contextUpdate;
      notice.textContent=response.warning?'개인정보를 가린 내용을 표시했지만 정제 결과는 저장되지 않았습니다. 다시 불러오세요.':'이 기기의 공개 상담만 저장합니다. 현재 조건·최근 대화와 제한된 누적 요약을 참고하며, 이전 근거의 현재 유효성을 보장하지 않습니다.'+(latest?.status==='failed'?' 마지막 요약 갱신은 실패했습니다.':'')+(latest?.status==='omitted'||latestMessage?.contextUsage?.omitted?' 일부 대화 맥락은 제외됐습니다.':'');
      show();if(display)render(current());if(pending)showUnsaved(new Error(pending.errorCode));
    }
    function errorNotice(error){
      if(error.resetToken)resetToken=error.resetToken;
      notice.textContent=errors[error.message]||errors.conversation_storage_failed;details.open=true;show();
    }
    async function load(display=true){
      if(!access||access.mode!=='anonymous'||disposed)return;
      const owner=++version;changing=true;show();
      try{const response=await send('get');if(owner===version){changing=false;apply(response,display);}}
      catch(error){if(owner===version){changing=false;state=null;errorNotice(error);}}
    }
    function confirmDelete(target){
      confirmation.replaceChildren();confirmation.hidden=false;
      const text=document.createElement('p');text.textContent=target==='reset'?'읽을 수 없는 상담 저장소만 비웁니다. 내 정보와 연결 설정은 유지됩니다.':target===null?'저장한 공개 상담을 모두 삭제합니다. 내 정보는 유지됩니다.':`‘${state?.conversations.find(c=>c.id===target)?.title||'선택한 상담'}’ 기록을 삭제합니다.`;
      const yes=button('삭제 확인',()=>void mutate(target==='reset'?'reset':target===null?'clear':'delete',target==='reset'?{resetToken}:{...(target===null?{}:{conversationId:target})}));
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
      const label=document.createElement('strong');label.textContent='저장되지 않은 답변';
      const reason=document.createElement('p');reason.textContent=(errors[error.message]||errors.conversation_storage_failed)+' 모델을 다시 호출하지 않고 저장을 재시도할 수 있습니다.';
      const body=document.createElement('div');body.style.whiteSpace='pre-wrap';body.textContent=pending?GyeoteProtocol.privacy.maskText(pending.question+'\n'+pending.answer.text,true):'';
      const same=pending&&matches(pending.context),target=current();
      const retry=button(same?'답변 저장 다시 시도':target?'선택한 상담에 미저장 답변 보관':'새 상담에 미저장 답변 보관',()=>void retrySave(!same));
      retry.disabled=changing||!pending||!state||pending.context.accessId!==access?.accessId||profileRevision()!==pending.profileRevision;
      const destination=document.createElement('p');destination.textContent=same?'같은 상담에 다시 저장합니다.':target?`선택한 ‘${target.title}’ 상담의 마지막에 이 질문·답변을 보관합니다. 삭제된 이전 상담은 복원하지 않습니다.`:'새 상담을 만들어 이 질문·답변을 보관합니다. 삭제된 이전 상담은 복원하지 않습니다.';
      const discard=button('미저장 답변 버리기',()=>{
        if(discard.dataset.confirmed){pending=null;unsaved.hidden=true;cancelRequest();onStateChange();return;}
        discard.dataset.confirmed='true';discard.textContent='미저장 답변 버리기 확인';
      });
      unsaved.append(label,reason,body,destination,retry,discard);
      onStateChange();
    }
    async function begin(value,pairId,revision){
      if(!matches(value))throw new Error('conversation_conflict');
      ownedPair=pairId;
      const response=await send('begin',{...value,pairId,profileRevision:revision});
      if(!matches(value)||ownedPair!==pairId)throw new Error('conversation_request_stopped');
      if(response.state.revision!==value.expectedRevision)throw new Error('conversation_conflict');
      return response.input;
    }
    async function save(value,pairId,question,answer,revision,isOwner=()=>true){
      if(!matches(value)||!isOwner()||ownedPair!==pairId)throw new Error('conversation_request_stopped');
      pending={context:value,pairId,question,answer,profileRevision:revision};
      const owner=version;changing=true;notification=null;show();
      try{
        const response=await send('append',{...value,pairId,question,answer,profileRevision:revision});
        if(owner!==version||!isOwner())return false;
        changing=false;pending=null;apply(response);unsaved.hidden=true;return true;
      }catch(error){if(owner===version&&isOwner()){changing=false;showUnsaved(error);}return false;}
      finally{if(owner===version){changing=false;show();const message=notification;notification=null;if(message)changed(message.revision,message.generation);}}
    }
    async function retrySave(rehome=false){
      const retry=pending;if(!retry||changing)return;
      try{
        if(retry.context.accessId!==access?.accessId||profileRevision()!==retry.profileRevision)throw new Error('conversation_profile_changed');
        let value=retry.context;const moved=!matches(value);
        if(!matches(value)){
          if(!rehome)throw new Error('conversation_conflict');
          if(!state?.lastActiveConversationId)await mutate('new');
          if(pending!==retry||!state?.lastActiveConversationId)return;
          value=context();
        }
        await begin(value,retry.pairId,retry.profileRevision);
        const answer={...retry.answer};if(moved)delete answer.context_update;
        await save(value,retry.pairId,retry.question,answer,retry.profileRevision);
      }catch(error){if(pending===retry)showUnsaved(error);}
    }
    function cancelRequest(){
      if(ownedPair)void chrome.runtime.sendMessage({type:'gyeote:conversation-cancel',pairId:ownedPair}).catch(()=>{});
      ownedPair=null;
    }
    function changed(revision,generation){
      if(!access||access.mode!=='anonymous'||disposed||state&&revision===state.revision&&generation===state.generation)return;
      if(changing){notification={revision,generation};return;}
      invalidate();cancelRequest();void load(true);
    }
    async function setAccess(value,visible=true){
      const same=access?.mode===value?.mode&&access?.accessId===value?.accessId;
      const becameVisible=visible&&!visibleNow;visibleNow=visible;
      slot.hidden=!visible||value?.mode!=='anonymous';
      if(same){if(visible&&!state&&!changing)await load();else if(becameVisible&&state)render(current());return;}
      version++;cancelRequest();access=value;state=null;pending=null;resetToken=null;changing=false;unsaved.hidden=true;notification=null;
      if(value?.mode==='anonymous'&&visible)await load();else show();
    }
    return {context,begin,save,changed,setAccess,cancelRequest,get state(){return state;},get ready(){return !!state&&!changing&&!resetToken;},get hasUnsaved(){return !!pending;},history:revision=>GyeoteConversations.history(current(),revision),newConversation:()=>mutate('new'),dispose(){disposed=true;version++;cancelRequest();},resume(){disposed=false;void load();}};
  }
  globalThis.GyeoteConversationPanel=Object.freeze({create});
})();
