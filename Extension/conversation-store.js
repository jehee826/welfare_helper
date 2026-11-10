(() => {
  const key='gyeote.conversations',summaryKey='gyeote.displaySummary';
  function create({storage,newId,now=()=>Date.now()}){
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
    async function savedSummary(state){
      try{
        const raw=(await storage.get(summaryKey))[summaryKey];
        if(raw===undefined||raw===null)return {displaySummary:null,displaySummaryRevision:0};
        const summary=GyeoteConversations.displaySummaryRecord(raw);
        return {displaySummary:summary.generation===state.generation&&summary.conversationId===state.lastActiveConversationId?summary:null,displaySummaryRevision:summary.revision};
      }catch{return {displaySummary:null,displaySummaryRevision:null};}
    }
    async function withSummary(response){return {...response,...await savedSummary(response.state)};}
    async function write(state,extra={}){
      if(GyeoteConversations.bytes(state)>GyeoteConversations.limits.bytes)throw new Error('conversation_bytes_limit');
      state=GyeoteConversations.record(state);
      await storage.set({...extra,[key]:state});invalid=null;return {ok:true,state,...(summaryKey in extra?{displaySummary:null,displaySummaryRevision:0}:{})};
    }
    function nextRevision(state){if(state.revision===Number.MAX_SAFE_INTEGER)throw new Error('conversation_revision_limit');return state.revision+1;}
    async function action(message,auth,ownsRequest=()=>false,requestInput=null,requestBoundary=null){
      const operation=message.type.slice('gyeote:conversations-'.length);
      const fields={get:[],clear:['expectedRevision','generation'],reset:['resetToken'],begin:['expectedRevision','generation','conversationId','pairId','profileRevision'],append:['expectedRevision','generation','conversationId','pairId','question','answer','profileRevision']};
      fields.resume=fields.begin;
      fields.summary=['expectedRevision','generation','conversationId'];
      fields['summary-read']=fields.summary;
      fields['summary-save']=[...fields.summary,'summaryRevision','text','partial'];
      if(!Object.hasOwn(fields,operation)||Object.keys(message).sort().join(',')!==['type','accessId',...fields[operation]].sort().join(','))throw new Error('conversation_invalid_request');
      if(auth.mode!=='anonymous'||message.accessId!==auth.accessId)throw new Error('conversation_access_changed');
      const current=await read();
      if(operation==='reset'){
        if(!current.invalid||message.resetToken!==current.resetToken)throw new Error('conversation_conflict');
        const prior=current.raw?.revision;
        const revision=Number.isSafeInteger(prior)&&prior>=0&&prior<Number.MAX_SAFE_INTEGER?prior+1:0;
        // 새 세대는 손상된 revision을 재사용하더라도 이전 응답의 재삽입을 막는다.
        return write(GyeoteConversations.empty(newId(),revision),{[summaryKey]:null});
      }
      if(current.invalid)return {ok:false,error:'conversation_data_invalid',resetToken:current.resetToken};
      let state=current.state;
      if(operation==='get'){
        if(state.schemaVersion<3){
          nextRevision(state);
          const migrated=GyeoteConversations.migrate(state,newId());
          try{return await withSummary(await write(migrated));}catch{return withSummary({ok:true,state:migrated,warning:'conversation_migration_unsaved'});}
        }
        if(current.raw&&JSON.stringify(current.raw)!==JSON.stringify(state)){
          state.revision=nextRevision(state);
          try{return await withSummary(await write(state));}catch{return withSummary({ok:true,state,warning:'conversation_sanitization_unsaved'});}
        }
        return withSummary({ok:true,state});
      }
      if(state.schemaVersion!==3)throw new Error('conversation_conflict');
      if(!Number.isSafeInteger(message.expectedRevision)||message.expectedRevision<0||typeof message.generation!=='string')throw new Error('conversation_invalid_request');
      let pair;
      if(operation==='append'||operation==='begin'||operation==='resume'){
        if(!Number.isSafeInteger(message.profileRevision)||message.profileRevision<0)throw new Error('conversation_invalid_request');
        if(!GyeoteProtocol.id(message.pairId)||!ownsRequest())throw new Error('conversation_request_stopped');
      }
      if(operation==='append'){
        pair=GyeoteConversations.pair(message.pairId,message.question,message.answer,message.profileRevision,new Date(now()).toISOString());
        const existing=state.conversations.find(c=>c.messages.some(m=>m.pairId===message.pairId));
        if(existing){
          const prior=existing.messages.filter(m=>m.pairId===message.pairId);
          pair=GyeoteConversations.retainedPair(existing,pair);
          const comparable=messages=>JSON.stringify(messages.map(({createdAt,...value})=>value));
          if(state.generation===message.generation&&state.lastActiveConversationId===existing.id&&(message.conversationId===null||message.conversationId===existing.id)&&comparable(prior)===comparable(pair))return {ok:true,state};
          throw new Error('conversation_conflict');
        }
      }
      if(state.revision!==message.expectedRevision||state.generation!==message.generation)throw new Error('conversation_conflict');
      if(operation==='summary-read'||operation==='summary-save'){
        if(state.lastActiveConversationId!==message.conversationId)throw new Error('conversation_conflict');
        const previous=await savedSummary(state);
        if(operation==='summary-read')return {ok:true,...previous};
        if(previous.displaySummaryRevision===null)throw new Error('conversation_summary_invalid');
        if(message.summaryRevision!==previous.displaySummaryRevision)throw new Error('conversation_summary_conflict');
        if(previous.displaySummaryRevision===Number.MAX_SAFE_INTEGER)throw new Error('conversation_revision_limit');
        if(!state.conversations[0]?.messages.length)throw new Error('conversation_conflict');
        let summary;
        try{summary=GyeoteConversations.displaySummaryRecord({schemaVersion:1,revision:previous.displaySummaryRevision+1,generation:state.generation,conversationId:state.lastActiveConversationId,text:message.text,partial:message.partial});}
        catch{throw new Error('conversation_summary_invalid');}
        await storage.set({[summaryKey]:summary});
        return {ok:true,state,displaySummary:summary,displaySummaryRevision:summary.revision};
      }
      if(operation==='summary'){
        if(state.lastActiveConversationId!==message.conversationId)throw new Error('conversation_conflict');
        const conversation=state.conversations[0];
        return {ok:true,state,input:GyeoteConversations.summaryInput(conversation),...await savedSummary(state)};
      }
      if(operation==='resume'){
        const conversation=state.conversations[0];
        if(state.lastActiveConversationId!==message.conversationId||!conversation||conversation.contextBoundary.startedAt!==requestBoundary)throw new Error('conversation_context_conflict');
        return {ok:true,state,input:GyeoteConversations.requestContext(conversation,message.profileRevision)};
      }
      if(operation==='begin'){
        if(state.lastActiveConversationId!==message.conversationId)throw new Error('conversation_conflict');
        const timestamp=now(),submittedAt=new Date(timestamp).toISOString();
        let conversation=state.conversations[0];
        if(!conversation){
          conversation={id:newId(),createdAt:submittedAt,updatedAt:submittedAt,messages:[],contextBoundary:{startedAt:submittedAt,startAfterPairId:null,lastUserSubmittedAt:null}};
          state.conversations.push(conversation);state.lastActiveConversationId=conversation.id;
        }
        const boundary=conversation.contextBoundary,last=Date.parse(boundary.lastUserSubmittedAt);
        if(!Number.isFinite(last)||last>timestamp||timestamp-last>=GyeoteConversations.limits.contextAge){
          conversation.contextBoundary={startedAt:submittedAt,startAfterPairId:conversation.messages.at(-1)?.pairId??null,lastUserSubmittedAt:submittedAt};
        }else boundary.lastUserSubmittedAt=submittedAt;
        state.revision=nextRevision(state);
        if(!ownsRequest())throw new Error('conversation_request_stopped');
        const result=await write(state);
        return {...result,input:GyeoteConversations.requestContext(conversation,message.profileRevision)};
      }
      const updatedAt=new Date(now()).toISOString();
      if(operation==='clear'){state.conversations=[];state.lastActiveConversationId=null;state.generation=newId();}
      else if(operation==='append'){
        if(state.lastActiveConversationId!==message.conversationId)throw new Error('conversation_conflict');
        let conversation=state.conversations[0];
        if(!conversation){
          if(message.conversationId!==null)throw new Error('conversation_conflict');
          conversation={id:newId(),createdAt:updatedAt,updatedAt:updatedAt,messages:[],contextBoundary:{startedAt:updatedAt,startAfterPairId:null,lastUserSubmittedAt:updatedAt}};
          state.conversations.push(conversation);state.lastActiveConversationId=conversation.id;
        }
        if(pair){
          GyeoteConversations.applyUpdate(conversation,requestInput,pair[1].contextUpdate,message.profileRevision);
          conversation.messages.push(...pair);conversation.updatedAt=updatedAt;GyeoteConversations.retain(conversation);
        }
      }
      state.revision=nextRevision(state);
      if(operation==='append'&&!ownsRequest())throw new Error('conversation_request_stopped');
      return write(state,operation==='clear'?{[summaryKey]:null}:{});
    }
    async function prepareContextReset(){
      const current=await read();if(current.invalid)throw new Error('conversation_data_invalid');
      let state=current.state;
      if(state.schemaVersion<3)state=GyeoteConversations.migrate(state,newId());
      state.revision=nextRevision(state);
      const conversation=state.conversations[0];
      if(conversation)conversation.contextBoundary={startedAt:new Date(now()).toISOString(),startAfterPairId:conversation.messages.at(-1)?.pairId??null,lastUserSubmittedAt:conversation.contextBoundary.lastUserSubmittedAt};
      return GyeoteConversations.record(state);
    }
    return {action,prepareContextReset};
  }
  globalThis.GyeoteConversationStore=Object.freeze({key,summaryKey,create});
})();
