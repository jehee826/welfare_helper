(() => {
  const roles = new Map([["BUTTON", "Button"], ["A", "Hyperlink"], ["INPUT", "Input"], ["SELECT", "ComboBox"], ["TEXTAREA", "Input"]]);
  const ariaRoles = {button:"Button",link:"Hyperlink",menuitem:"MenuItem",combobox:"ComboBox",checkbox:"CheckBox",radio:"RadioButton"};
  const controls = 'button,a[href],input:not([type="hidden"]),select,textarea,[role="button"],[role="link"],[role="menuitem"],[role="combobox"],[role="checkbox"],[role="radio"]';
  const privateField = 'input[type="password"],input[autocomplete="one-time-code"],input[autocomplete^="cc-"],input[autocomplete="name"],input[autocomplete="tel"],input[autocomplete="email"],input[autocomplete="street-address"],[data-private],[contenteditable="true"]';
  const id = () => crypto.randomUUID().replaceAll("-", "").slice(0,20).toUpperCase();
  const safeText = (value,limit=160) => {
    const text=String(value||"").replace(/\s+/g," ").trim();
    if(!text||text.length>limit||/\d{4,}|@|[<>\x00-\x08]|주민등록|인증번호|인증코드|비밀번호|password|\bOTP\b/i.test(text))return "";
    return text;
  };
  const official=()=>{const u=new URL(location.href);return u.origin==='https://www.bokjiro.go.kr'&&!u.username&&!u.password;};
  const within=(a,b)=>b.left>=a.left&&b.top>=a.top&&b.right<=a.right&&b.bottom<=a.bottom;
  const parentOf=node=>node.parentElement||(node.getRootNode() instanceof ShadowRoot?node.getRootNode().host:null);
  function excluded(node){
    for(let parent=node,depth=0;parent&&depth<50;parent=parentOf(parent),depth++)if(parent.matches('input,textarea,select,[contenteditable],[data-private],[data-gyeote-host],script,style'))return true;
    return false;
  }
  function publicRoots(){
    const roots=[document];let count=0;
    for(let cursor=0;cursor<roots.length;cursor++){
      if(roots.length>16)throw new Error('screen_scope_limit');
      for(const node of roots[cursor].querySelectorAll('*')){
        if(++count>10000)throw new Error('screen_scope_limit');
        if(node.matches('[data-gyeote-host]'))continue;
        if(node.shadowRoot)roots.push(node.shadowRoot);
      }
    }
    return roots;
  }
  function visible(node) {
    if(!node?.isConnected||!(node instanceof Element)||node.closest('[data-gyeote-host],[hidden],[aria-hidden="true"],dialog:not([open])'))return false;
    const style=getComputedStyle(node),r=node.getBoundingClientRect();
    for(let parent=parentOf(node),depth=0;parent&&depth<50;parent=parentOf(parent),depth++){
      const s=getComputedStyle(parent);
      if(parent.matches('[hidden],[aria-hidden="true"],[data-gyeote-host]')||s.display==='none'||s.visibility!=='visible'||Number(s.opacity)===0)return false;
    }
    return style.display!=="none"&&style.visibility==="visible"&&Number(style.opacity)!==0&&r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth;
  }
  function publicPage(){
    if(!official()||/login|auth|mypage|myPage|apply|application/i.test(location.pathname))return false;
    const roots=publicRoots();
    if(roots.some(root=>[...root.querySelectorAll(privateField)].some(visible)))return false;
    return !roots.some(root=>[...root.querySelectorAll('a,button,h1,h2')].some(n=>visible(n)&&/^(로그아웃|나의 신청내역|개인정보 입력|본인인증)$/.test(n.textContent.trim())));
  }
  function textOf(node,limit=160){
    if(!node||excluded(node)||!visible(node))return "";
    const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT),parts=[];let current,visited=0;
    // 복제본 textContent는 CSS로 숨긴 자식을 포함하므로 원본 가시성을 검사한다.
    while((current=walker.nextNode())&&visited++<100){
      const parent=current.parentElement;
      if(parent&&!excluded(parent)&&visible(parent))parts.push(current.nodeValue);
      if(parts.join(' ').length>limit)return "";
    }
    return safeText(parts.join(' '),limit);
  }
  function nameOf(node){
    let name=safeText(node.getAttribute("aria-label"),80);
    if(!name){
      const labelled=node.getAttribute("aria-labelledby");
      if(labelled&&labelled.length<200)name=safeText(labelled.split(/\s+/).map(key=>textOf(node.getRootNode().getElementById?.(key),80)).join(" "),80);
    }
    if(!name&&node.labels)name=safeText([...node.labels].map(n=>textOf(n,80)).join(" "),80);
    if(!name&&!node.matches('input,textarea,select'))name=textOf(node,80);
    if(!name&&node.matches('input,textarea'))name=safeText(node.getAttribute("placeholder"),80);
    return name||safeText(node.getAttribute("title"),80);
  }
  const meaningOf=node=>JSON.stringify([node.getAttribute('role'),node.getAttribute('type'),node.tagName==='A'?node.href:null]);
  function activeModal(){
    const modals=publicRoots().flatMap(root=>[...root.querySelectorAll('dialog[open],[aria-modal="true"]')]).filter(visible);
    return modals.at(-1)||null;
  }
  function usable(node,modal=activeModal()){
    if(!visible(node)||node.matches(':disabled,[aria-disabled="true"]')||node.closest('[inert]'))return false;
    const r=node.getBoundingClientRect();
    if(!within({left:0,top:0,right:innerWidth,bottom:innerHeight},r))return false;
    if(modal&&!modal.contains(node))return false;
    let top=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
    for(let depth=0;top?.shadowRoot&&depth<8;depth++){const inner=top.shadowRoot.elementFromPoint?.(r.left+r.width/2,r.top+r.height/2);if(!inner||inner===top)break;top=inner;}
    return top===node||node.contains(top);
  }
  function bodyTarget(node){
    for(let parent=node,depth=0;parent&&depth<50;parent=parentOf(parent),depth++){
      if(parent.matches('header,nav,[role="banner"],[role="navigation"]')||['fixed','sticky'].includes(getComputedStyle(parent).position))return false;
    }
    return true;
  }
  const compact=value=>String(value||"").replace(/[\s\p{P}\p{S}]+/gu,"").toLowerCase();
  function landmarkOf(node){
    for(let parent=parentOf(node),depth=0;parent&&depth<50;parent=parentOf(parent),depth++){
      if(parent.matches('[role="search"]'))return safeText(parent.getAttribute('aria-label'),40)||'검색 영역';
      if(parent.matches('nav,[role="navigation"]'))return safeText(parent.getAttribute('aria-label'),40)||'탐색 메뉴';
      if(parent.matches('header,[role="banner"]'))return '머리글';
    }
    return '';
  }
  function matchScore(label,asked,tokens){
    const name=compact(label);
    return (name.length>1&&asked.includes(name)?8:0)+3*tokens.filter(token=>name.includes(token)).length+(tokens.some(token=>name.includes(token.slice(0,2)))?1:0);
  }
  function collect(question="",{bodyOnly=false}={}){
    if(!publicPage())throw new Error("public_screen_required");
    const modal=activeModal(),scope=modal||document.querySelector('main,[role="main"]')||document.body;
    const roots=[modal||document],nodes=[],seen=new Set();let inspected=0,partial=false;
    // 열린 Shadow DOM만 순회한다. HTML·스크립트·입력값은 직렬화하지 않는다.
    for(let cursor=0;cursor<roots.length&&cursor<12;cursor++){
      const root=roots[cursor];
      for(const node of root.querySelectorAll('*')){
        if(++inspected>3000){partial=true;break;}
        if(node.closest('[data-gyeote-host]'))continue;
        if(node.shadowRoot)roots.push(node.shadowRoot);
        if(node.matches(controls)&&visible(node)&&!seen.has(node)){seen.add(node);nodes.push(node);}
      }
      if(partial)break;
    }
    const asked=compact(question),tokens=question.split(/\s+/).map(compact).filter(word=>word.length>1);
    const candidates=nodes.map(node=>{
      if(bodyOnly&&!bodyTarget(node))return null;
      if(!usable(node,modal))return null;
      const label=nameOf(node);if(!label)return null;
      const role=ariaRoles[node.getAttribute('role')]||roles.get(node.tagName)||"Button";
      const context=safeText([textOf(node.closest('fieldset')?.querySelector('legend'),60),landmarkOf(node)].filter(Boolean).join(' · '),100);
      const score=matchScore(label,asked,tokens)+(scope.contains(node)?0.5:0);
      return {node,label,role,context,score};
    }).filter(Boolean).sort((a,b)=>b.score-a.score);
    if(candidates.length>60)partial=true;
    // 링크 목적지와 역할은 변경 감시에만 쓰고 서버 전송 자료에는 넣지 않는다.
    let textSize=0;
    // 요소 이름을 자르지 않고 우선순위대로 전체 전송 예산에 맞춘다.
    const refs=new Map(),meanings=new Map(),elements=candidates.slice(0,60).filter(({label,context})=>{const size=label.length+context.length;if(textSize+size>4000){partial=true;return false;}textSize+=size;return true;}).map(({node,label,role,context})=>{const element_id=id();refs.set(element_id,node);meanings.set(element_id,meaningOf(node));return {id:element_id,label,role,context,enabled:true,visible:true,in_modal:!!modal};});
    const context=[],anchorNodes=[];
    for(const root of [scope,...roots.filter(r=>r instanceof ShadowRoot)]){
      for(const node of root.querySelectorAll('h1,h2,h3,p,label,legend,[role="heading"]')){
        if(!visible(node)||node.closest('button,a,input,textarea,select,[data-gyeote-host]'))continue;
        const text=textOf(node);if(!text||context.some(c=>c.text===text))continue;
        if(context.length>=8){partial=true;break;}
        if(textSize+text.length>4000){partial=true;continue;}
        textSize+=text.length;
        context.push({kind:node.matches('h1,h2,h3,[role="heading"]')?'heading':node.matches('label,legend')?'label':'text',text});
        anchorNodes.push({node,text});
      }
    }
    const frameUnsupported=roots.some(root=>[...root.querySelectorAll('iframe,object,embed,canvas,video')].some(visible));
    return {payload:{source:"dom",snapshot_id:id(),title:safeText(document.title,120),candidates:elements,screen_context:context,modal_open:!!modal,partial:partial||frameUnsupported},refs,meanings,url:location.href,scope,modal,anchorNodes,scrollX,scrollY,width:innerWidth,height:innerHeight};
  }
  function currentCandidate(snapshot,candidate){
    const node=snapshot.refs.get(candidate.id);
    return !!node?.isConnected&&!node.matches(':disabled,[aria-disabled="true"]')&&nameOf(node)===candidate.label&&snapshot.meanings.get(candidate.id)===meaningOf(node);
  }
  function current(snapshot){return !!snapshot&&snapshot.url===location.href&&snapshot.scope.isConnected&&snapshot.modal===activeModal()&&snapshot.anchorNodes.every(a=>a.node.isConnected&&textOf(a.node)===a.text)&&snapshot.payload.candidates.every(c=>currentCandidate(snapshot,c));}
  globalThis.GyeoteDOM=Object.freeze({id,safeText,official,publicPage,visible,usable,collect,nameOf,textOf,activeModal,publicRoots,current,currentCandidate,bodyTarget});
})();
