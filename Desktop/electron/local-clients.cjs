const {localOrigin,parseStep} = require("./assistant-policy.cjs");
function configuration() {
  return {rag:localOrigin(process.env.DESKTOP_API_BASE_URL||"http://127.0.0.1:8000",8000)};
}
async function jsonRequest(url,body,signal) {
  let response;
  try {response=await fetch(url,{method:body?"POST":"GET",headers:body?{"Content-Type":"application/json"}:{},body:body?JSON.stringify(body):undefined,signal,redirect:"error"});}
  catch(error) {if(signal.aborted)throw error;throw new Error("local_connection_failed");}
  if(!response.ok) {
    const code=typeof response.json==="function"?await response.json().then(body=>body.detail).catch(()=>null):null;
    const known={desktop_image_disabled:"guide_image_disabled",desktop_image_model_unsupported:"guide_image_unsupported",desktop_context_budget_exceeded:"guide_context_budget",desktop_image_private_connection_required:"guide_private_connection"};
    throw new Error(known[code]||({404:"guide_disabled",429:"local_service_busy",503:"guide_generation_failed",422:"guide_context_budget"})[response.status]||"local_service_error");
  }
  const reader=response.body.getReader(); const chunks=[];let size=0;
  try { while(true) {const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2*1024*1024)throw new Error("response_limit");chunks.push(Buffer.from(value));} }
  finally {await reader.cancel().catch(()=>{});}
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function guideStep(goal,snapshot,progress,signal,clarifications=[],observation=null,onBusy=()=>{},image=null) {
  const candidates=snapshot.elements.filter(e=>e.enabled&&!e.offscreen&&!e.blocked).map(({id,name,role,enabled,offscreen})=>({id,label:name,role,enabled,visible:!offscreen}));
  let result;
  for(let attempt=0;attempt<25;attempt++) {
    try {result=await jsonRequest(configuration().rag+"/api/v1/desktop/guide",{goal,candidates,clarifications:clarifications.slice(-3),screen_context:snapshot.screenContext||[],page_labels:snapshot.pageLabels||[],scroll_percent:snapshot.scrollPercent??null,form_open:!!snapshot.formOpen,...(image?{image}:{})},signal);break;}
    catch(error) {
      if(error.message!=="local_service_busy")throw error;
      if(attempt===24)throw new Error("guide_busy_exhausted");
      onBusy();
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{signal.removeEventListener("abort",abort);resolve();},3000);
        const abort=()=>{clearTimeout(timer);reject(new Error("aborted"));};
        if(signal.aborted)abort();else signal.addEventListener("abort",abort,{once:true});
      });
    }
  }
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
    try { while(this.pending){const {task,deliver}=this.pending;this.pending=null;const controller=new AbortController();this.controller=controller;const timer=setTimeout(()=>controller.abort(new Error("guide_timeout")),90000);
      try {const result=await task(controller.signal);if(!controller.signal.aborted)deliver(null,result);}catch(error) {if(!controller.signal.aborted)deliver(error.message||"guide_unavailable");else if(!this.pending)deliver(controller.signal.reason?.message==="guide_timeout"?"guide_timeout":"guide_cancelled");}finally{clearTimeout(timer);this.controller=null;}
    }}finally{this.running=false;}
  }
}
module.exports={configuration,guideStep,ragAnswer,LatestGuide};
