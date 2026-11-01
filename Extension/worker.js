importScripts('protocol.js');
const official=GyeoteProtocol.official;
let creating;
let authChanges=Promise.resolve();
function changeAuth(action){const pending=authChanges.then(action);authChanges=pending.catch(()=>{});return pending;}
function authSummary(auth){return {mode:auth.mode,status:auth.mode==='admin'?(auth.session?'ready':'expired'):'anonymous',accessId:auth.accessId};}
async function readAuth(){
  const data=await chrome.storage.session.get(['documentAccess','documentAdminSession','documentAccessId']);
  const mode=data.documentAccess==='admin'?'admin':'anonymous',session=data.documentAdminSession;
  const accessId=typeof data.documentAccessId==='string'?data.documentAccessId:'initial';
  if(mode==='admin'&&GyeoteProtocol.adminSession(session))return {mode,session,accessId};
  if(session)await chrome.storage.session.set({documentAdminSession:null});
  return {mode,session:null,accessId};
}
const documentAuth=()=>changeAuth(readAuth);
async function invalidateAuth(token){return changeAuth(async()=>{
  const data=await chrome.storage.session.get('documentAdminSession');
  if(data.documentAdminSession?.token===token)await chrome.storage.session.set({documentAdminSession:null});
});}
async function adminRequest(action,session){
  const paths={check:'/api/v1/admin/session',logout:'/api/v1/admin/logout'};
  if(!Object.hasOwn(paths,action))throw new Error('invalid_action');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{const response=await fetch('http://127.0.0.1:8000'+paths[action],{method:action==='check'?'GET':'POST',headers:{Authorization:'Bearer '+session.token},credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal});await response.body?.cancel();return {ok:response.ok,status:response.status};}
  finally{clearTimeout(timer);}
}
chrome.storage.onChanged?.addListener((changes,area)=>{
  if(area!=='session'||!('documentAccess' in changes||'documentAdminSession' in changes||'documentAccessId' in changes))return;
  (async()=>{
    // 공개 탭에는 인증 토큰 없이 접근 상태만 전달한다.
    await chrome.runtime.sendMessage({target:'gyeote:offscreen',type:'gyeote:auth-changed'}).catch(()=>{});
    const state=authSummary(await documentAuth());
    // URL 열람 권한 없이 탭 ID만 얻고, 이 확장의 공개 복지로 수신기에 통지한다.
    const tabs=await chrome.tabs.query({});
    await Promise.allSettled(tabs.map(tab=>chrome.tabs.sendMessage(tab.id,{type:'gyeote:document-access-changed',state},{frameId:0})));
  })().catch(()=>{});
});
async function prepare(){
  const url=chrome.runtime.getURL('offscreen.html');
  if(!(await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[url]})).length){
    if(!creating)creating=chrome.offscreen.createDocument({url:'offscreen.html',reasons:['BLOBS'],justification:'요청 시점의 화면 Blob 처리와 유한 상담 요청을 확장 내부 문서에서 처리합니다.'}).finally(()=>creating=null);
    await creating;
  }
}
chrome.action.onClicked.addListener(async tab=>{
  if(!tab.id||!official(tab.url))return;
  try{await chrome.tabs.sendMessage(tab.id,{type:"gyeote:toggle",captureGranted:true},{frameId:0});}catch{}
});
chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(sender.id!==chrome.runtime.id)return;
  const internal=sender.url===chrome.runtime.getURL('offscreen.html');
  const options=sender.url===chrome.runtime.getURL('options.html');
  const content=sender.frameId===0&&official(sender.url)&&official(sender.tab?.url);
  if(message?.type==='gyeote:connection'&&internal){chrome.storage.session.get('connection').then(({connection})=>sendResponse(connection||null));return true;}
  if(message?.type==='gyeote:document-auth'&&internal){documentAuth().then(sendResponse).catch(()=>sendResponse(null));return true;}
  if(message?.type==='gyeote:admin-invalid'&&internal){invalidateAuth(message.token).then(()=>sendResponse({ok:true})).catch(()=>sendResponse({ok:false}));return true;}
  if(options&&['gyeote:admin-connect','gyeote:admin-check','gyeote:admin-logout'].includes(message?.type)){
    (async()=>{
      if(message.type==='gyeote:admin-connect'){
        if(!GyeoteProtocol.adminSession(message.session))throw new Error('invalid_session');
        await changeAuth(()=>chrome.storage.session.set({documentAccess:'admin',documentAccessId:crypto.randomUUID(),documentAdminSession:{token:message.session.token,expiresAt:message.session.expiresAt}}));
        return {ok:true,...authSummary(await documentAuth())};
      }
      if(message.type==='gyeote:admin-logout'){
        const auth=await changeAuth(async()=>{const prior=await readAuth();await chrome.storage.session.set({documentAccess:'anonymous',documentAccessId:crypto.randomUUID(),documentAdminSession:null});return prior;});
        let serverRevoked=true;if(auth.session){try{const response=await adminRequest('logout',auth.session);serverRevoked=response.ok||response.status===401;}catch{serverRevoked=false;}}
        return {mode:'anonymous',status:'anonymous',serverRevoked};
      }
      const auth=await documentAuth();if(!auth.session)return authSummary(auth);
      try{const response=await adminRequest('check',auth.session);if([401,403].includes(response.status)){await invalidateAuth(auth.session.token);return authSummary(await documentAuth());}if(!response.ok)return {...authSummary(auth),status:'unverified'};}
      catch{return {...authSummary(auth),status:'unverified'};}
      return authSummary(await documentAuth());
    })().then(sendResponse).catch(()=>sendResponse({ok:false}));return true;
  }
  if(!content)return;
  if(message?.type==='gyeote:document-access'){documentAuth().then(auth=>sendResponse(authSummary(auth))).catch(()=>sendResponse({mode:'admin',status:'expired'}));return true;}
  if(message?.type==='gyeote:capture'){
    let failure='capture_tab_changed';
    (async()=>{
      const before=await chrome.tabs.get(sender.tab.id),window=await chrome.windows.get(sender.tab.windowId);
      if(!before.active||!window.focused||before.url!==sender.url)throw new Error('capture_tab_changed');
      failure='capture_offscreen_failed';await prepare();
      failure='capture_permission_or_failed';
      let dataUrl=await chrome.tabs.captureVisibleTab(sender.tab.windowId,{format:'png'});
      failure='capture_tab_changed';
      const after=await chrome.tabs.get(sender.tab.id),afterWindow=await chrome.windows.get(sender.tab.windowId);
      if(!after.active||!afterWindow.focused||after.url!==before.url)throw new Error('capture_tab_changed');
      failure='capture_processing_failed';
      const result=await chrome.runtime.sendMessage({target:'gyeote:offscreen',type:'gyeote:process-image',dataUrl,masks:message.masks,viewport:message.viewport});dataUrl=null;
      if(!result?.ok)throw new Error('capture_failed');sendResponse(result);
    })().catch(()=>sendResponse({ok:false,error:failure}));return true;
  }
  if(message?.type==='gyeote:options'){chrome.runtime.openOptionsPage();sendResponse({ok:true});return;}
  if(message?.type==='gyeote:prepare'){
    if(message.mode!==undefined&&!['screen','document'].includes(message.mode)){sendResponse({ok:false,error:'connection_required'});return;}
    chrome.storage.session.get('connection').then(async({connection})=>{if(message.mode!=='document'&&(typeof connection?.token!=='string'||connection.token.length<32))throw new Error('connection_required');const timeoutSeconds=GyeoteProtocol.timeoutSeconds(connection);const access=message.mode==='document'?authSummary(await documentAuth()):undefined;if(access?.status==='expired'){sendResponse({ok:false,error:'document_auth_required'});return;}await prepare();sendResponse({ok:true,imageEnabled:message.mode!=='document'&&connection?.imageEnabled===true,timeoutSeconds,...(access?{documentAccess:access}:{})});}).catch(()=>sendResponse({ok:false,error:'connection_required'}));return true;
  }
});
