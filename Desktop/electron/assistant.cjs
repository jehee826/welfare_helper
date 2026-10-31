const {watchMessage}=require("./watch-status.cjs");
const {watchChrome}=require("./chrome-watch.cjs");
const {safeGoal,realHighlight}=require("./assistant-policy.cjs");
const {guideStep,ragAnswer,LatestGuide}=require("./local-clients.cjs");
const {screen}=require("electron");
function assistant({panel,overlay,publish,clearDemo,ownFocused,autoOpen=true}) {
  let mode="screen",snapshot=null,revision=0,goal="",step=null,baseline=new Set(),previousMeaning="",suppressed="",manual=false,ragController=null,stopped=false;
  const queue=new LatestGuide(),progress=[],clarifications=[];
  let knownSiteKey="",present=false,pendingGuide=false,pendingAdvance=false,lastReason="";
  let ui={mode,status:"idle",text:"Chrome에서 복지로를 열면 접근성 정보를 확인합니다.",connection:"대기",screenMessages:[],ragMessages:[],model:"서버 OLLAMA_LLM 공유"};
  let expiry,pendingTimer;
  const cancelPending=()=>{pendingGuide=false;pendingAdvance=false;clearTimeout(pendingTimer);};
  const waitForSnapshot=()=>{pendingGuide=true;clearTimeout(pendingTimer);pendingTimer=setTimeout(()=>{cancelPending();emit({status:"idle",text:"화면 재확인이 지연됩니다. 다시 요청하세요."});},5000);};
  const emit=update=>{ui={...ui,...update};publish(ui);};
  const invalidate=()=>{revision++;queue.cancel();ragController?.abort();ragController=null;step=null;overlay.hide();};
  const siteKey=()=>snapshot?.context.split(":").slice(0,2).join(":")||knownSiteKey;
  function renderHighlight(){
    overlay.hide();
    if(mode!=="screen" || ui.status==="waiting" || !panel.isVisible() || ui.collapsed || !step || step.action!=="안내")return;
    const rect=realHighlight(snapshot,step.target_id,r=>{
      const inOneDisplay=screen.getAllDisplays().some(d=>{const b=screen.dipToScreenRect(null,d.bounds);return r.x>=b.x&&r.y>=b.y&&r.x+r.width<=b.x+b.width&&r.y+r.height<=b.y+b.height;});
      return inOneDisplay?screen.screenToDipRect(null,{x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)}):null;
    },screen.getAllDisplays().map(d=>d.workArea),panel.getBounds(),snapshot?.active && !ownFocused());
    const text=rect?"이 버튼을 직접 누르세요. 실제 화면 변화 후 ‘화면 변화 확인’을 눌러주세요.":"버튼이 숨겨졌거나 가려졌거나 브라우저가 비활성입니다. UIA만으로 스크롤 방향을 단정할 수 없어 강조를 멈췄습니다.";
    if(ui.text!==text)emit({text});
    if(rect){overlay.setBounds({x:Math.round(rect.x-8),y:Math.round(rect.y-28),width:Math.ceil(rect.width+16),height:Math.ceil(rect.height+36)});overlay.showInactive();}
  }
  const receive=(next,reason,presence)=>{
    if(stopped || mode==="demo")return;
    clearTimeout(expiry);
    expiry=setTimeout(()=>{snapshot=null;cancelPending();invalidate();overlay.hide();if(ui.status==="guide"||ui.status==="waiting")emit({status:"idle",text:"접근성 정보 갱신을 기다립니다. 다시 요청하세요."});},3500);
    const old=snapshot,wasPresent=present;snapshot=next;present=!!next||!!presence;
    lastReason=reason;
    if(presence)knownSiteKey=presence.key;
    if(next)knownSiteKey=next.context.split(":").slice(0,2).join(":");
    if(!next){
      const transient=['target_rechecking','target_changed_during_read'].includes(reason);
      if(transient && mode==="screen" && ui.status==="waiting" && !pendingGuide)waitForSnapshot();
      if(!transient)cancelPending();
      if(old||wasPresent)invalidate();
      if(!manual&&!presence&&!['target_rechecking','target_changed_during_read'].includes(reason))panel.hide();
      if(autoOpen && presence?.active && suppressed!==presence.key) {manual=false;panel.showInactive();}
      emit({connection:presence?"복지로 주소 확인 · 페이지 정보 미확인":"미확인",status:(old||mode==="screen")&&ui.status==="waiting"?"idle":ui.status,text:mode==="screen"?watchMessage(reason):ui.text});return;
    }
    const changed=old && old.signature!==next.signature;
    if(changed){invalidate();emit({status:"idle",text:mode==="screen"?"화면이 바뀌었습니다. 새 상태를 확인한 뒤 ‘화면 변화 확인’을 눌러주세요.":"화면 전환으로 이전 요청을 중지했습니다. 필요하면 다시 질문하세요."});}
    if(!old || old.context!==next.context || (!old.active && next.active)){
      if(!old){invalidate();if(ui.status==="waiting")emit({status:"idle",text:"브라우저 연결이 바뀌어 이전 요청을 중지했습니다."});}
      if(next.active)manual=false;
      if(autoOpen && next.active && suppressed!==siteKey() && !panel.isVisible()) {
        const physical=next.viewport;
        const browser=screen.screenToDipRect(null,{x:Math.floor(physical.x),y:Math.floor(physical.y),width:Math.ceil(physical.width),height:Math.ceil(physical.height)});
        const area=screen.getDisplayMatching(browser).workArea, size=panel.getBounds();
        const right=browser.x+browser.width+12,left=browser.x-size.width-12;
        const x=right+size.width<=area.x+area.width?right:left>=area.x?left:area.x+area.width-size.width;
        panel.setPosition(Math.round(Math.max(area.x,x)),Math.round(Math.max(area.y,Math.min(browser.y,area.y+area.height-size.height))));
        panel.showInactive();
      }
    }
    if(next.active)manual=false;
    emit({connection:"복지로 UIA · 공개 후보 "+next.elements.length+"개"+(next.partial?" · 일부만 수집":"")});
    if(ui.status==="idle"&&!goal)emit({text:"복지로 화면을 확인했습니다. 목표를 입력해 안내를 요청하세요."});
    if(pendingGuide){const advance=pendingAdvance;cancelPending();if(advance)void command("advance");else void infer();return;}
    renderHighlight();
  };
  let stopWatch=watchChrome(receive);
  const meaning=source=>JSON.stringify([source.context,source.elements.filter(e=>e.enabled&&!e.offscreen).map(e=>[e.name,e.role]).sort()]);
  async function infer(){
    if(!snapshot && ['target_rechecking','target_changed_during_read'].includes(lastReason)){waitForSnapshot();emit({status:"waiting",text:"현재 화면의 접근성 정보를 다시 확인합니다."});return;}
    if(!snapshot || !snapshot.elements.length){emit({status:"error",text:"현재 읽을 수 있는 공개 접근성 후보가 없습니다. 임의 요소로 안내하지 않습니다."});return;}
    const source=snapshot,version=revision;
    emit({status:"waiting",text:"로컬 서버의 공통 생성 모델로 다음 단계 하나를 확인합니다."});
    queue.submit(signal=>guideStep(goal,source,progress,signal,clarifications),(error,result)=>{
      if(stopped || version!==revision || mode!=="screen" || snapshot?.signature!==source.signature)return;
      if(error){emit({status:"error",text:"로컬 화면 안내를 확인하지 못했습니다. API·공통 모델·DESKTOP_GUIDANCE_ENABLED 설정을 확인하세요."});return;}
      if(result.action==="안내"&&!snapshot.elements.some(e=>e.id===result.target_id&&e.enabled&&!e.offscreen)){
        emit({status:"error",text:"안내 대상이 현재 화면에 보이지 않아 안내를 보류했습니다. 화면을 확인한 뒤 다시 요청하세요."});return;
      }
      previousMeaning=meaning(source);
      baseline=new Set(source.elements.filter(e=>e.enabled&&!e.offscreen).map(e=>e.name));
      step=result;
      emit({status:"guide",text:result.instruction,expectedLabel:result.expect_label,awaitingClarification:result.action==="추가질문",model:result.model,screenMessages:[...ui.screenMessages,{role:"assistant",text:result.instruction}].slice(-12)});
      renderHighlight();
    });
  }
  async function command(action,payload){
    if(["goal","advance"].includes(action) && mode!=="screen")throw new Error("screen_mode_required");
    if(action==="rag" && mode!=="rag")throw new Error("rag_mode_required");
    if(action==="mode"){
      if(!["screen","rag","demo"].includes(payload))throw new Error("invalid_mode");
      cancelPending();invalidate();clearDemo();
      if(payload==="demo") {stopWatch();snapshot=null;}
      else if(mode==="demo") stopWatch=watchChrome(receive);
      mode=payload;manual=true;
      emit({mode,status:"idle",text:payload==="screen"?"목표를 입력하고 현재 접근성 요소로 안내를 요청하세요.":payload==="rag"?"기존 로컬 RAG API를 사용합니다. 서버가 없으면 연결할 수 없습니다.":"개발용 고정 시나리오입니다. 실제 화면 안내가 아닙니다."});return;
    }
    if(action==="goal"){
      cancelPending();
      let input;try {input=safeGoal(payload);}catch{emit({status:"error",text:"개인정보·숫자 코드 없이 안내받을 목표만 짧게 입력하세요."});return;}
      const followUp=ui.awaitingClarification&&goal;
      if(followUp){clarifications.push({question:ui.screenMessages.at(-1).text,answer:input});if(clarifications.length>3)clarifications.shift();}
      else{goal=input;progress.length=0;clarifications.length=0;}
      invalidate();
      emit({expectedLabel:null,awaitingClarification:false,screenMessages:[...(followUp?ui.screenMessages:[]),{role:"user",text:input}].slice(-12)});await infer();return;
    }
    if(action==="advance"){
      if(goal && !snapshot && ['target_rechecking','target_changed_during_read'].includes(lastReason)){waitForSnapshot();pendingAdvance=true;emit({status:"waiting",text:"현재 화면의 접근성 정보를 다시 확인합니다."});return;}
      if(!goal || !snapshot){emit({text:"먼저 복지로와 사용자 목표를 확인하세요."});return;}
      if(meaning(snapshot)===previousMeaning){emit({text:"이전과 같은 요소 상태입니다. 클릭만으로 완료를 판단하지 않습니다."});return;}
      // 예상 라벨은 실제 수집에서 새로 나타난 경우에만 진행 기록에 추가한다.
      if(ui.expectedLabel) {
        const observed=!baseline.has(ui.expectedLabel) && snapshot.elements.some(e=>e.name===ui.expectedLabel && e.enabled && !e.offscreen);
        if(observed)progress.push(ui.expectedLabel);
      }
      await infer();return;
    }
    if(action==="rag"){
      let query=typeof payload==="string"?payload.trim():"";if(!query||query.length>300){emit({status:"error",text:"질문은 1~300자로 입력하세요."});return;}
      if(ragController)return;
      const version=revision,controller=new AbortController();ragController=controller;
      const timer=setTimeout(()=>controller.abort(),90000);
      emit({status:"waiting",text:"로컬 RAG 서버 응답을 기다립니다.",ragMessages:[...ui.ragMessages,{role:"user",text:query}].slice(-12)});
      try{const response=await ragAnswer(query,controller.signal);if(version===revision&&mode==="rag")emit({status:"guide",text:"기존 RAG 응답",ragMessages:[...ui.ragMessages,{role:"assistant",...response}].slice(-12)});}
      catch{if(version===revision&&mode==="rag")emit({status:"error",text:"로컬 RAG 서버에 연결하지 못했습니다. 서버를 준비하세요. EC2로 우회하지 않습니다."});}
      finally{clearTimeout(timer);if(ragController===controller)ragController=null;}return;
    }
    if(action==="reset"){cancelPending();invalidate();goal="";previousMeaning="";progress.length=0;clarifications.length=0;emit({status:"idle",text:"진행을 초기화했습니다.",awaitingClarification:false,expectedLabel:null,screenMessages:[]});}
  }
  return {command,renderHighlight,get mode(){return mode;},state:()=>ui,manualOpen(){manual=true;suppressed="";stopWatch.discover?.();emit({});},hidden(){cancelPending();suppressed=siteKey();manual=false;invalidate();emit({status:"idle",text:"사용자가 안내를 숨겼습니다. 트레이에서 다시 열 수 있습니다."});},collapsed(value){cancelPending();ui.collapsed=value;invalidate();emit({status:"idle",text:"안내를 중지했습니다. 펼친 뒤 현재 화면으로 다시 요청하세요."});},stop(){stopped=true;cancelPending();invalidate();clearTimeout(expiry);stopWatch();}};
}
module.exports={assistant};
