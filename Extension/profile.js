(() => {
  const errors={profile_conflict:'다른 탭에서 내 정보가 바뀌었습니다. 최신 정보를 불러온 뒤 다시 저장하세요.',profile_data_invalid:'저장된 정보를 읽을 수 없습니다. 기존 자료는 지우지 않았습니다. 재설정하려면 아래 버튼을 선택하세요.',profile_revision_limit:'저장 버전의 한도에 도달했습니다. 기존 정보는 유지했습니다.',invalid_profile:'입력한 조건을 확인하세요. 나이는 0~120의 정수로 입력할 수 있습니다.',profile_storage_failed:'내 정보를 저장하거나 읽지 못했습니다. 저장 공간과 확장 상태를 확인한 뒤 다시 시도하세요.'};
  function create(container,onInvalidate,onViewChange){
    let state=null,editing=false,busy=false,serial=0,pendingChange=false,resetToken=null,disposed=false;
    const section=document.createElement('section');section.className='profile-panel';section.setAttribute('aria-label','내 정보');container.append(section);
    const style=document.createElement('style');style.textContent='.profile-panel{margin:12px 0;padding:10px;border:1px solid #ddd;border-radius:10px}.profile-panel[hidden],.consultation form[hidden]{display:none}.profile-panel form{display:grid;gap:9px}.profile-panel label{display:grid;gap:4px}.profile-panel input,.profile-panel select{box-sizing:border-box;max-width:100%;width:100%;padding:8px;border:1px solid #bbb;border-radius:7px}.profile-panel .profile-error{color:#8b2020}.profile-panel h2{font-size:17px;margin:0}.profile-panel button{white-space:normal}';section.before(style);
    const node=(tag,text)=>{const result=document.createElement(tag);if(text)result.textContent=text;return result;};
    const button=(text,action)=>{const result=node('button',text);result.type='button';result.addEventListener('click',action);return result;};
    function alert(code){
      const error=section.querySelector('.profile-error');if(!error)return;
      error.textContent=errors[code]||errors.profile_storage_failed;error.tabIndex=-1;error.focus();
      const reload=section.querySelector('.profile-reload');if(reload)reload.hidden=false;
    }
    function lock(value){busy=value;section.setAttribute('aria-busy',String(value));for(const control of section.querySelectorAll('button,input,select'))control.disabled=value;onViewChange();}
    async function get(){
      const response=await chrome.runtime.sendMessage({type:'gyeote:profile-get'});
      if(!response?.ok){resetToken=typeof response?.resetToken==='string'?response.resetToken:null;throw new Error(response?.error||'profile_storage_failed');}
      resetToken=null;return GyeoteProtocol.profileRecord(response.state);
    }
    function render(){
      section.replaceChildren(node('h2',editing?'내 정보 입력':'내 정보'));
      const notice=node('p','입력은 선택입니다. 이 브라우저에 저장하고 문서 질문과 함께 보냅니다. 입력한 조건을 상담에 참고합니다. 최종 지원 자격은 담당 기관에서 확인해 주세요.');notice.className='muted';section.append(notice);
      const storageNotice=node('p','같은 브라우저를 공유하면 정보도 공유됩니다. 확장을 지우거나 저장소를 삭제하면 복구되지 않습니다. 아래에서 내 정보를 삭제할 수 있습니다.');storageNotice.className='muted';section.append(storageNotice);
      const error=node('p');error.className='profile-error';error.setAttribute('role','alert');section.append(error);
      const reload=button('최신 정보 다시 불러오기',()=>void refresh());reload.className='profile-reload';reload.hidden=true;section.append(reload);
      if(!state){
        alert(resetToken?'profile_data_invalid':'profile_storage_failed');reload.hidden=false;
        if(resetToken)section.append(button('손상된 내 정보 재설정',()=>void mutate('reset')));
        onViewChange();return;
      }
      if(!editing){
        const value=state.profile;
        section.append(node('p',value?`나이: ${value.age===null?'모름':value.age+'세'} · 소득: ${incomeLabel(value.income)} · 가구: ${householdLabel(value.household)} · 지역: ${value.region||'모름'} · 장애 여부: ${value.disability===null?'모름':value.disability?'있음':'없음'}`:'저장한 조건이 없습니다. 나중에 입력할 수 있습니다.'));
        section.append(button('내 정보 수정',()=>{onInvalidate();editing=true;render();section.querySelector('input')?.focus();}),button('내 정보 삭제',()=>void mutate('clear')));
        onViewChange();return;
      }
      const form=node('form');form.noValidate=true;
      const value=state.profile;
      const age=node('input');age.name='age';age.type='number';age.min='0';age.max='120';age.step='1';age.autocomplete='off';age.value=value?.age===null||value?.age===undefined?'':String(value.age);age.placeholder='모르면 비워 두세요';
      const field=(title,control)=>{const label=node('label',title);label.append(control);form.append(label);};
      const select=(name,items,selected)=>{const control=node('select');control.name=name;for(const [key,label] of items){const option=node('option',label);option.value=key;control.append(option);}control.value=selected??'';return control;};
      field('나이',age);
      const income=select('income',[['unknown','모름'],['under50','기준중위소득 50% 이하'],['under100','기준중위소득 50~100%'],['under150','기준중위소득 100~150%'],['over150','기준중위소득 150% 초과']],value?.income||'unknown');field('소득 구간',income);
      const household=select('household',[['','모름'],['single','혼자 살아요'],['couple','부부'],['withChildren','자녀가 있어요'],['singleParent','한부모 가정'],['grandparent','조부모와 손자녀'],['other','기타']],value?.household);field('가구 형태',household);
      const region=select('region',[['','모름'],...GyeoteProtocol.regions.map(name=>[name,name])],value?.region);field('사는 지역',region);
      const disability=select('disability',[['','모름'],['true','있음'],['false','없음']],value?.disability===null||value?.disability===undefined?'':String(value.disability));field('장애 여부 (선택)',disability);
      const save=node('button','내 정보 저장');save.type='submit';form.append(save);
      form.append(state.onboardingCompleted?button('수정 취소',()=>{editing=false;render();}):button('나중에 입력',()=>void mutate('save',null)));
      if(state.onboardingCompleted)form.append(button('내 정보 삭제',()=>void mutate('clear')));
      form.addEventListener('submit',event=>{
        event.preventDefault();if(busy)return;
        try{
          if(age.validity.badInput)throw new Error('invalid_profile');
          const normalized=GyeoteProtocol.profile({age:age.value.trim()===''?null:Number(age.value),income:income.value,household:household.value||null,region:region.value||null,disability:disability.value===''?null:disability.value==='true'});
          void mutate('save',normalized);
        }catch{alert('invalid_profile');age.focus();}
      });
      section.append(form);onViewChange();
    }
    async function refresh(){
      if(busy||disposed)return;
      const owner=++serial;
      section.textContent='내 정보 확인 중…';
      state=null;editing=false;onViewChange();
      try{const latest=await get();if(owner!==serial)return;state=latest;editing=!latest.onboardingCompleted;render();}
      catch(error){if(owner!==serial)return;state=null;render();alert(error.message);}
    }
    async function mutate(action,profile){
      if(busy||disposed)return;
      const owner=++serial,expectedRevision=state?.revision;
      onInvalidate();lock(true);
      let success=false;
      try{
        const response=await chrome.runtime.sendMessage(action==='reset'?{type:'gyeote:profile-reset',resetToken}:{type:'gyeote:profile-'+action,expectedRevision,...(action==='save'?{profile}:{})});
        if(owner!==serial)return;
        if(!response?.ok)throw new Error(response?.error||'profile_storage_failed');
        state=GyeoteProtocol.profileRecord(response.state);editing=!state.onboardingCompleted;success=true;render();
      }catch(error){if(owner===serial)alert(error.message);}
      finally{
        if(owner===serial){lock(false);const changed=pendingChange;pendingChange=false;if(success&&changed)void refresh();}
      }
    }
    function changed(revision){
      if(disposed)return;
      if(state&&Number.isSafeInteger(revision)&&revision===state.revision)return;
      onInvalidate();
      if(busy){pendingChange=true;return;}
      if(editing&&state){alert('profile_conflict');return;}
      void refresh();
    }
    async function confirm(expected){
      if(disposed)throw new Error('profile_changed');
      let latest;
      try{latest=await get();}catch(error){if(!disposed){alert(error.message);if(resetToken)changed();}throw error;}
      if(disposed)throw new Error('profile_changed');
      if(JSON.stringify(latest)!==JSON.stringify(expected)){changed();throw new Error('profile_changed');}
      return latest;
    }
    const ready=Promise.resolve().then(refresh);
    return {get state(){return state;},get allowed(){return !!state?.onboardingCompleted&&!editing&&!busy&&!disposed;},ready,changed,confirm,setVisible:visible=>section.hidden=!visible,dispose:()=>{disposed=true;serial++;},resume:()=>{disposed=false;void refresh();}};
  }
  function incomeLabel(value){return ({unknown:'모름',under50:'50% 이하',under100:'50~100%',under150:'100~150%',over150:'150% 초과'})[value];}
  function householdLabel(value){return ({single:'혼자 살아요',couple:'부부',withChildren:'자녀 있음',singleParent:'한부모 가정',grandparent:'조부모와 손자녀',other:'기타'})[value]||'모름';}
  globalThis.GyeoteProfilePanel=Object.freeze({create});
})();
