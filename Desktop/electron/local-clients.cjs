const {localOrigin,parseStep} = require("./assistant-policy.cjs");
function configuration() {
  return {rag:localOrigin(process.env.DESKTOP_API_BASE_URL||"http://127.0.0.1:8000",8000)};
}
async function jsonRequest(url,body,signal) {
  const response=await fetch(url,{method:body?"POST":"GET",headers:body?{"Content-Type":"application/json"}:{},body:body?JSON.stringify(body):undefined,signal,redirect:"error"});
  if(!response.ok) throw new Error("local_service_error");
  const reader=response.body.getReader(); const chunks=[];let size=0;
  try { while(true) {const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2*1024*1024)throw new Error("response_limit");chunks.push(Buffer.from(value));} }
  finally {await reader.cancel().catch(()=>{});}
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function guideStep(goal,snapshot,progress,signal) {
  const candidates=snapshot.elements.map(({id,name,role,enabled,offscreen})=>({id,label:name,role,enabled,visible:!offscreen}));
  const result=await jsonRequest(configuration().rag+"/api/v1/desktop/guide",{goal,candidates,progress:progress.slice(-2)},signal);
  return {...parseStep(JSON.stringify(result.step),snapshot.elements),model:result.model};
}

async function ragAnswer(query,signal) {
  const response=await jsonRequest(configuration().rag+"/api/v1/chat",{query},signal);
  if(!["answer","fallback"].includes(response.kind)||typeof response.text!=="string") throw new Error("invalid_rag_response");
  return {text:response.text.slice(0,12000),evidence:(response.evidence||[]).slice(0,6).map(e=>({context:String(e.context||"").slice(0,2400),pages:Array.isArray(e.pages)?e.pages:[]}))};
}
// 화면 안내 전용 단일 실행. 대기 요청은 최신 하나로 합치고 취소 후 완료를 기다린다.
class LatestGuide {
  constructor(){this.running=false;this.pending=null;this.controller=null;}
  cancel(){this.pending=null;this.controller?.abort();}
  submit(task,deliver){this.pending={task,deliver};this.controller?.abort();void this.drain();}
  async drain(){
    if(this.running)return;this.running=true;
    try { while(this.pending){const {task,deliver}=this.pending;this.pending=null;const controller=new AbortController();this.controller=controller;const timer=setTimeout(()=>controller.abort(),90000);
      try {const result=await task(controller.signal);if(!controller.signal.aborted)deliver(null,result);}catch {if(!controller.signal.aborted)deliver("guide_unavailable");else if(!this.pending)deliver("guide_timeout_or_cancelled");}finally{clearTimeout(timer);this.controller=null;}
    }}finally{this.running=false;}
  }
}
module.exports={configuration,guideStep,ragAnswer,LatestGuide};
