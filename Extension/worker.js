importScripts('protocol.js','conversations.js','conversation-store.js');
const official=GyeoteProtocol.official;
const documentManagerUrl='https://welfare-helper-iota.vercel.app/admin/documents';
let creating;
let authChanges=Promise.resolve();
const profileKey='gyeote.profile';
let localChanges=Promise.resolve(),invalidProfile=null,conversationStore;
const conversationOwners=new Map();
let profileReady;
try{profileReady=Promise.resolve(chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}));}
catch{profileReady=Promise.reject(new Error('profile_storage_failed'));}
profileReady.catch(()=>{});
function changeLocal(action){const pending=localChanges.then(()=>profileReady).then(action);localChanges=pending.catch(()=>{});return pending;}
async function storedProfile(){
  const data=await chrome.storage.local.get(profileKey),raw=data[profileKey];
  if(raw===undefined)return {state:{schemaVersion:1,revision:0,onboardingCompleted:false,profile:null}};
  try{return {state:GyeoteProtocol.profileRecord(raw)};}
  catch{
    const serialized=JSON.stringify(raw);
    if(!invalidProfile||invalidProfile.serialized!==serialized)invalidProfile={serialized,token:crypto.randomUUID()};
    return {invalid:true,resetToken:invalidProfile.token,raw};
  }
}
async function profileAction(message){
  const keys=Object.keys(message).sort().join(',');
  const allowed={'gyeote:profile-get':'type','gyeote:profile-save':'expectedRevision,profile,type','gyeote:profile-clear':'expectedRevision,type','gyeote:profile-reset':'resetToken,type'};
  if(keys!==allowed[message.type])throw new Error('invalid_profile');
  const current=await storedProfile();
  if(message.type==='gyeote:profile-get')return current.invalid?{ok:false,error:'profile_data_invalid',resetToken:current.resetToken}:{ok:true,state:current.state};
  let state;
  if(message.type==='gyeote:profile-reset'){
    if(!current.invalid||typeof message.resetToken!=='string'||message.resetToken!==current.resetToken)throw new Error('profile_conflict');
    const revision=Number.isSafeInteger(current.raw?.revision)&&current.raw.revision>=0&&current.raw.revision<Number.MAX_SAFE_INTEGER?current.raw.revision+1:0;
    state={schemaVersion:1,revision,onboardingCompleted:false,profile:null};
  }else{
    if(current.invalid)throw new Error('profile_data_invalid');
    if(!Number.isSafeInteger(message.expectedRevision)||message.expectedRevision<0)throw new Error('invalid_profile');
    if(message.expectedRevision!==current.state.revision)throw new Error('profile_conflict');
    if(current.state.revision===Number.MAX_SAFE_INTEGER)throw new Error('profile_revision_limit');
    state={schemaVersion:1,revision:current.state.revision+1,onboardingCompleted:message.type==='gyeote:profile-save',profile:message.type==='gyeote:profile-save'?GyeoteProtocol.profile(message.profile):null};
  }
  await chrome.storage.local.set({[profileKey]:state});
  invalidProfile=null;
  return {ok:true,state};
}
function changeAuth(action){const pending=authChanges.then(action);authChanges=pending.catch(()=>{});return pending;}
function authSummary(auth){return {mode:auth.mode,status:auth.mode==='admin'?(auth.session?'ready':'expired'):'anonymous',accessId:auth.accessId,origin:auth.origin};}
async function readAuth(){
  const origin=GyeoteProtocol.documentOrigin();
  const data=await chrome.storage.session.get(['documentAccess','documentAdminSession','documentAccessId']);
  const mode=data.documentAccess==='admin'?'admin':'anonymous',session=data.documentAdminSession;
  const accessId=typeof data.documentAccessId==='string'?data.documentAccessId:'initial';
  if(mode==='admin'&&GyeoteProtocol.documentSession(session))return {mode,session,accessId,origin};
  if(session)await chrome.storage.session.set({documentAdminSession:null});
  return {mode,session:null,accessId,origin};
}
const documentAuth=()=>changeAuth(readAuth);
async function invalidateAuth(token){return changeAuth(async()=>{
  const data=await chrome.storage.session.get('documentAdminSession');
  if(data.documentAdminSession?.token===token)await chrome.storage.session.set({documentAdminSession:null});
});}
async function adminRequest(action,session){
  if(!GyeoteProtocol.documentSession(session))throw new Error('document_auth_required');
  const paths={check:'/api/v1/admin/session',logout:'/api/v1/admin/logout'};
  if(!Object.hasOwn(paths,action))throw new Error('invalid_action');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{const response=await fetch(GyeoteProtocol.documentOrigin()+paths[action],{method:action==='check'?'GET':'POST',headers:{Authorization:'Bearer '+session.token},credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal});await response.body?.cancel();return {ok:response.ok,status:response.status};}
  finally{clearTimeout(timer);}
}
chrome.storage.onChanged?.addListener((changes,area)=>{
  if(area==='local'&&'gyeote.conversations' in changes){
    const value=changes['gyeote.conversations'].newValue;
    const revision=Number.isSafeInteger(value?.revision)&&value.revision>=0?value.revision:null;
    const generation=value?.generation==='initial'||typeof value?.generation==='string'&&/^[0-9a-f-]{36}$/i.test(value.generation)?value.generation:null;
    (async()=>{
      const message={type:'gyeote:conversations-changed',revision,generation};
      await chrome.runtime.sendMessage({target:'gyeote:offscreen',...message}).catch(()=>{});
      const tabs=await chrome.tabs.query({});
      await Promise.allSettled(tabs.map(tab=>chrome.tabs.sendMessage(tab.id,message,{frameId:0})));
    })().catch(()=>{});return;
  }
  if(area==='local'&&profileKey in changes){
    let revision=null;try{revision=GyeoteProtocol.profileRecord(changes[profileKey].newValue).revision;}catch{}
    (async()=>{
      // 프로필 값은 통지에 싣지 않는다. 수신기는 worker에서 최신 revision을 다시 확인한다.
      await chrome.runtime.sendMessage({target:'gyeote:offscreen',type:'gyeote:profile-changed',revision}).catch(()=>{});
      const tabs=await chrome.tabs.query({});
      await Promise.allSettled(tabs.map(tab=>chrome.tabs.sendMessage(tab.id,{type:'gyeote:profile-changed',revision},{frameId:0})));
    })().catch(()=>{});
    return;
  }
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
  if(message?.type==='gyeote:document-manager'){
    if(!content||sender.url!==sender.tab.url||!Number.isInteger(sender.tab.id)||sender.tab.id<0)return;
    if(Object.keys(message).join(',')!=='type'){sendResponse({ok:false,error:'invalid_manager_request'});return;}
    (async()=>{await chrome.tabs.create({url:documentManagerUrl});return {ok:true};})()
      .then(sendResponse).catch(()=>sendResponse({ok:false,error:'document_manager_open_failed'}));
    return true;
  }
  if(message?.type==='gyeote:conversation-cancel'){
    if(!content||sender.url!==sender.tab.url||!Number.isInteger(sender.tab.id)||Object.keys(message).sort().join(',')!=='pairId,type')return;
    if(conversationOwners.get(sender.tab.id)?.pairId===message.pairId)conversationOwners.delete(sender.tab.id);
    sendResponse({ok:true});return;
  }
  if(typeof message?.type==='string'&&message.type.startsWith('gyeote:conversations-')){
    if(!content||sender.url!==sender.tab.url||!Number.isInteger(sender.tab.id)||sender.tab.id<0)return;
    if(message.type==='gyeote:conversations-begin'&&GyeoteProtocol.id(message.pairId))conversationOwners.set(sender.tab.id,{pairId:message.pairId,input:null});
    const owner=conversationOwners.get(sender.tab.id);
    // local 변경과 인증 전환을 함께 직렬화해 프로필/권한 확인과 쓰기 사이의 경쟁을 막는다.
    changeLocal(()=>changeAuth(async()=>{
      conversationStore??=GyeoteConversationStore.create({storage:chrome.storage.local,profile:storedProfile,newId:()=>crypto.randomUUID()});
      const result=await conversationStore.action(message,await readAuth(),()=>!!owner&&owner.pairId===message.pairId&&conversationOwners.get(sender.tab.id)===owner,owner?.input);
      if(message.type==='gyeote:conversations-begin'&&result.ok){
        if(conversationOwners.get(sender.tab.id)!==owner)throw new Error('conversation_request_stopped');
        owner.input=result.input;
      }
      return result;
    })).then(sendResponse).catch(error=>sendResponse({ok:false,error:/^conversation_(invalid_request|data_invalid|conflict|context_conflict|access_changed|profile_changed|request_stopped|count_limit|messages_limit|bytes_limit|revision_limit)$/.test(error.message)?error.message:'conversation_storage_failed'}));
    return true;
  }
  if(['gyeote:profile-get','gyeote:profile-save','gyeote:profile-clear','gyeote:profile-reset'].includes(message?.type)){
    if(!content||sender.url!==sender.tab.url||!Number.isInteger(sender.tab.id)||sender.tab.id<0)return;
    changeLocal(()=>profileAction(message)).then(sendResponse).catch(error=>sendResponse({ok:false,error:['invalid_profile','profile_conflict','profile_data_invalid','profile_revision_limit'].includes(error.message)?error.message:'profile_storage_failed'}));
    return true;
  }
  if(message?.type==='gyeote:connection'&&internal){if(Object.keys(message).join(',')!=='type')return;try{if(!GyeoteProtocol.screenAvailable()){sendResponse(null);return;}}catch{sendResponse(null);return;}chrome.storage.session.get('connection').then(({connection})=>sendResponse(connection||null));return true;}
  if(message?.type==='gyeote:document-auth'&&internal){if(Object.keys(message).join(',')!=='type')return;documentAuth().then(sendResponse).catch(()=>sendResponse(null));return true;}
  if(message?.type==='gyeote:admin-invalid'&&internal){invalidateAuth(message.token).then(()=>sendResponse({ok:true})).catch(()=>sendResponse({ok:false}));return true;}
  if(options&&['gyeote:admin-connect','gyeote:admin-check','gyeote:admin-logout'].includes(message?.type)){
    (async()=>{
      if(Object.keys(message).sort().join(',')!==(message.type==='gyeote:admin-connect'?'session,type':'type'))throw new Error('invalid_session');
      if(message.type==='gyeote:admin-connect'){
        if(!GyeoteProtocol.documentSession(message.session))throw new Error('invalid_session');
        await changeAuth(()=>chrome.storage.session.set({documentAccess:'admin',documentAccessId:crypto.randomUUID(),documentAdminSession:{token:message.session.token,expiresAt:message.session.expiresAt,origin:GyeoteProtocol.documentOrigin()}}));
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
    try{if(!GyeoteProtocol.screenAvailable()){sendResponse({ok:false,error:'remote_screen_unavailable'});return;}}catch{sendResponse({ok:false,error:'connection_configuration_invalid'});return;}
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
    if(Object.keys(message).some(key=>!['type','mode'].includes(key))||message.mode!==undefined&&!['screen','document'].includes(message.mode)){sendResponse({ok:false,error:'connection_required'});return;}
    (async()=>{const local=GyeoteProtocol.screenAvailable();if(message.mode!=='document'&&!local)throw new Error('remote_screen_unavailable');const {connection}=local?await chrome.storage.session.get('connection'):{};if(message.mode!=='document'&&(typeof connection?.token!=='string'||connection.token.length<32))throw new Error('connection_required');const timeoutSeconds=GyeoteProtocol.documentTimeoutSeconds(connection);const access=message.mode==='document'?authSummary(await documentAuth()):undefined;if(access?.status==='expired'){sendResponse({ok:false,error:'document_auth_required'});return;}await prepare();sendResponse({ok:true,imageEnabled:message.mode!=='document'&&connection?.imageEnabled===true,timeoutSeconds,...(access?{documentAccess:access}:{})});})().catch(error=>sendResponse({ok:false,error:['remote_screen_unavailable','connection_configuration_invalid'].includes(error.message)?error.message:'connection_required'}));return true;
  }
});
