const {watchMessage}=require("./watch-status.cjs");
const {watchChrome}=require("./chrome-watch.cjs");
const {safeGoal,realHighlight}=require("./assistant-policy.cjs");
const {guideStep,ragAnswer,LatestGuide}=require("./local-clients.cjs");
const {overlayLayout}=require("./overlay-layout.cjs");
const {screen}=require("electron");
function assistant({panel,overlay,overlayPresenter,panelWindow="0",overlayWindow="0",publish,clearDemo,ownFocused,autoOpen=true}) {
  let mode="screen",snapshot=null,revision=0,goal="",step=null,suppressed="",manual=false,ragController=null,stopped=false;
  let knownSiteKey="",pendingGuide=false,requestedAt=0,serial=0,expiry,pendingTimer;
  const queue=new LatestGuide(),clarifications=[];
  const presenter=overlayPresenter;
  let ui={mode,status:"idle",text:"Chrome에서 복지로를 열고 현재 화면에 관해 질문하세요.",connection:"대기",screenMessages:[],ragMessages:[],model:"서버 OLLAMA_LLM 공유",currentStepId:null};
  const emit=update=>{ui={...ui,...update};publish(ui);};
  const hide=()=>{if(presenter)presenter.hide();else overlay.hide();};
  const cancelPending=()=>{pendingGuide=false;clearTimeout(pendingTimer);};
  const invalidate=()=>{revision++;queue.cancel();ragController?.abort();ragController=null;step=null;ui.currentStepId=null;hide();};
  const siteKey=()=>snapshot?.context.split(":").slice(0,2).join(":")||knownSiteKey;
  function currentReply(text){
    if(!step)return;
    if(ui.text===text&&ui.currentStepId===step.serial)return;
    emit({text,currentStepId:step.serial,screenMessages:ui.screenMessages.map(m=>m.stepId===step.serial?{...m,text}:m)});
  }
  function renderHighlight(){
    if(mode!=="screen"||ui.status!=="guide"||!panel.isVisible()||ui.collapsed||step?.action!=="안내"){hide();return;}
    const {rect,reason}=realHighlight(snapshot,step.target_id,r=>{
      const inOneDisplay=screen.getAllDisplays().some(d=>{const b=screen.dipToScreenRect(null,d.bounds);return r.x>=b.x&&r.y>=b.y&&r.x+r.width<=b.x+b.width&&r.y+r.height<=b.y+b.height;});
      return inOneDisplay?screen.screenToDipRect(null,{x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)}):null;
    },screen.getAllDisplays().map(d=>d.workArea),panel.getBounds(),!!snapshot&&(snapshot.active&&!ownFocused()||snapshot.panelFocused&&ownFocused()));
    const messages={inactive:"현재 복지로 화면을 다시 확인하는 동안 표시를 멈췄습니다.",missing:"이전 대상이 현재 화면에 없습니다.",disabled:"대상 버튼이 비활성입니다.",modal_covered:"열린 대화상자 뒤의 대상이라 표시를 멈췄습니다.",offscreen:"대상이 현재 화면에 보이지 않습니다.",occluded:"대상이 다른 요소로 가려져 있습니다.",outside_viewport:"대상이 페이지 표시 영역 밖에 있습니다.",display_unknown:"대상의 화면 배율과 위치를 확인하지 못했습니다.",panel_covered:"도움 패널이 대상을 가립니다. 패널을 옆으로 옮겨 주세요."};
    if(!rect){hide();currentReply(messages[reason]||"대상 표시를 보류했습니다.");return;}
    const target=snapshot.elements.find(e=>e.id===step.target_id),area=screen.getDisplayMatching(rect).workArea;
    const viewport=screen.screenToDipRect(null,snapshot.viewport);
    const layout=overlayLayout(rect,area,panel.getBounds(),target.name,viewport);
    if(!layout){hide();currentReply("대상 옆에 안내를 표시할 공간이 부족합니다. 패널을 옮겨 주세요.");return;}
    const current=step,version=revision;
    const ready=()=>{
      if(step!==current||revision!==version||!panel.isVisible()||ui.collapsed)return;
      currentReply(`${current.instruction}\n화면 ${layout.direction}에서 파란 테두리로 표시한 ‘${target.name}’을 눌러 주세요.`);
    };
    if(presenter)presenter.present(layout,ready);
    else{overlay.setBounds(layout.bounds);overlay.showInactive();ready();}
  }
  const receive=(next,reason,presence)=>{
    if(stopped||mode==="demo")return;
    clearTimeout(expiry);
    expiry=setTimeout(()=>{snapshot=null;cancelPending();invalidate();emit({status:"idle",text:"화면 정보가 오래되어 표시를 멈췄습니다. 현재 화면으로 다시 질문하세요.",currentStepId:null});},3500);
    const old=snapshot;snapshot=next;
    if(presence)knownSiteKey=presence.key;
    if(next)knownSiteKey=next.context.split(":").slice(0,2).join(":");
    if(!next){
      const transient=["target_rechecking","target_changed_during_read"].includes(reason);
      hide();
      if(transient&&step?.action==="안내")currentReply(watchMessage(reason));
      if(transient&&ui.status==="waiting"&&!pendingGuide){invalidate();emit({status:"idle",currentStepId:null});}
      if(!transient){cancelPending();invalidate();if(!manual&&!presence)panel.hide();}
      if(autoOpen&&presence?.active&&suppressed!==presence.key){manual=false;panel.showInactive();}
      emit({connection:presence?"복지로 주소 확인 · 페이지 정보 미확인":"미확인",text:watchMessage(reason),currentStepId:transient?ui.currentStepId:null});
      return;
    }
    if(old&&old.signature!==next.signature||step&&step.signature!==next.signature){invalidate();emit({status:pendingGuide?"waiting":"idle",text:"화면이 바뀌어 이전 표시를 지웠습니다. 필요한 내용을 질문하세요.",currentStepId:null});}
    if(autoOpen&&next.active&&suppressed!==siteKey()&&!panel.isVisible()){
      const physical=next.viewport;
      const browser=screen.screenToDipRect(null,{x:Math.floor(physical.x),y:Math.floor(physical.y),width:Math.ceil(physical.width),height:Math.ceil(physical.height)});
      const area=screen.getDisplayMatching(browser).workArea,size=panel.getBounds();
      const right=browser.x+browser.width+12,left=browser.x-size.width-12;
      const x=right+size.width<=area.x+area.width?right:left>=area.x?left:area.x+area.width-size.width;
      panel.setPosition(Math.round(Math.max(area.x,x)),Math.round(Math.max(area.y,Math.min(browser.y,area.y+area.height-size.height))));panel.showInactive();
    }
    if(next.active)manual=false;
    emit({connection:"복지로 · 공개 요소 "+next.elements.length+"개"+(next.partial?" · 일부만 확인":"")});
    if(pendingGuide&&next.verifiedAt>=requestedAt&&(next.active||next.panelFocused)){cancelPending();void infer();return;}
    renderHighlight();
  };
  let stopWatch=watchChrome(receive,panelWindow,overlayWindow);
  async function infer(){
    if(!snapshot){emit({status:"error",text:"현재 화면을 확인하지 못했습니다. 다시 질문하세요."});return;}
    const source=snapshot,version=revision;
    emit({status:"waiting",text:"현재 화면을 확인해 답변하고 있습니다."});
    queue.submit(signal=>guideStep(goal,source,[],signal,clarifications,null,()=>{
        if(!stopped&&version===revision&&mode==="screen")emit({status:"waiting",text:"서버가 처리 중입니다. 전체 요청 제한은 90초입니다."});
    }),(error,result)=>{
      if(stopped||version!==revision||mode!=="screen"||snapshot?.signature!==source.signature)return;
      if(error){
        const messages={guide_disabled:"화면 상담 API가 비활성입니다. 서버 설정을 확인하세요.",local_connection_failed:"로컬 API 연결이 끊겼습니다. 서버 확인 후 직접 다시 질문하세요.",guide_generation_failed:"화면 답변을 확인하지 못했습니다. 모델 준비 상태를 확인하세요.",guide_busy_exhausted:"서버가 계속 처리 중입니다. 잠시 후 직접 다시 질문하세요.",guide_timeout:"요청 제한 90초를 넘었습니다. 서버 확인 후 직접 다시 질문하세요.",guide_cancelled:"화면 질문을 취소했습니다."};
        hide();emit({status:"error",text:messages[error]||({guide_context_budget:"입력 예산을 확인하지 못했습니다. 서버 설정을 확인하세요.",guide_private_connection:"허용된 로컬 연결을 확인하지 못했습니다."})[error]||"답변 형식을 확인하지 못했습니다. 현재 화면과 서버 상태를 확인하세요."});return;
      }
      if(result.action==="안내"&&!snapshot.elements.some(e=>e.id===result.target_id&&e.enabled&&!e.offscreen&&!e.blocked)){
        emit({status:"error",text:"대상이 현재 화면에 없어 표시를 보류했습니다. 다시 질문하세요."});return;
      }
      step={...result,signature:source.signature,serial:++serial};
      const text=result.action==="안내"?"설명과 대상 표시를 함께 준비하고 있습니다.":result.instruction;
      emit({status:"guide",text,currentStepId:step.serial,awaitingClarification:result.action==="추가질문",model:result.model,screenMessages:[...ui.screenMessages,{role:"assistant",text,stepId:step.serial}].slice(-12)});
      renderHighlight();
    });
  }
  function requestScreen(){
    requestedAt=Date.now();pendingGuide=true;clearTimeout(pendingTimer);
    pendingTimer=setTimeout(()=>{cancelPending();emit({status:"error",text:"최신 화면을 확인하지 못했습니다. 복지로 화면에서 다시 질문하세요."});},5000);
    emit({status:"waiting",text:"질문 시점의 복지로 창과 탭을 확인합니다."});stopWatch.refresh?.();
  }
  async function command(action,payload){
    if(["goal","advance"].includes(action)&&mode!=="screen")throw new Error("screen_mode_required");
    if(action==="rag"&&mode!=="rag")throw new Error("rag_mode_required");
    if(action==="mode"){
      if(!["screen","rag","demo"].includes(payload))throw new Error("invalid_mode");
      cancelPending();invalidate();clearDemo();
      if(payload==="demo"){stopWatch();snapshot=null;}else if(mode==="demo")stopWatch=watchChrome(receive,panelWindow,overlayWindow);
      mode=payload;manual=true;emit({mode,status:"idle",currentStepId:null,awaitingClarification:false,text:payload==="screen"?"현재 화면에서 궁금한 내용을 질문하세요.":payload==="rag"?"기존 로컬 RAG API를 사용합니다.":"개발용 고정 시나리오입니다. 실제 화면 상담이 아닙니다."});return;
    }
    if(action==="goal"){
      if(payload&&typeof payload==="object"&&Object.keys(payload).some(key=>key!=="question")){emit({status:"error",text:"질문 텍스트만 전달해 주세요."});return;}
      let input;try{input=safeGoal(typeof payload==="string"?payload:payload?.question);}catch{emit({status:"error",text:"개인정보·숫자 코드 없이 질문을 짧게 입력하세요."});return;}
      const followUp=ui.awaitingClarification&&goal;
      if(followUp){clarifications.push({question:step?.instruction||ui.screenMessages.at(-1).text,answer:input});if(clarifications.length>3)clarifications.shift();}
      else{goal=input;clarifications.length=0;}
      cancelPending();invalidate();emit({currentStepId:null,awaitingClarification:false,screenMessages:[...ui.screenMessages,{role:"user",text:input}].slice(-12)});requestScreen();return;
    }
    if(action==="advance"){if(goal){cancelPending();invalidate();requestScreen();}return;}
    if(action==="rag"){
      const query=typeof payload==="string"?payload.trim():"";if(!query||query.length>300){emit({status:"error",text:"질문은 1~300자로 입력하세요."});return;}
      if(ragController)return;
      const version=revision,controller=new AbortController();ragController=controller;
      const timer=setTimeout(()=>controller.abort(),90000);
      emit({status:"waiting",text:"로컬 RAG 서버 응답을 기다립니다.",ragMessages:[...ui.ragMessages,{role:"user",text:query}].slice(-12)});
      try{const response=await ragAnswer(query,controller.signal);if(version===revision&&mode==="rag")emit({status:"guide",text:"기존 RAG 응답",ragMessages:[...ui.ragMessages,{role:"assistant",...response}].slice(-12)});}
      catch{if(version===revision&&mode==="rag")emit({status:"error",text:"RAG 서버에 연결하지 못했습니다. 서버 확인 후 직접 다시 질문하세요."});}
      finally{clearTimeout(timer);if(ragController===controller)ragController=null;}return;
    }
    if(action==="reset"){cancelPending();invalidate();goal="";clarifications.length=0;emit({status:"idle",text:"새 화면 질문을 입력하세요.",awaitingClarification:false,currentStepId:null,screenMessages:[]});}
  }
  return {command,renderHighlight,get mode(){return mode;},state:()=>ui,manualOpen(){manual=true;suppressed="";stopWatch.discover?.();emit({});},hidden(){cancelPending();suppressed=siteKey();manual=false;invalidate();emit({status:"idle",currentStepId:null,text:"트레이에서 다시 열 수 있습니다."});},collapsed(value){cancelPending();ui.collapsed=value;invalidate();emit({status:"idle",currentStepId:null,text:"현재 안내를 중지했습니다. 펼친 뒤 다시 질문하세요."});},stop(){stopped=true;cancelPending();invalidate();clearTimeout(expiry);stopWatch();}};
}
module.exports={assistant};
