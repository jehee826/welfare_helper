(() => {
  const limits=Object.freeze({conversations:1,pairs:30,messages:60,bytes:4*1024*1024,evidence:10,quote:1000,url:2048,references:50});
  const fail=()=>{throw new Error('conversation_data_invalid');};
  const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
  const revision=value=>Number.isSafeInteger(value)&&value>=0;
  const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9_.:/-]{1,256}$/.test(value);
  const blockReference=value=>typeof value==='string'&&/^[A-Za-z0-9_.$#:\/\[\]-]{1,256}$/.test(value);
  const date=value=>typeof value==='string'&&value.length<=40&&Number.isFinite(Date.parse(value));
  function cleanText(value){
    return GyeoteProtocol.privacy.maskText(value,true).replace(/<[^>]*>/g,'')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi,'[인증정보 가림]')
      .replace(/(?:password|비밀번호|api[_ -]?key|access[_ -]?token)\s*[:=：]\s*[^\s,;]+/gi,'[인증정보 가림]');
  }
  function sourceUrl(value){
    if(typeof value!=='string'||value.length>limits.url||cleanText(value)!==value)return '';
    try{
      const url=new URL(value);
      if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return '';
      if([...url.searchParams.keys()].some(key=>/token|password|secret|key|auth/i.test(key)))return '';
      const decoded=decodeURIComponent(url.pathname+url.hash);
      if(cleanText(decoded)!==decoded||/(?:token|password|secret|api_key|auth)=/i.test(decoded)||[...url.searchParams.values()].some(item=>cleanText(item)!==item))return '';
      return value;
    }catch{return '';}
  }
  function evidence(items){
    if(!Array.isArray(items))fail();
    let truncated=items.length>limits.evidence,redacted=false;
    const values=items.slice(0,limits.evidence).map(item=>{
      if(!object(item)||!identifier(item.document_id)||!identifier(item.chunk_id)||!Array.isArray(item.pages)||item.pages.some(p=>!Number.isSafeInteger(p)||p<1)||!Array.isArray(item.source_blocks)||item.source_blocks.some(b=>!blockReference(b))||typeof item.quote!=='string'||typeof item.source_url!=='string')fail();
      const quote=cleanText(item.quote).slice(0,limits.quote),source_url=sourceUrl(item.source_url);
      const shortened=item.truncated===true||item.quote.length>limits.quote||item.pages.length>limits.references||item.source_blocks.length>limits.references||!!item.context;
      const masked=item.redacted===true||cleanText(item.quote)!==item.quote||source_url!==item.source_url;
      truncated=truncated||shortened;redacted=redacted||masked;
      const metadata={};
      for(const key of ['source_organization','region_scope','basis_year','source_updated_at','valid_from','valid_until']){
        if(typeof item[key]==='string')metadata[key]=cleanText(item[key]).slice(0,300);
      }
      return {document_id:item.document_id,chunk_id:item.chunk_id,pages:item.pages.slice(0,limits.references),source_blocks:item.source_blocks.slice(0,limits.references),quote,source_url,truncated:shortened,redacted:masked,...metadata};
    });
    return {values,truncated,redacted};
  }
  const empty=(generation='initial',value=0)=>({schemaVersion:2,revision:value,generation,lastActiveConversationId:null,conversations:[]});
  const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
  function summaryRecord(value,messages){
    if(value===null)return null;
    if(!object(value)||Object.keys(value).sort().join(',')!=='coveredThroughMessageId,profileRevision,text'||typeof value.text!=='string')fail();
    const normalized=GyeoteProtocol.contextUpdate({status:'updated',...value,text:cleanText(value.text)});
    const boundary=messages.find(m=>m.id===normalized.coveredThroughMessageId);
    if(!normalized.text.trim()||!boundary||boundary.role!=='assistant'||boundary.profileRevision!==normalized.profileRevision)fail();
    return {text:normalized.text,coveredThroughMessageId:normalized.coveredThroughMessageId,profileRevision:normalized.profileRevision};
  }
  function record(raw){
    const legacy=raw?.schemaVersion===1;
    if(!object(raw)||![1,2].includes(raw.schemaVersion)||!revision(raw.revision)||!identifier(raw.generation??'initial')||!Array.isArray(raw.conversations)||raw.conversations.length>(legacy?30:limits.conversations))fail();
    const ids=new Set(),pairs=new Set();
    const conversations=raw.conversations.map(conversation=>{
      if(!object(conversation)||!identifier(conversation.id)||!legacy&&ids.has(conversation.id)||!date(conversation.createdAt)||!date(conversation.updatedAt)||!Array.isArray(conversation.messages)||conversation.messages.length>(legacy?100:limits.messages)||conversation.messages.length%2)fail();
      ids.add(conversation.id);
      const messages=conversation.messages.map((message,index)=>{
        const role=index%2?'assistant':'user';
        if(!object(message)||message.role!==role||!GyeoteProtocol.id(message.pairId)||message.id!==message.pairId+':'+role||!date(message.createdAt)||!revision(message.profileRevision)||typeof message.content!=='string'||!message.content.trim()||message.content.length>(role==='user'?300:60000))fail();
        if(role==='user'){if(!legacy&&pairs.has(message.pairId))fail();pairs.add(message.pairId);}
        else if(message.pairId!==conversation.messages[index-1].pairId||message.profileRevision!==conversation.messages[index-1].profileRevision)fail();
        const content=cleanText(message.content);
        if(!content.trim())fail();
        const value={id:message.id,pairId:message.pairId,role,content,createdAt:message.createdAt,profileRevision:message.profileRevision,redacted:message.redacted===true||content!==message.content};
        if(!legacy&&Object.hasOwn(message,'topicStart')){
          if(role!=='assistant'||typeof message.topicStart!=='boolean')fail();
          value.topicStart=message.topicStart;
        }
        if(role==='assistant'){
          if(!['answer','fallback'].includes(message.kind))fail();
          const refs=evidence(message.evidence);
          Object.assign(value,{kind:message.kind,evidence:refs.values,evidenceTruncated:message.evidenceTruncated===true||refs.truncated,redacted:value.redacted||refs.redacted});
          if(message.contacts!==undefined)value.contacts=GyeoteProtocol.documentContacts(message.contacts);
          if(!legacy&&message.contextUpdate!==undefined){
            const update=GyeoteProtocol.contextUpdate({...message.contextUpdate,text:cleanText(message.contextUpdate.text)});
            if(update.profileRevision!==message.profileRevision||update.coveredThroughMessageId!==null&&!conversation.messages.slice(0,index-1).some(m=>m.id===update.coveredThroughMessageId&&m.role==='assistant'&&m.profileRevision===message.profileRevision))fail();
            value.contextUpdate=update;
          }
          if(message.contextUsage!==undefined)value.contextUsage=GyeoteProtocol.contextUsage(message.contextUsage);
        }
        return value;
      });
      return {id:conversation.id,createdAt:conversation.createdAt,updatedAt:conversation.updatedAt,messages,...(!legacy&&conversation.summary!==undefined?{summary:summaryRecord(conversation.summary,messages)}:{})};
    });
    if(raw.lastActiveConversationId!==null&&!ids.has(raw.lastActiveConversationId))fail();
    if(!legacy&&raw.lastActiveConversationId!==(conversations[0]?.id??null))fail();
    const state={schemaVersion:raw.schemaVersion,revision:raw.revision,generation:raw.generation??'initial',lastActiveConversationId:raw.lastActiveConversationId,conversations};
    if(bytes(state)>limits.bytes)fail();
    return state;
  }
  function migrate(state,generation){
    const ordered=[];
    state.conversations.forEach((conversation,room)=>{
      for(let index=0;index<conversation.messages.length;index+=2)ordered.push({messages:conversation.messages.slice(index,index+2),room,index});
    });
    ordered.sort((a,b)=>Date.parse(a.messages[0].createdAt)-Date.parse(b.messages[0].createdAt)||a.room-b.room||a.index-b.index);
    const retained=ordered.slice(-limits.pairs),used=new Set(),reserved=new Set(retained.map(item=>item.messages[0].pairId));let replacement=0;
    const messages=retained.flatMap(item=>{
      let pairId=item.messages[0].pairId;
      if(used.has(pairId)){do{pairId=(++replacement).toString(16).toUpperCase().padStart(20,'0');}while(reserved.has(pairId)||used.has(pairId));}
      used.add(pairId);
      return item.messages.map(message=>{const value={...message,pairId,id:pairId+':'+message.role};delete value.contextUpdate;return value;});
    });
    const result=empty(generation,state.revision+1);
    if(messages.length){const id='continuous';result.conversations=[{id,createdAt:messages[0].createdAt,updatedAt:messages.at(-1).createdAt,messages}];result.lastActiveConversationId=id;}
    return record(result);
  }
  function retain(conversation){
    conversation.messages=conversation.messages.slice(-limits.messages);
    const prior=new Map();
    for(const message of conversation.messages){
      const boundary=message.contextUpdate?.coveredThroughMessageId;
      if(boundary!==undefined&&boundary!==null&&prior.get(boundary)!==message.profileRevision)delete message.contextUpdate;
      if(message.role==='assistant')prior.set(message.id,message.profileRevision);
    }
    if(conversation.summary&&(prior.get(conversation.summary.coveredThroughMessageId)!==conversation.summary.profileRevision||conversation.summary.profileRevision!==conversation.messages.at(-1)?.profileRevision))delete conversation.summary;
  }
  function retainedPair(conversation,values){
    const candidate={messages:conversation.messages.map(message=>message.pairId===values[0].pairId?values[message.role==='user'?0:1]:{...message})};
    retain(candidate);return candidate.messages.filter(message=>message.pairId===values[0].pairId);
  }
  function pair(pairId,question,answer,profileRevision,createdAt){
    if(!GyeoteProtocol.id(pairId)||!revision(profileRevision)||typeof question!=='string'||!question.trim()||question.length>300)throw new Error('conversation_invalid_request');
    const reply=GyeoteProtocol.documentReply(answer),refs=evidence(reply.evidence);
    const user=cleanText(question),assistant=cleanText(reply.text);
    if(!user.trim()||!assistant.trim())throw new Error('conversation_invalid_request');
    return [{id:pairId+':user',pairId,role:'user',content:user,createdAt,profileRevision,redacted:user!==question},
      {id:pairId+':assistant',pairId,role:'assistant',content:assistant,createdAt,profileRevision,redacted:assistant!==answer.text||refs.redacted,kind:reply.kind,evidence:refs.values,evidenceTruncated:refs.truncated,...(reply.contacts!==undefined?{contacts:reply.contacts}:{}),...(reply.context_update?{contextUpdate:reply.context_update}:{}),...(reply.context_update?.resetTopic===true?{topicStart:true}:{}),...(reply.context_usage?{contextUsage:reply.context_usage}:{})}];
  }
  function requestContext(conversation,profileRevision){
    // 화면 기록은 보존하고 마지막 새 주제의 질문부터 자동 맥락을 구성한다.
    const full=conversation?.messages||[];let topicStart=0;
    for(let i=1;i<full.length;i+=2)if(full[i].topicStart===true)topicStart=i-1;
    const all=full.slice(topicStart);let start=all.length;
    while(start>=2&&all[start-1].profileRevision===profileRevision&&all[start-2].profileRevision===profileRevision)start-=2;
    const messages=all.slice(start),stored=conversation?.summary;
    const summary=stored?.profileRevision===profileRevision&&(!topicStart||messages.some(m=>m.id===stored.coveredThroughMessageId))?stored:null;
    const through=summary?messages.findIndex(m=>m.id===summary.coveredThroughMessageId):-1;
    if(summary&&through<0)fail();
    const pending=messages.slice(through+1),batch=[];let batchSize=0;
    if(pending.length>=12){
      for(let i=0;i<Math.min(6,pending.length);i+=2){
        const pair=pending.slice(i,i+2),cost=pair.reduce((n,m)=>n+m.content.length,0);
        if(batchSize+cost>6000)break;
        batch.push(...pair.map(({id,role,content})=>({id,role,content})));batchSize+=cost;
      }
    }
    const recent=pending.slice(batch.length),result=[];let size=0;
    for(let i=recent.length-2;i>=0;i-=2){
      const pair=recent.slice(i,i+2);
      if(pair.some(message=>message.profileRevision!==profileRevision)||result.length+2>12||size+pair[0].content.length+pair[1].content.length>6000)break;
      size+=pair[0].content.length+pair[1].content.length;
      result.unshift(...pair.map(({role,content})=>({role,content})));
    }
    // 자유문 요약 대신 저장된 사용자 원문 ID를 해석하며 프로필 태그는 조건 경계로 쓰지 않는다.
    let memoIndex=-1;
    for(let i=all.length-1;i>=0;i--)if(all[i].role==='assistant'&&all[i].contextUpdate?.userMessageIds!==undefined){memoIndex=i;break;}
    const memo=memoIndex>=0?all[memoIndex].contextUpdate:null;
    const retainedIds=new Set(memo?.userMessageIds||[]);
    let sourceOmitted=!!memo&&(['omitted','failed'].includes(memo.status)||[...retainedIds].some(id=>!all.slice(0,memoIndex-1).some(m=>m.id===id&&m.role==='user')));
    const originals=all.filter(m=>m.role==='user');
    const selected=new Set();let userSize=0;
    const priority=[...originals.filter(m=>retainedIds.has(m.id)),...originals.filter(m=>!retainedIds.has(m.id)).reverse()];
    for(const message of priority){
      if(userSize+message.content.length>6000){sourceOmitted=true;continue;}
      userSize+=message.content.length;
      selected.add(message.id);
    }
    const userMessages=originals.filter(m=>selected.has(m.id)).map(({id,role,content})=>({id,role,content}));
    const references=all.at(-1)?.role==='assistant'?all.at(-1).evidence.map(e=>e.document_id):[];
    const documentIds=[...new Set(references)].slice(0,3);
    sourceOmitted=sourceOmitted||new Set(references).size>3;
    return {history:result,conversation_context:{text:summary?.text||'',coveredThroughMessageId:summary?.coveredThroughMessageId||null,profileRevision,batch,omitted:sourceOmitted,userMessages,documentIds,supportsTopicBoundary:true}};
  }
  function applyUpdate(conversation,input,update,profileRevision){
    if(!update)return;
    let normalized;
    try{
      if(!input||Object.keys(input).sort().join(',')!=='conversation_context,history'||!Array.isArray(input.history)||input.history.some(message=>!message||Object.keys(message).sort().join(',')!=='content,role'))throw new Error();
      // 세션 왕복의 객체 키 순서만 정규화하고 대화·batch 순서는 그대로 검증한다.
      normalized={history:input.history.map(({role,content})=>({role,content})),conversation_context:GyeoteProtocol.conversationContext(input.conversation_context)};
    }catch{throw new Error('conversation_context_conflict');}
    if(JSON.stringify(normalized)!==JSON.stringify(requestContext(conversation,profileRevision)))throw new Error('conversation_context_conflict');
    const checked=GyeoteProtocol.contextUpdate(update),submitted=input.conversation_context;
    if(checked.resetTopic===true&&submitted.supportsTopicBoundary!==true)throw new Error('conversation_context_conflict');
    if(checked.profileRevision!==profileRevision)throw new Error('conversation_context_conflict');
    if(checked.userMessageIds!==undefined){
      const ids=submitted.userMessages?.map(m=>m.id);
      if(!ids||checked.userMessageIds.some(id=>!ids.includes(id))||JSON.stringify(ids.filter(id=>checked.userMessageIds.includes(id)))!==JSON.stringify(checked.userMessageIds))throw new Error('conversation_context_conflict');
    }
    if(checked.status==='updated'){
      if(!submitted.batch.length||checked.coveredThroughMessageId!==submitted.batch.at(-1).id||!checked.text.trim())throw new Error('conversation_context_conflict');
      conversation.summary={text:checked.text,coveredThroughMessageId:checked.coveredThroughMessageId,profileRevision};
    }else if(checked.text!==submitted.text||checked.coveredThroughMessageId!==submitted.coveredThroughMessageId)throw new Error('conversation_context_conflict');
  }
  const history=(conversation,profileRevision)=>requestContext(conversation,profileRevision).history;
  const api=Object.freeze({limits,empty,record,migrate,retain,retainedPair,pair,history,requestContext,applyUpdate,bytes,sourceUrl});
  globalThis.GyeoteConversations=api;if(typeof module!=='undefined')module.exports=api;
})();
