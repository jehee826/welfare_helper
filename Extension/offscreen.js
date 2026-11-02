let active=null;
chrome.runtime.onMessage.addListener((packet,sender,sendResponse)=>{
  if(packet?.target==='gyeote:offscreen'&&packet.type==='gyeote:conversations-changed'&&sender.id===chrome.runtime.id&&!sender.tab){
    if(active?.conversationContext&&(packet.revision!==active.conversationContext.revision||packet.generation!==active.conversationContext.generation))active.controller.abort();
    return;
  }
  if(packet?.target==='gyeote:offscreen'&&['gyeote:auth-changed','gyeote:profile-changed'].includes(packet.type)&&sender.id===chrome.runtime.id&&!sender.tab){if(active?.documentMode&&(packet.type==='gyeote:auth-changed'||active.profileRevision===undefined||packet.revision!==active.profileRevision))active.controller.abort();return;}
  if(packet?.target!=='gyeote:offscreen'||packet.type!=='gyeote:process-image'||sender.id!==chrome.runtime.id||sender.tab)return;
  try{if(!GyeoteProtocol.isLocalOrigin()){sendResponse({ok:false,error:'remote_screen_unavailable'});return;}}catch{sendResponse({ok:false,error:'connection_configuration_invalid'});return;}
  GyeoteImage.prepare(packet.dataUrl,packet.viewport,packet.masks).then(image=>sendResponse({ok:true,image})).catch(()=>sendResponse({ok:false,error:'capture_failed'}));return true;
});
chrome.runtime.onConnect.addListener(port=>{
  const sender=port.sender;
  if(port.name!=='gyeote:guide'||sender?.id!==chrome.runtime.id||sender.frameId!==0||!GyeoteProtocol.official(sender.url)||!GyeoteProtocol.official(sender.tab?.url)){port.disconnect();return;}
  let started=false,controller;
  const send=packet=>{try{port.postMessage(packet);}catch{}};
  port.onDisconnect.addListener(()=>controller?.abort());
  port.onMessage.addListener(async packet=>{
    if(started)return;started=true;
    const requestId=packet?.requestId;
    if(!GyeoteProtocol.id(requestId))return port.disconnect();
    if(active){send({type:'error',requestId,error:'busy'});return;}
    controller=new AbortController();active={controller,documentMode:false};
    let payload,adminSession,timer=setTimeout(()=>controller.abort(),10000);
    try{
      if(Object.keys(packet).some(key=>!['requestId','mode','payload','documentAccess','profileRevision','conversationContext','deadlineAt'].includes(key)))throw new Error('invalid_reply');
      const mode=packet.mode??'screen';
      if(!['screen','document'].includes(mode))throw new Error('invalid_reply');
      const documentMode=mode==='document';
      const origin=GyeoteProtocol.documentOrigin(),local=GyeoteProtocol.isLocalOrigin();
      if(!documentMode&&!GyeoteProtocol.screenAvailable())throw new Error('remote_screen_unavailable');
      if(!documentMode&&!local&&Object.keys(packet).some(key=>!['requestId','mode','payload','deadlineAt'].includes(key)))throw new Error('invalid_reply');
      active.documentMode=documentMode;
      if(documentMode&&packet.profileRevision!==undefined&&(!Number.isSafeInteger(packet.profileRevision)||packet.profileRevision<0))throw new Error('invalid_profile');
      active.profileRevision=documentMode?packet.profileRevision:undefined;
      payload=documentMode?GyeoteProtocol.documentRequest(packet.payload):local?GyeoteProtocol.request(packet.payload):GyeoteProtocol.remoteScreenRequest(packet.payload);
      if(documentMode&&payload.conversation_context&&payload.conversation_context.profileRevision!==packet.profileRevision)throw new Error('invalid_reply');
      const connection=local?await chrome.runtime.sendMessage({type:'gyeote:connection'}):null;
      if(documentMode){
        const auth=await chrome.runtime.sendMessage({type:'gyeote:document-auth'});
        if(!auth||!['admin','anonymous'].includes(auth.mode))throw new Error('connection_failed');
        if(auth.origin!==origin&&!(auth.origin===undefined&&local))throw new Error('document_access_changed');
        if(auth?.mode==='admin'){if(!GyeoteProtocol.documentSession(auth.session))throw new Error('document_auth_required');adminSession=auth.session;}
        const access=[auth.mode,auth.mode==='admin'?'ready':'anonymous',auth.accessId||'initial'].join(':');
        if(packet.documentAccess!==access)throw new Error('document_access_changed');
        if(auth.mode==='anonymous'&&packet.conversationContext!==undefined){
          const context=packet.conversationContext;
          if(!context||!Number.isSafeInteger(context.revision)||context.revision<0||typeof context.generation!=='string')throw new Error('invalid_reply');
          active.conversationContext=context;
        }
      }
      if(!documentMode&&local&&(!connection?.token||connection.token.length<32))throw new Error('connection_required');
      const budget=(documentMode?GyeoteProtocol.documentTimeoutSeconds(connection):GyeoteProtocol.screenTimeoutSeconds(connection))*1000;
      if(packet.deadlineAt!==undefined&&(!Number.isFinite(packet.deadlineAt)||packet.deadlineAt<=0))throw new Error('invalid_reply');
      const remaining=Math.min(budget,(packet.deadlineAt??Date.now()+budget)-Date.now());
      if(remaining<=0)throw new Error('request_stopped');
      clearTimeout(timer);timer=setTimeout(()=>controller.abort(),Math.min(remaining,adminSession?Math.max(0,adminSession.expiresAt*1000-Date.now()):remaining));
      payload.timeout_seconds=Math.min(payload.timeout_seconds??1800,Math.max(1,Math.ceil(remaining/1000)));
      if(payload.image&&(!local||!connection?.imageEnabled))throw new Error('image_disabled');
      if(controller.signal.aborted)throw new Error('request_stopped');
      if(adminSession&&!GyeoteProtocol.documentSession(adminSession))throw new Error('document_auth_required');
      const headers={'Content-Type':'application/json'};
      if(!documentMode&&local)headers.Authorization='Bearer '+connection.token;
      else if(adminSession)headers.Authorization='Bearer '+adminSession.token;
      const responsePending=fetch(origin+(documentMode?'/api/v1/chat':local?'/api/v1/desktop/guide':'/api/v1/screen/guide'),{method:'POST',headers,body:JSON.stringify(payload),signal:controller.signal,redirect:'error',credentials:'omit',cache:'no-store'});
      delete payload.image;
      const response=await responsePending;
      if(!response.ok){if(documentMode&&adminSession&&[401,403].includes(response.status))await chrome.runtime.sendMessage({type:'gyeote:admin-invalid',token:adminSession.token});const code=await response.json().then(r=>r.detail).catch(()=>null);throw new Error(documentMode&&code==='sensitive_input'?'sensitive_input':documentMode&&[401,403].includes(response.status)?'document_auth_required':documentMode&&response.status===504?'request_timeout':documentMode&&response.status===499?'request_cancelled':response.status===429&&code==='chat_rate_limited'?'chat_rate_limited':({401:'connection_required',404:'feature_disabled',409:code==='desktop_image_model_unsupported'?'image_unsupported':'image_disabled',413:'input_budget',422:'input_budget',429:'busy',403:'private_connection',499:'request_stopped',504:'request_stopped'})[response.status]||'generation_failed');}
      const reader=response.body.getReader();let size=0,chunks=[];
      try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>(documentMode?1024*1024:65536))throw new Error('invalid_reply');chunks.push(value);}}
      finally{await reader.cancel().catch(()=>{});}
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
      if(adminSession&&!GyeoteProtocol.documentSession(adminSession))throw new Error('document_auth_required');
      if(documentMode){
        const latest=await chrome.runtime.sendMessage({type:'gyeote:document-auth'});
        if(!latest||!['admin','anonymous'].includes(latest.mode))throw new Error('connection_failed');
        if(latest.origin!==origin&&!(latest.origin===undefined&&local))throw new Error('document_access_changed');
        if(latest.mode==='admin'&&!GyeoteProtocol.documentSession(latest.session))throw new Error('document_auth_required');
        if([latest.mode,latest.mode==='admin'?'ready':'anonymous',latest.accessId||'initial'].join(':')!==packet.documentAccess)throw new Error('document_access_changed');
      }
      const body=JSON.parse(new TextDecoder().decode(bytes));
      if(documentMode)GyeoteProtocol.documentReply(body,payload.conversation_context??null);else GyeoteProtocol.reply(body,payload);
      send({type:'result',requestId,body:documentMode?GyeoteProtocol.privacy.redactDocument(body):body});
    }catch(error){
      const expired=adminSession&&adminSession.expiresAt<=Date.now()/1000;
      if(expired)await chrome.runtime.sendMessage({type:'gyeote:admin-invalid',token:adminSession.token}).catch(()=>{});
      send({type:'error',requestId,error:expired?'document_auth_required':controller.signal.aborted?'request_stopped':['connection_configuration_invalid','remote_screen_unavailable','sensitive_input','invalid_profile','invalid_context','invalid_context_update','connection_required','document_auth_required','document_access_changed','feature_disabled','image_disabled','image_unsupported','input_budget','busy','chat_rate_limited','private_connection','generation_failed','invalid_reply','request_stopped','request_timeout','request_cancelled'].includes(error.message)?error.message:'connection_failed'});
    }
    finally{clearTimeout(timer);if(active?.controller===controller)active=null;payload=null;packet=null;adminSession=null;}
  });
});
