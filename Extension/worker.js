importScripts('protocol.js');
const official=GyeoteProtocol.official;
let creating;
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
  const content=sender.frameId===0&&official(sender.url)&&official(sender.tab?.url);
  if(message?.type==='gyeote:connection'&&internal){chrome.storage.session.get('connection').then(({connection})=>sendResponse(connection||null));return true;}
  if(!content)return;
  if(message?.type==='gyeote:capture'){
    (async()=>{
      const before=await chrome.tabs.get(sender.tab.id),window=await chrome.windows.get(sender.tab.windowId);
      if(!before.active||!window.focused||before.url!==sender.url)throw new Error('capture_tab_changed');
      await prepare();
      let dataUrl=await chrome.tabs.captureVisibleTab(sender.tab.windowId,{format:'png'});
      const after=await chrome.tabs.get(sender.tab.id);
      if(!after.active||after.url!==before.url)throw new Error('capture_tab_changed');
      const result=await chrome.runtime.sendMessage({target:'gyeote:offscreen',type:'gyeote:process-image',dataUrl,masks:message.masks,viewport:message.viewport});dataUrl=null;
      if(!result?.ok)throw new Error('capture_failed');sendResponse(result);
    })().catch(error=>sendResponse({ok:false,error:error.message==='capture_tab_changed'?'capture_tab_changed':'capture_permission_or_failed'}));return true;
  }
  if(message?.type==='gyeote:options'){chrome.runtime.openOptionsPage();sendResponse({ok:true});return;}
  if(message?.type==='gyeote:prepare'){
    chrome.storage.session.get('connection').then(async({connection})=>{if(typeof connection?.token!=='string'||connection.token.length<32)throw new Error('connection_required');await prepare();sendResponse({ok:true,imageEnabled:connection.imageEnabled===true});}).catch(()=>sendResponse({ok:false,error:'connection_required'}));return true;
  }
});
