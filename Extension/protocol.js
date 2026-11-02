(() => {
  const documentDeployment=Object.freeze({origin:'http://127.0.0.1:8000',timeoutSeconds:600});
  const localDocumentOrigin='http://127.0.0.1:8000';
  function validateDocumentOrigin(value){
    try{
      if(typeof value!=='string'||value!==value.trim())throw new Error();
      const url=new URL(value);
      if(value===localDocumentOrigin)return value;
      if(url.protocol!=='https:'||url.origin!==value||url.username||url.password||url.hostname.includes('*')||!url.hostname||url.hostname.endsWith('.')||url.port==='0')throw new Error();
      const hostname=url.hostname;
      if(hostname.startsWith('[')){
        if(!/^\[[0-9a-f:]+\]$/i.test(hostname))throw new Error();
      }else if(hostname.length>253||hostname.split('.').some(label=>! /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)))throw new Error();
      return value;
    }catch{throw new Error('connection_configuration_invalid');}
  }
  function validateDocumentTimeout(value){if(!Number.isInteger(value)||value<1||value>1800)throw new Error('connection_configuration_invalid');return value;}
  const documentOrigin=()=>{validateDocumentTimeout(documentDeployment.timeoutSeconds);return validateDocumentOrigin(documentDeployment.origin);};
  const screenAvailable=()=>documentOrigin()===localDocumentOrigin;
  const documentTimeoutSeconds=connection=>screenAvailable()&&connection?.timeoutSeconds!==undefined?timeoutSeconds(connection):validateDocumentTimeout(documentDeployment.timeoutSeconds);
  const id=value=>typeof value==='string'&&/^[A-F0-9]{20}$/.test(value);
  const text=(value,max)=>typeof value==='string'&&value.trim()&&value.length<=max&&!/\d{4,}|@|[<>\x00-\x08]|주민등록|인증번호|인증코드|비밀번호|password|\bOTP\b/i.test(value);
  const official=value=>{try{const u=new URL(value);return u.origin==='https://www.bokjiro.go.kr'&&!u.username&&!u.password;}catch{return false;}};
  function timeoutSeconds(connection){
    const value=connection?.timeoutSeconds===undefined?90:connection.timeoutSeconds;
    if(!Number.isInteger(value)||value<1||value>1800)throw new Error('connection_required');
    return value;
  }
  function request(payload){
    if(payload&&(Object.hasOwn(payload,'profile')||Object.hasOwn(payload,'conversation_context')))throw new Error('invalid_request');
    if(!payload||payload.source!=='dom'||!id(payload.snapshot_id)||!text(payload.question,240)||!Array.isArray(payload.candidates)||payload.candidates.length>60||!Array.isArray(payload.screen_context)||payload.screen_context.length>8)throw new Error('invalid_request');
    const ids=new Set();
    if(payload.timeout_seconds!==undefined&&(!Number.isInteger(payload.timeout_seconds)||payload.timeout_seconds<1||payload.timeout_seconds>1800))throw new Error('invalid_request');
    let budget=0;
    for(const c of payload.candidates){if(!id(c.id)||ids.has(c.id)||!text(c.label,80)||c.context&&!text(c.context,100)||!['Button','Hyperlink','MenuItem','Input','ComboBox','CheckBox','RadioButton'].includes(c.role)||typeof c.enabled!=='boolean'||typeof c.visible!=='boolean')throw new Error('invalid_request');ids.add(c.id);budget+=c.label.length+(c.context?.length||0);}
    for(const item of payload.screen_context){if(!['heading','text','label','help'].includes(item.kind)||!text(item.text,160))throw new Error('invalid_request');budget+=item.text.length;}
    if(budget>4000||payload.title&&!text(payload.title,120)||payload.image&&(typeof payload.image!=='string'||payload.image.length>2*1024*1024||!/^iVBOR[A-Za-z0-9+/=]+$/.test(payload.image)))throw new Error('invalid_request');
    const history=payload.history||[];
    if(!Array.isArray(history)||history.length>4||history.some(h=>!['user','assistant'].includes(h.role)||!text(h.text,420))||history.reduce((n,h)=>n+h.text.length,0)>1000)throw new Error('invalid_request');
    return payload;
  }
  function reply(body,payload){
    const r=body?.reply;
    if(!r||r.snapshot_id!==payload.snapshot_id||!['설명','안내','추가질문','보류'].includes(r.kind)||!text(r.answer,420)||!Array.isArray(r.targets)||r.targets.length>3||Object.keys(r).sort().join(',')!=='answer,kind,snapshot_id,targets')throw new Error('invalid_reply');
    const ids=new Set();
    for(const t of r.targets){const c=payload.candidates.find(c=>c.id===t.target_id);if(!c||!c.visible||!c.enabled||payload.modal_open&&!c.in_modal||ids.has(t.target_id)||!text(t.meaning,100)||Object.keys(t).sort().join(',')!=='meaning,target_id')throw new Error('invalid_reply');ids.add(t.target_id);}
    if(['추가질문','보류'].includes(r.kind)&&r.targets.length||r.kind==='안내'&&!r.targets.length)throw new Error('invalid_reply');
    if([r.answer,...r.targets.map(t=>t.meaning)].some(v=>/파란|파랑|주황|보라|①|②|③|\d+\s*번|왼쪽|오른쪽|위쪽|아래쪽|좌표|javascript:|querySelector/i.test(v)))throw new Error('invalid_reply');
    return r;
  }
  // 문서 원문에는 연도·금액·기호가 있으므로 화면 라벨의 제한을 적용하지 않는다.
  // Python 문서 정책과 동일한 길이·구분자를 사용하며 실제 소유자는 판별하지 않는다.
  const resident=/(?<![0-9])[0-9]{6}[ \t-]*[1-8][0-9]{6}(?![0-9])/g;
  const mobile=/(?<![0-9])01[016789][ \t-]*[0-9]{3,4}[ \t-]*[0-9]{4}(?![0-9])/g;
  const account=/(?:계좌(?:[ \t]*번호)?|account(?:[ \t]*number)?)(?:는|은)?[ \t]*[:：=]?[ \t]*[0-9](?:[ \t-]*[0-9]){8,15}(?![0-9]|[ \t-]+[0-9]|[ \t]*(?:만|억)?[ \t]*원)/gi;
  const personalMobile=/(?:개인|신청자|수급자|본인|내)(?:의)?[ \t]*(?:휴대(?:전화|폰)(?:번호)?|연락처|전화(?:번호)?)(?:는|은)?[ \t]*[:：=]?[ \t]*01[016789][ \t-]*[0-9]{3,4}[ \t-]*[0-9]{4}(?![0-9])/g;
  const maskText=(value,userHistory=false)=>[resident,account,userHistory?mobile:personalMobile].reduce((v,pattern)=>v.replace(pattern,'[개인정보 가림]'),value);
  const sensitiveInput=value=>maskText(value,true)!==value;
  const displayFields=new Set(['text','quote','context','heading_context','source_url','sourceUrl','url','name','title','summary','label','phone','suggestions','ministry','department','category','keywords','eligibility','benefit','howToApply','region_scope','source_organization']);
  function redactDocument(value,displayText=true){
    if(typeof value==='string')return displayText?maskText(value):value;
    if(Array.isArray(value))return value.map(item=>redactDocument(item,displayText));
    if(value&&typeof value==='object'){
      // ID·해시·원문 위치는 보존하고 표시 필드만 가린다.
      const result=Object.fromEntries(Object.entries(value).map(([key,item])=>[key,redactDocument(item,displayFields.has(key))]));
      if('chunk_id' in value&&JSON.stringify(result)!==JSON.stringify(value))result.redacted=true;
      return result;
    }
    return value;
  }
  const privacy=Object.freeze({sensitiveInput,maskText,redactDocument});
  const regions=Object.freeze(['서울특별시','부산광역시','대구광역시','인천광역시','광주광역시','대전광역시','울산광역시','세종특별자치시','경기도','강원특별자치도','충청북도','충청남도','전북특별자치도','전라남도','경상북도','경상남도','제주특별자치도']);
  function profile(value){
    if(value===null)return null;
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['age','income','household','region','disability'].includes(key)))throw new Error('invalid_profile');
    const age=value.age===undefined?null:value.age,income=value.income===undefined?'unknown':value.income;
    const household=value.household===undefined?null:value.household,region=value.region===undefined?null:value.region,disability=value.disability===undefined?null:value.disability;
    if(age!==null&&(!Number.isInteger(age)||age<0||age>120)||!['under50','under100','under150','over150','unknown'].includes(income)||household!==null&&!['single','couple','withChildren','singleParent','grandparent','other'].includes(household)||region!==null&&!regions.includes(region)||disability!==null&&typeof disability!=='boolean')throw new Error('invalid_profile');
    return {age,income,household,region,disability};
  }
  function profileRecord(value){
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='onboardingCompleted,profile,revision,schemaVersion'||value.schemaVersion!==1||!Number.isSafeInteger(value.revision)||value.revision<0||typeof value.onboardingCompleted!=='boolean')throw new Error('profile_data_invalid');
    const normalized=profile(value.profile);
    if(!value.onboardingCompleted&&normalized!==null)throw new Error('profile_data_invalid');
    return {schemaVersion:1,revision:value.revision,onboardingCompleted:value.onboardingCompleted,profile:normalized};
  }
  const documentText=(value,max)=>typeof value==='string'&&!!value.trim()&&value.length<=max;
  const messageId=value=>typeof value==='string'&&/^[A-F0-9]{20}:(user|assistant)$/.test(value);
  const contextText=(value,max=1200)=>typeof value==='string'&&value.length<=max&&!sensitiveInput(value)&&!/<[^>]*>|\bBearer\s+\S+|(?:password|비밀번호|api[_ -]?key|access[_ -]?token)\s*[:=：]\s*\S+/i.test(value);
  function conversationContext(value){
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['text','coveredThroughMessageId','profileRevision','batch','omitted'].includes(k))||!contextText(value.text)||!Number.isSafeInteger(value.profileRevision)||value.profileRevision<0||!Array.isArray(value.batch)||value.batch.length>6||value.batch.length%2||typeof value.omitted!=='boolean')throw new Error('invalid_context');
    if(!!value.text.trim()!==(value.coveredThroughMessageId!==null)||value.coveredThroughMessageId!==null&&(!messageId(value.coveredThroughMessageId)||!value.coveredThroughMessageId.endsWith(':assistant')))throw new Error('invalid_context');
    let size=0;const ids=new Set();
    const batch=value.batch.map((m,index)=>{
      const role=index%2?'assistant':'user';
      if(!m||Object.keys(m).sort().join(',')!=='content,id,role'||!messageId(m.id)||!m.id.endsWith(':'+role)||m.role!==role||!documentText(m.content,6000)||!contextText(m.content,6000)||ids.has(m.id)||m.id===value.coveredThroughMessageId||index%2&&m.id.split(':')[0]!==value.batch[index-1].id.split(':')[0])throw new Error('invalid_context');
      ids.add(m.id);size+=m.content.length;return {id:m.id,role:m.role,content:m.content};
    });
    if(size>6000)throw new Error('invalid_context');
    return {text:value.text,coveredThroughMessageId:value.coveredThroughMessageId,profileRevision:value.profileRevision,batch,omitted:value.omitted};
  }
  function contextUpdate(value){
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='coveredThroughMessageId,profileRevision,status,text'||!['updated','unchanged','failed','omitted'].includes(value.status)||!contextText(value.text)||!Number.isSafeInteger(value.profileRevision)||value.profileRevision<0||!!value.text.trim()!==(value.coveredThroughMessageId!==null)||value.coveredThroughMessageId!==null&&(!messageId(value.coveredThroughMessageId)||!value.coveredThroughMessageId.endsWith(':assistant')))throw new Error('invalid_context_update');
    return {status:value.status,text:value.text,coveredThroughMessageId:value.coveredThroughMessageId,profileRevision:value.profileRevision};
  }
  function contextUsage(value){
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).join(',')!=='omitted'||typeof value.omitted!=='boolean')throw new Error('invalid_context_update');
    return {omitted:value.omitted};
  }
  function documentRequest(payload){
    if(payload&&(typeof payload.query==='string'&&sensitiveInput(payload.query)||Array.isArray(payload.history)&&payload.history.some(h=>typeof h?.content==='string'&&sensitiveInput(h.content))))throw new Error('sensitive_input');
    if(!payload||Object.keys(payload).some(k=>!['query','history','timeout_seconds','profile','conversation_context'].includes(k))||!documentText(payload.query,300)||payload.timeout_seconds!==undefined&&(!Number.isInteger(payload.timeout_seconds)||payload.timeout_seconds<1||payload.timeout_seconds>1800))throw new Error('invalid_request');
    const history=payload.history||[];
    if(!Array.isArray(history)||history.length>12||history.some(h=>!h||!['user','assistant'].includes(h.role)||!documentText(h.content,6000)||Object.keys(h).some(k=>!['role','content'].includes(k)))||history.reduce((n,h)=>n+h.content.length,0)>6000)throw new Error('invalid_request');
    return {query:payload.query,history,...(payload.timeout_seconds===undefined?{}:{timeout_seconds:payload.timeout_seconds}),...(Object.hasOwn(payload,'profile')?{profile:profile(payload.profile)}:{}),...(Object.hasOwn(payload,'conversation_context')?{conversation_context:conversationContext(payload.conversation_context)}:{})};
  }
  function documentReply(body,submitted){
    if(!body||!['answer','fallback'].includes(body.kind)||!documentText(body.text,60000)||body.evidence!==undefined&&!Array.isArray(body.evidence))throw new Error('invalid_reply');
    const evidence=body.evidence||[];
    if(evidence.length>60||evidence.some(e=>!e||typeof e.chunk_id!=='string'||typeof e.document_id!=='string'||typeof e.context!=='string'||typeof e.quote!=='string'||typeof e.source_url!=='string'||!Array.isArray(e.pages)||e.pages.some(p=>!Number.isInteger(p)||p<1)||!Array.isArray(e.source_blocks)||e.source_blocks.some(b=>typeof b!=='string')))throw new Error('invalid_reply');
    const update=Object.hasOwn(body,'context_update')?contextUpdate(body.context_update):undefined;
    if(update&&submitted!==undefined){
      if(!submitted||update.profileRevision!==submitted.profileRevision||update.status==='updated'&&(!submitted.batch.length||update.coveredThroughMessageId!==submitted.batch.at(-1).id||!update.text.trim())||update.status!=='updated'&&(update.text!==submitted.text||update.coveredThroughMessageId!==submitted.coveredThroughMessageId))throw new Error('invalid_context_update');
    }
    return redactDocument({kind:body.kind,text:body.text,evidence,...(update?{context_update:update}:{}),...(Object.hasOwn(body,'context_usage')?{context_usage:contextUsage(body.context_usage)}:{})});
  }
  const adminSession=(value)=>!!value&&typeof value.token==='string'&&/^[A-Za-z0-9_-]{32,256}$/.test(value.token)&&Number.isInteger(value.expiresAt)&&value.expiresAt>Date.now()/1000;
  const documentSession=value=>adminSession(value)&&Object.keys(value).every(key=>['token','expiresAt','origin'].includes(key))&&(value.origin===documentOrigin()||value.origin===undefined&&screenAvailable());
  const api={id,text,official,request,reply,timeoutSeconds,documentTimeoutSeconds,documentRequest,documentReply,adminSession,documentSession,documentOrigin,screenAvailable,validateDocumentOrigin,validateDocumentTimeout,privacy,profile,profileRecord,regions,conversationContext,contextUpdate,contextUsage};globalThis.GyeoteProtocol=Object.freeze(api);
  if(typeof module!=='undefined')module.exports=api;
})();
