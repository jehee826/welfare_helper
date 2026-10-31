let active=null;
chrome.runtime.onMessage.addListener((packet,sender,sendResponse)=>{
  if(packet?.target!=='gyeote:offscreen'||packet.type!=='gyeote:process-image'||sender.id!==chrome.runtime.id||sender.tab)return;
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
    controller=new AbortController();active=controller;
    let payload,timer=setTimeout(()=>controller.abort(),10000);
    try{
      payload=GyeoteProtocol.request(packet.payload);
      const connection=await chrome.runtime.sendMessage({type:'gyeote:connection'});
      if(!connection?.token||connection.token.length<32)throw new Error('connection_required');
      const budget=GyeoteProtocol.timeoutSeconds(connection)*1000;
      if(packet.deadlineAt!==undefined&&(!Number.isFinite(packet.deadlineAt)||packet.deadlineAt<=0))throw new Error('invalid_reply');
      const remaining=Math.min(budget,(packet.deadlineAt??Date.now()+budget)-Date.now());
      if(remaining<=0)throw new Error('request_stopped');
      clearTimeout(timer);timer=setTimeout(()=>controller.abort(),remaining);
      payload.timeout_seconds=Math.max(1,Math.ceil(remaining/1000));
      if(payload.image&&!connection.imageEnabled)throw new Error('image_disabled');
      if(controller.signal.aborted)throw new Error('request_stopped');
      const responsePending=fetch('http://127.0.0.1:8000/api/v1/desktop/guide',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+connection.token},body:JSON.stringify(payload),signal:controller.signal,redirect:'error',credentials:'omit',cache:'no-store'});
      delete payload.image;
      const response=await responsePending;
      if(!response.ok){const code=await response.json().then(r=>r.detail).catch(()=>null);throw new Error(({401:'connection_required',404:'feature_disabled',409:code==='desktop_image_model_unsupported'?'image_unsupported':'image_disabled',422:'input_budget',429:'busy',403:'private_connection',499:'request_stopped',504:'request_stopped'})[response.status]||'generation_failed');}
      const reader=response.body.getReader();let size=0,chunks=[];
      try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536)throw new Error('invalid_reply');chunks.push(value);}}
      finally{await reader.cancel().catch(()=>{});}
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
      const body=JSON.parse(new TextDecoder().decode(bytes));GyeoteProtocol.reply(body,payload);send({type:'result',requestId,body});
    }catch(error){send({type:'error',requestId,error:controller.signal.aborted?'request_stopped':['connection_required','feature_disabled','image_disabled','image_unsupported','input_budget','busy','private_connection','generation_failed','invalid_reply','request_stopped'].includes(error.message)?error.message:'connection_failed'});}
    finally{clearTimeout(timer);if(active===controller)active=null;payload=null;packet=null;}
  });
});
