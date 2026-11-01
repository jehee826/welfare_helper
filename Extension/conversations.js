(() => {
  const limits=Object.freeze({conversations:30,messages:100,bytes:4*1024*1024,evidence:10,quote:1000,url:2048,references:50});
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
      return {document_id:item.document_id,chunk_id:item.chunk_id,pages:item.pages.slice(0,limits.references),source_blocks:item.source_blocks.slice(0,limits.references),quote,source_url,truncated:shortened,redacted:masked};
    });
    return {values,truncated,redacted};
  }
  const empty=(generation='initial',value=0)=>({schemaVersion:1,revision:value,generation,lastActiveConversationId:null,conversations:[]});
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
    if(!object(raw)||raw.schemaVersion!==1||!revision(raw.revision)||!identifier(raw.generation??'initial')||!Array.isArray(raw.conversations)||raw.conversations.length>limits.conversations)fail();
    const ids=new Set(),pairs=new Set();
    const conversations=raw.conversations.map(conversation=>{
      if(!object(conversation)||!identifier(conversation.id)||ids.has(conversation.id)||!date(conversation.createdAt)||!date(conversation.updatedAt)||!Array.isArray(conversation.messages)||conversation.messages.length>limits.messages||conversation.messages.length%2)fail();
      ids.add(conversation.id);
      const messages=conversation.messages.map((message,index)=>{
        const role=index%2?'assistant':'user';
        if(!object(message)||message.role!==role||!GyeoteProtocol.id(message.pairId)||message.id!==message.pairId+':'+role||!date(message.createdAt)||!revision(message.profileRevision)||typeof message.content!=='string'||!message.content.trim()||message.content.length>(role==='user'?300:60000))fail();
        if(role==='user'){if(pairs.has(message.pairId))fail();pairs.add(message.pairId);}
        else if(message.pairId!==conversation.messages[index-1].pairId||message.profileRevision!==conversation.messages[index-1].profileRevision)fail();
        const content=cleanText(message.content);
        if(!content.trim())fail();
        const value={id:message.id,pairId:message.pairId,role,content,createdAt:message.createdAt,profileRevision:message.profileRevision,redacted:message.redacted===true||content!==message.content};
        if(role==='assistant'){
          if(!['answer','fallback'].includes(message.kind))fail();
          const refs=evidence(message.evidence);
          Object.assign(value,{kind:message.kind,evidence:refs.values,evidenceTruncated:message.evidenceTruncated===true||refs.truncated,redacted:value.redacted||refs.redacted});
          if(message.contextUpdate!==undefined){
            const update=GyeoteProtocol.contextUpdate({...message.contextUpdate,text:cleanText(message.contextUpdate.text)});
            if(update.profileRevision!==message.profileRevision||update.coveredThroughMessageId!==null&&!conversation.messages.slice(0,index-1).some(m=>m.id===update.coveredThroughMessageId&&m.role==='assistant'&&m.profileRevision===message.profileRevision))fail();
            value.contextUpdate=update;
          }
          if(message.contextUsage!==undefined)value.contextUsage=GyeoteProtocol.contextUsage(message.contextUsage);
        }
        return value;
      });
      return {id:conversation.id,createdAt:conversation.createdAt,updatedAt:conversation.updatedAt,title:messages[0]?.content.slice(0,60)||'새 상담',messages,...(conversation.summary===undefined?{}:{summary:summaryRecord(conversation.summary,messages)})};
    });
    if(raw.lastActiveConversationId!==null&&!ids.has(raw.lastActiveConversationId))fail();
    const state={schemaVersion:1,revision:raw.revision,generation:raw.generation??'initial',lastActiveConversationId:raw.lastActiveConversationId,conversations};
    if(bytes(state)>limits.bytes)fail();
    return state;
  }
  function pair(pairId,question,answer,profileRevision,createdAt){
    if(!GyeoteProtocol.id(pairId)||!revision(profileRevision)||typeof question!=='string'||!question.trim()||question.length>300)throw new Error('conversation_invalid_request');
    const reply=GyeoteProtocol.documentReply(answer),refs=evidence(reply.evidence);
    const user=cleanText(question),assistant=cleanText(reply.text);
    if(!user.trim()||!assistant.trim())throw new Error('conversation_invalid_request');
    return [{id:pairId+':user',pairId,role:'user',content:user,createdAt,profileRevision,redacted:user!==question},
      {id:pairId+':assistant',pairId,role:'assistant',content:assistant,createdAt,profileRevision,redacted:assistant!==answer.text||refs.redacted,kind:reply.kind,evidence:refs.values,evidenceTruncated:refs.truncated,...(reply.context_update?{contextUpdate:reply.context_update}:{}),...(reply.context_usage?{contextUsage:reply.context_usage}:{})}];
  }
  function requestContext(conversation,profileRevision){
    const all=conversation?.messages||[];let start=all.length;
    while(start>=2&&all[start-1].profileRevision===profileRevision&&all[start-2].profileRevision===profileRevision)start-=2;
    const messages=all.slice(start),stored=conversation?.summary;
    const summary=stored?.profileRevision===profileRevision?stored:null;
    const through=summary?messages.findIndex(m=>m.id===summary.coveredThroughMessageId):-1;
    if(summary&&through<0)fail();
    const pending=messages.slice(through+1),batch=[];let batchSize=0,omitted=false;
    if(pending.length>=12){
      for(let i=0;i<Math.min(6,pending.length);i+=2){
        const pair=pending.slice(i,i+2),cost=pair.reduce((n,m)=>n+m.content.length,0);
        if(batchSize+cost>6000){omitted=true;break;}
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
    omitted=omitted||result.length<recent.length;
    return {history:result,conversation_context:{text:summary?.text||'',coveredThroughMessageId:summary?.coveredThroughMessageId||null,profileRevision,batch,omitted}};
  }
  function applyUpdate(conversation,input,update,profileRevision){
    if(!update)return;
    if(!input||JSON.stringify(input)!==JSON.stringify(requestContext(conversation,profileRevision)))throw new Error('conversation_context_conflict');
    const checked=GyeoteProtocol.contextUpdate(update),submitted=input.conversation_context;
    if(checked.profileRevision!==profileRevision)throw new Error('conversation_context_conflict');
    if(checked.status==='updated'){
      if(!submitted.batch.length||checked.coveredThroughMessageId!==submitted.batch.at(-1).id||!checked.text.trim())throw new Error('conversation_context_conflict');
      conversation.summary={text:checked.text,coveredThroughMessageId:checked.coveredThroughMessageId,profileRevision};
    }else if(checked.text!==submitted.text||checked.coveredThroughMessageId!==submitted.coveredThroughMessageId)throw new Error('conversation_context_conflict');
  }
  const history=(conversation,profileRevision)=>requestContext(conversation,profileRevision).history;
  const api=Object.freeze({limits,empty,record,pair,history,requestContext,applyUpdate,bytes,sourceUrl});
  globalThis.GyeoteConversations=api;if(typeof module!=='undefined')module.exports=api;
})();
