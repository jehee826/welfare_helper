(() => {
  const key='gyeote.conversations';
  function create({storage,profile,newId}){
    let invalid=null;
    async function read(){
      const raw=(await storage.get(key))[key];
      if(raw===undefined)return {state:GyeoteConversations.empty()};
      try{return {state:GyeoteConversations.record(raw),raw};}
      catch{
        const serialized=JSON.stringify(raw);
        if(invalid?.serialized!==serialized)invalid={serialized,token:newId()};
        return {invalid:true,resetToken:invalid.token,raw};
      }
    }
    async function write(state){
      if(GyeoteConversations.bytes(state)>GyeoteConversations.limits.bytes)throw new Error('conversation_bytes_limit');
      await storage.set({[key]:state});invalid=null;return {ok:true,state};
    }
    function nextRevision(state){if(state.revision===Number.MAX_SAFE_INTEGER)throw new Error('conversation_revision_limit');return state.revision+1;}
    async function action(message,auth,ownsRequest=()=>false,requestInput=null){
      const operation=message.type.slice('gyeote:conversations-'.length);
      const fields={get:[],new:['expectedRevision','generation'],select:['expectedRevision','generation','conversationId'],delete:['expectedRevision','generation','conversationId'],clear:['expectedRevision','generation'],reset:['resetToken'],begin:['expectedRevision','generation','conversationId','pairId','profileRevision'],append:['expectedRevision','generation','conversationId','pairId','question','answer','profileRevision']};
      if(!Object.hasOwn(fields,operation)||Object.keys(message).sort().join(',')!==['type','accessId',...fields[operation]].sort().join(','))throw new Error('conversation_invalid_request');
      if(auth.mode!=='anonymous'||message.accessId!==auth.accessId)throw new Error('conversation_access_changed');
      const current=await read();
      if(operation==='reset'){
        if(!current.invalid||message.resetToken!==current.resetToken)throw new Error('conversation_conflict');
        const prior=current.raw?.revision;
        const revision=Number.isSafeInteger(prior)&&prior>=0&&prior<Number.MAX_SAFE_INTEGER?prior+1:0;
        // 새 세대는 손상된 revision을 재사용하더라도 이전 응답의 재삽입을 막는다.
        return write(GyeoteConversations.empty(newId(),revision));
      }
      if(current.invalid)return {ok:false,error:'conversation_data_invalid',resetToken:current.resetToken};
      const state=current.state;
      if(operation==='get'){
        if(current.raw&&JSON.stringify(current.raw)!==JSON.stringify(state)){
          state.revision=nextRevision(state);
          try{return await write(state);}catch{return {ok:true,state,warning:'conversation_sanitization_unsaved'};}
        }
        return {ok:true,state};
      }
      if(!Number.isSafeInteger(message.expectedRevision)||message.expectedRevision<0||typeof message.generation!=='string')throw new Error('conversation_invalid_request');
      let pair;
      if(operation==='append'||operation==='begin'){
        const savedProfile=await profile();
        if(savedProfile.invalid||!savedProfile.state.onboardingCompleted||savedProfile.state.revision!==message.profileRevision)throw new Error('conversation_profile_changed');
        if(!GyeoteProtocol.id(message.pairId)||!ownsRequest())throw new Error('conversation_request_stopped');
      }
      if(operation==='append'){
        pair=GyeoteConversations.pair(message.pairId,message.question,message.answer,message.profileRevision,new Date().toISOString());
        const existing=state.conversations.find(c=>c.messages.some(m=>m.pairId===message.pairId));
        if(existing){
          const prior=existing.messages.filter(m=>m.pairId===message.pairId);
          const comparable=messages=>JSON.stringify(messages.map(({createdAt,...value})=>value));
          if(state.generation===message.generation&&state.lastActiveConversationId===existing.id&&(message.conversationId===null||message.conversationId===existing.id)&&comparable(prior)===comparable(pair))return {ok:true,state};
          throw new Error('conversation_conflict');
        }
      }
      if(state.revision!==message.expectedRevision||state.generation!==message.generation)throw new Error('conversation_conflict');
      if(operation==='begin'){
        if(state.lastActiveConversationId!==message.conversationId)throw new Error('conversation_conflict');
        const conversation=state.conversations.find(c=>c.id===message.conversationId);
        return {ok:true,state,input:GyeoteConversations.requestContext(conversation,message.profileRevision)};
      }
      const now=new Date().toISOString();
      if(operation==='clear'){state.conversations=[];state.lastActiveConversationId=null;}
      else if(operation==='delete'){
        if(!state.conversations.some(c=>c.id===message.conversationId))throw new Error('conversation_conflict');
        state.conversations=state.conversations.filter(c=>c.id!==message.conversationId);
        if(state.lastActiveConversationId===message.conversationId)state.lastActiveConversationId=null;
      }else if(operation==='select'){
        if(!state.conversations.some(c=>c.id===message.conversationId))throw new Error('conversation_conflict');
        state.lastActiveConversationId=message.conversationId;
      }else if(operation==='new'||operation==='append'){
        if(operation==='append'&&state.lastActiveConversationId!==message.conversationId)throw new Error('conversation_conflict');
        let conversation=operation==='append'&&state.conversations.find(c=>c.id===message.conversationId);
        if(!conversation){
          if(operation==='append'&&message.conversationId!==null)throw new Error('conversation_conflict');
          if(state.conversations.length>=GyeoteConversations.limits.conversations)throw new Error('conversation_count_limit');
          conversation={id:newId(),createdAt:now,updatedAt:now,title:'새 상담',messages:[]};
          state.conversations.push(conversation);state.lastActiveConversationId=conversation.id;
        }
        if(pair){
          if(conversation.messages.length+2>GyeoteConversations.limits.messages)throw new Error('conversation_messages_limit');
          GyeoteConversations.applyUpdate(conversation,requestInput,pair[1].contextUpdate,message.profileRevision);
          conversation.messages.push(...pair);conversation.updatedAt=now;conversation.title=conversation.messages[0].content.slice(0,60);
        }
      }
      state.revision=nextRevision(state);
      if(operation==='append'&&!ownsRequest())throw new Error('conversation_request_stopped');
      return write(state);
    }
    return {action};
  }
  globalThis.GyeoteConversationStore=Object.freeze({key,create});
})();
