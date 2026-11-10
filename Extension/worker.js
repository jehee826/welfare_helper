importScripts('protocol.js','conversations.js','conversation-store.js');
const official=GyeoteProtocol.official;
const documentManagerUrl='https://welfare-helper-iota.vercel.app/admin/documents';
let creating;
let authChanges=Promise.resolve();
const profileKey='gyeote.profile';
const profileUsageKey='gyeote.profileUsage';
let localChanges=Promise.resolve(),conversationChanges=Promise.resolve(),invalidProfile=null,conversationStore;
const conversationOwners=new Map();
let ownerWrites=Promise.resolve();
const ownerKey=tabId=>'gyeote.conversation-owner:'+tabId;
function writeOwner(action){const pending=ownerWrites.then(action);ownerWrites=pending.catch(()=>{});return pending;}
function ownerMatches(owner,message,sender){
  const sameUrl=owner?.url===sender.url||!!owner?.documentId&&owner.documentId===sender.documentId&&owner.url.split('#')[0]===sender.url.split('#')[0];
  return !!owner&&!owner.cancelled&&owner.expiresAt>Date.now()&&owner.tabId===sender.tab.id&&sameUrl&&owner.documentId===(sender.documentId??null)&&['pairId','accessId','profileRevision','expectedRevision','generation','conversationId'].every(key=>owner[key]===message[key]);
}
async function restoreOwner(tabId){
  const known=conversationOwners.get(tabId);
  if(known&&!known.cancelled)return known;
  await ownerWrites;
  const stored=(await chrome.storage.session.get(ownerKey(tabId)))[ownerKey(tabId)],current=conversationOwners.get(tabId);
  if(current!==known)return current?.cancelled?null:current;
  if(!stored||stored.expiresAt<=Date.now()||known?.cancelled&&stored.pairId===known.pairId)return null;
  conversationOwners.set(tabId,stored);return stored;
}
chrome.tabs.onRemoved?.addListener(tabId=>{
  conversationOwners.set(tabId,{cancelled:true});
  void writeOwner(()=>chrome.storage.session.remove(ownerKey(tabId))).catch(()=>{});
});
let profileReady;
try{profileReady=Promise.all([chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}),chrome.storage.session.setAccessLevel?.({accessLevel:'TRUSTED_CONTEXTS'})]);}
catch{profileReady=Promise.reject(new Error('profile_storage_failed'));}
profileReady.catch(()=>{});
function changeLocal(action){const pending=localChanges.then(()=>profileReady).then(action);localChanges=pending.catch(()=>{});return pending;}
function changeConversations(action){const pending=conversationChanges.then(()=>profileReady).then(action);conversationChanges=pending.catch(()=>{});return pending;}
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
async function storedProfileUsage(){
  const raw=(await chrome.storage.local.get(profileUsageKey))[profileUsageKey];
  return raw===undefined?{schemaVersion:1,revision:0,enabled:false,profileRevision:null}:GyeoteProtocol.profileUsageRecord(raw);
}
async function fetchPublicCapabilities(){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
  try{
    const response=await fetch(GyeoteProtocol.documentOrigin()+'/api/v1/chat/capabilities',{signal:controller.signal,redirect:'error',credentials:'omit',cache:'no-store'});
    if(response.status===404)return {profile_context_supported:false,referral_records_enabled:false};
    if(!response.ok)throw new Error('public_settings_unavailable');
    const value=await response.json();
    if(!value||typeof value!=='object'||Array.isArray(value)||['profile_context_supported','referral_records_enabled'].some(key=>key in value&&typeof value[key]!=='boolean'))throw new Error('public_settings_unavailable');
    return {profile_context_supported:value.profile_context_supported===true,referral_records_enabled:value.referral_records_enabled===true};
  }finally{clearTimeout(timer);}
}
let publicCapabilityRead;
async function publicCapabilities(){
  if(publicCapabilityRead)return publicCapabilityRead;
  // 동시에 열린 고지·정보 설정은 읽기를 공유하고, 전송 직전에는 새로 확인한다.
  publicCapabilityRead=fetchPublicCapabilities();
  try{return await publicCapabilityRead;}finally{publicCapabilityRead=null;}
}
async function profileSupported(){try{return (await publicCapabilities()).profile_context_supported;}catch{return false;}}
async function currentProfileContext(checkSupport=false){
  try{
    const usage=await storedProfileUsage();if(!usage.enabled||checkSupport&&!await profileSupported())return null;
    const stored=await storedProfile();
    if(stored.invalid||!stored.state.profile||stored.state.revision!==usage.profileRevision)return null;
    return GyeoteProtocol.profileContext({enabled:true,consent_revision:usage.revision,profile_revision:stored.state.revision,profile:stored.state.profile});
  }catch{return null;}
}
const profileStamp=value=>value?`${value.consent_revision}:${value.profile_revision}`:null;
async function profileUsageAction(message){
  const state=await storedProfileUsage();
  if(message.type==='gyeote:profile-usage-get'){
    if(Object.keys(message).join(',')!=='type')throw new Error('profile_usage_invalid');
    const stored=await storedProfile();
    return {ok:true,state,valid:state.enabled&&!stored.invalid&&!!stored.state.profile&&stored.state.revision===state.profileRevision};
  }
  if(Object.keys(message).sort().join(',')!=='enabled,expectedRevision,profileRevision,type'||typeof message.enabled!=='boolean'||!Number.isSafeInteger(message.expectedRevision)||message.expectedRevision!==state.revision)throw new Error('profile_usage_conflict');
  if(state.revision===Number.MAX_SAFE_INTEGER)throw new Error('profile_usage_invalid');
  if(message.enabled){
    if(!await profileSupported())throw new Error('profile_usage_unsupported');
    const stored=await storedProfile();
    if(stored.invalid||!stored.state.profile||message.profileRevision!==stored.state.revision)throw new Error('profile_changed');
  }else if(message.profileRevision!==null)throw new Error('profile_usage_invalid');
  const next=GyeoteProtocol.profileUsageRecord({schemaVersion:1,revision:state.revision+1,enabled:message.enabled,profileRevision:message.enabled?message.profileRevision:null});
  const values={[profileUsageKey]:next};
  if(state.enabled&&(!next.enabled||state.profileRevision!==next.profileRevision)){
    conversationStore??=GyeoteConversationStore.create({storage:chrome.storage.local,newId:()=>crypto.randomUUID()});
    values[GyeoteConversationStore.key]=await conversationStore.prepareContextReset();
  }
  await chrome.storage.local.set(values);
  return {ok:true,state:next,supported:true,valid:next.enabled};
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
const uiKey='gyeote.uiPreferences';
let uiChanges=Promise.resolve();
function changeUi(action){const pending=uiChanges.then(()=>profileReady).then(action);uiChanges=pending.catch(()=>{});return pending;}
async function storedUi(){
  const raw=(await chrome.storage.local.get(uiKey))[uiKey];
  if(raw===undefined)return {state:{schemaVersion:1,revision:0,...GyeoteProtocol.uiDefaults}};
  try{return {state:GyeoteProtocol.uiPreferenceRecord(raw)};}
  catch{
    const revision=Number.isSafeInteger(raw?.revision)&&raw.revision>=0&&raw.revision<Number.MAX_SAFE_INTEGER?raw.revision:0;
    return {invalid:true,state:{schemaVersion:1,revision,...GyeoteProtocol.uiDefaults}};
  }
}
async function uiAction(message){
  const allowed={'gyeote:ui-preferences-get':'type','gyeote:ui-preferences-set':'expectedRevision,preferences,type','gyeote:ui-preferences-reset':'expectedRevision,type'};
  if(Object.keys(message).sort().join(',')!==allowed[message.type])throw new Error('invalid_ui_preferences');
  const current=await storedUi();
  if(message.type==='gyeote:ui-preferences-get')return {ok:true,state:current.state,...(current.invalid?{invalid:true}:{})};
  if(!Number.isSafeInteger(message.expectedRevision)||message.expectedRevision<0)throw new Error('invalid_ui_preferences');
  if(message.type==='gyeote:ui-preferences-set'&&current.invalid)throw new Error('ui_preferences_invalid');
  if(message.expectedRevision!==current.state.revision)throw new Error('ui_preferences_conflict');
  if(current.state.revision===Number.MAX_SAFE_INTEGER)throw new Error('ui_preferences_revision_limit');
  const values=message.type==='gyeote:ui-preferences-set'?GyeoteProtocol.uiPreferences(message.preferences):GyeoteProtocol.uiDefaults;
  const state={schemaVersion:1,revision:current.state.revision+1,...values};
  await chrome.storage.local.set({[uiKey]:state});
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
  if(area==='local'&&profileUsageKey in changes){
    const revision=changes[profileUsageKey].newValue?.revision;
    (async()=>{const message={type:'gyeote:profile-usage-changed',revision};await chrome.runtime.sendMessage({target:'gyeote:offscreen',...message}).catch(()=>{});const tabs=await chrome.tabs.query({});await Promise.allSettled(tabs.map(tab=>chrome.tabs.sendMessage(tab.id,message,{frameId:0})));})().catch(()=>{});
  }
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
  if(area==='local'&&GyeoteConversationStore.summaryKey in changes){
    (async()=>{const message={type:'gyeote:display-summary-changed'};const tabs=await chrome.tabs.query({});await Promise.allSettled(tabs.map(tab=>chrome.tabs.sendMessage(tab.id,message,{frameId:0})));})().catch(()=>{});return;
  }
  if(area==='local'&&profileKey in changes){
    let revision=null;try{revision=GyeoteProtocol.profileRecord(changes[profileKey].newValue).revision;}catch{}
    (async()=>{
      // 프로필 값은 통지에 싣지 않는다. 수신기는 worker에서 최신 revision을 다시 확인한다.
      const tabs=await chrome.tabs.query({});
      await Promise.allSettled(tabs.map(tab=>chrome.tabs.sendMessage(tab.id,{type:'gyeote:profile-changed',revision},{frameId:0})));
      await chrome.runtime.sendMessage({target:'gyeote:offscreen',type:'gyeote:profile-changed',revision}).catch(()=>{});
    })().catch(()=>{});
    return;
  }
  if(area==='local'&&uiKey in changes){
    const value=changes[uiKey].newValue,revision=Number.isSafeInteger(value?.revision)&&value.revision>=0?value.revision:null;
    (async()=>{
      const tabs=await chrome.tabs.query({});
      await Promise.allSettled(tabs.map(tab=>chrome.tabs.sendMessage(tab.id,{type:'gyeote:ui-preferences-changed',revision},{frameId:0})));
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
    if(!creating)creating=chrome.offscreen.createDocument({url:'offscreen.html',reasons:['BLOBS'],justification:'유한 상담 응답의 Blob 데이터를 확장 내부 문서에서 처리합니다.'}).finally(()=>creating=null);
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
  if(message?.type==='gyeote:public-capabilities'){
    if(!content||sender.url!==sender.tab.url||Object.keys(message).join(',')!=='type')return;
    (async()=>{if((await documentAuth()).mode!=='anonymous')throw new Error();const capability=await publicCapabilities();return {ok:true,referralRecordsEnabled:capability.referral_records_enabled,profileContextSupported:capability.profile_context_supported};})()
      .then(sendResponse).catch(()=>sendResponse({ok:false,error:'public_settings_unavailable'}));return true;
  }
  if(['gyeote:profile-usage-get','gyeote:profile-usage-set'].includes(message?.type)){
    if(!content||sender.url!==sender.tab.url||!Number.isInteger(sender.tab.id)||sender.tab.id<0)return;
    const action=async()=>{
      if((await readAuth()).mode!=='anonymous')throw new Error('profile_usage_unavailable');
      return profileUsageAction(message);
    };
    const result=message.type==='gyeote:profile-usage-get'?action():changeConversations(()=>changeAuth(()=>changeLocal(action)));
    result.then(sendResponse).catch(error=>sendResponse({ok:false,error:['profile_usage_invalid','profile_usage_conflict','profile_usage_unsupported','profile_usage_unavailable','profile_changed'].includes(error.message)?error.message:'profile_usage_storage_failed'}));return true;
  }
  if(message?.type==='gyeote:profile-context'&&internal){
    currentProfileContext().then(context=>sendResponse({ok:true,context})).catch(()=>sendResponse({ok:false}));return true;
  }
  if(message?.type==='gyeote:summary-capability'){
    if(!content||sender.url!==sender.tab.url||Object.keys(message).join(',')!=='type')return;
    (async()=>{
      if((await documentAuth()).mode!=='anonymous')return {ok:true,available:false};
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
      try{
        const response=await fetch(GyeoteProtocol.documentOrigin()+'/api/v1/conversation/summary',{signal:controller.signal,redirect:'error',credentials:'omit',cache:'no-store'});
        const body=response.ok?await response.json():null;
        return {ok:true,available:body?.available===true&&body?.version===1};
      }finally{clearTimeout(timer);}
    })().then(sendResponse).catch(()=>sendResponse({ok:true,available:false}));return true;
  }
  if(message?.type==='gyeote:document-manager'){
    if(!content||sender.url!==sender.tab.url||!Number.isInteger(sender.tab.id)||sender.tab.id<0)return;
    if(Object.keys(message).join(',')!=='type'){sendResponse({ok:false,error:'invalid_manager_request'});return;}
    (async()=>{await chrome.tabs.create({url:documentManagerUrl});return {ok:true};})()
      .then(sendResponse).catch(()=>sendResponse({ok:false,error:'document_manager_open_failed'}));
    return true;
  }
  if(message?.type==='gyeote:conversation-cancel'){
    if(!content||sender.url!==sender.tab.url||!Number.isInteger(sender.tab.id)||Object.keys(message).sort().join(',')!=='pairId,type')return;
    const current=conversationOwners.get(sender.tab.id);
    if(!current||current.pairId===message.pairId)conversationOwners.set(sender.tab.id,{pairId:message.pairId,cancelled:true});
    writeOwner(async()=>{const key=ownerKey(sender.tab.id),stored=(await chrome.storage.session.get(key))[key];if(stored?.pairId===message.pairId)await chrome.storage.session.set({[key]:null});}).then(()=>sendResponse({ok:true})).catch(()=>sendResponse({ok:false,error:'conversation_storage_failed'}));return true;
  }
  if(typeof message?.type==='string'&&message.type.startsWith('gyeote:conversations-')){
    if(!content||sender.url!==sender.tab.url||!Number.isInteger(sender.tab.id)||sender.tab.id<0)return;
    if(message.type==='gyeote:conversations-begin'&&GyeoteProtocol.id(message.pairId))conversationOwners.set(sender.tab.id,{...Object.fromEntries(['pairId','accessId','profileRevision','expectedRevision','generation','conversationId'].map(key=>[key,message[key]])),tabId:sender.tab.id,url:sender.url,documentId:sender.documentId??null,expiresAt:Date.now()+1830000,input:null});
    const initialOwner=conversationOwners.get(sender.tab.id);
    // 대화 저장과 인증 전환은 직렬화하고 프로필 저장 대기와는 분리한다.
    changeConversations(()=>changeAuth(async()=>{
      conversationStore??=GyeoteConversationStore.create({storage:chrome.storage.local,newId:()=>crypto.randomUUID()});
      const owner=['gyeote:conversations-append','gyeote:conversations-resume'].includes(message.type)?await restoreOwner(sender.tab.id):initialOwner;
      if(['gyeote:conversations-append','gyeote:conversations-resume'].includes(message.type)&&owner?.profileContextStamp&&owner.profileContextStamp!==profileStamp(await currentProfileContext()))throw new Error('conversation_profile_changed');
      const owns=()=>ownerMatches(message.type==='gyeote:conversations-resume'&&owner?{...owner,expectedRevision:message.expectedRevision}:owner,message,sender)&&conversationOwners.get(sender.tab.id)===owner&&(message.type==='gyeote:conversations-begin'||owner.committed===true);
      const result=await conversationStore.action(message,await readAuth(),owns,owner?.input,owner?.boundaryStartedAt);
      if(['gyeote:conversations-begin','gyeote:conversations-resume'].includes(message.type)&&result.ok){
        const context=message.type==='gyeote:conversations-begin'?await currentProfileContext(true):null;
        if(!owns())throw new Error('conversation_request_stopped');
        const nextOwner={...owner,input:result.input,expectedRevision:result.state.revision,conversationId:result.state.lastActiveConversationId,boundaryStartedAt:result.state.conversations[0].contextBoundary.startedAt,profileContextStamp:message.type==='gyeote:conversations-begin'?profileStamp(context):owner.profileContextStamp,committed:true};
        // worker 유휴 종료를 넘어도 원래 요청의 문맥과 소유권을 세션에 보존한다.
        await writeOwner(async()=>{if(!owns())throw new Error('conversation_request_stopped');await chrome.storage.session.set({[ownerKey(sender.tab.id)]:nextOwner});});
        if(!owns())throw new Error('conversation_request_stopped');
        Object.assign(owner,nextOwner);
        if(context)result.profileContext=context;
      }
      return result;
    })).then(sendResponse).catch(error=>sendResponse({ok:false,error:/^conversation_(invalid_request|data_invalid|conflict|context_conflict|summary_conflict|summary_invalid|access_changed|profile_changed|request_stopped|count_limit|messages_limit|bytes_limit|revision_limit)$/.test(error.message)?error.message:'conversation_storage_failed'}));
    return true;
  }
  if(['gyeote:profile-get','gyeote:profile-save','gyeote:profile-clear','gyeote:profile-reset'].includes(message?.type)){
    if(!content||sender.url!==sender.tab.url||!Number.isInteger(sender.tab.id)||sender.tab.id<0)return;
    changeLocal(()=>profileAction(message)).then(sendResponse).catch(error=>sendResponse({ok:false,error:['invalid_profile','profile_conflict','profile_data_invalid','profile_revision_limit'].includes(error.message)?error.message:'profile_storage_failed'}));
    return true;
  }
  if(['gyeote:ui-preferences-get','gyeote:ui-preferences-set','gyeote:ui-preferences-reset'].includes(message?.type)){
    if(!content||sender.url!==sender.tab.url||!Number.isInteger(sender.tab.id)||sender.tab.id<0)return;
    changeUi(()=>uiAction(message)).then(sendResponse).catch(error=>sendResponse({ok:false,error:['invalid_ui_preferences','ui_preferences_conflict','ui_preferences_invalid','ui_preferences_revision_limit'].includes(error.message)?error.message:'ui_preferences_storage_failed'}));
    return true;
  }
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
  if(message?.type==='gyeote:options'){chrome.runtime.openOptionsPage();sendResponse({ok:true});return;}
  if(message?.type==='gyeote:prepare'){
    if(Object.keys(message).some(key=>!['type','mode'].includes(key))||message.mode!==undefined&&!['screen','document','summary'].includes(message.mode)){sendResponse({ok:false,error:'connection_failed'});return;}
    (async()=>{
      GyeoteProtocol.documentOrigin();
      const documentMode=['document','summary'].includes(message.mode);
      const timeoutSeconds=documentMode?GyeoteProtocol.documentTimeoutSeconds():GyeoteProtocol.screenTimeoutSeconds();
      const access=documentMode?authSummary(await documentAuth()):undefined;
      if(message.mode==='summary'&&access?.mode!=='anonymous'){sendResponse({ok:false,error:'summary_public_only'});return;}
      if(access?.status==='expired'){sendResponse({ok:false,error:'document_auth_required'});return;}
      let referralRecordsEnabled;
      if(message.mode==='document'&&access?.mode==='anonymous'){
        try{referralRecordsEnabled=(await publicCapabilities()).referral_records_enabled;}catch{throw new Error('public_settings_unavailable');}
      }
      await prepare();sendResponse({ok:true,timeoutSeconds,...(access?{documentAccess:access}:{}),...(referralRecordsEnabled!==undefined?{referralRecordsEnabled}:{})});
    })().catch(error=>sendResponse({ok:false,error:['connection_configuration_invalid','public_settings_unavailable'].includes(error.message)?error.message:'connection_failed'}));return true;
  }
});
