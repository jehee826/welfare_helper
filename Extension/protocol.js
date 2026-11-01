(() => {
  const id=value=>typeof value==='string'&&/^[A-F0-9]{20}$/.test(value);
  const text=(value,max)=>typeof value==='string'&&value.trim()&&value.length<=max&&!/\d{4,}|@|[<>\x00-\x08]|주민등록|인증번호|인증코드|비밀번호|password|\bOTP\b/i.test(value);
  const official=value=>{try{const u=new URL(value);return u.origin==='https://www.bokjiro.go.kr'&&!u.username&&!u.password;}catch{return false;}};
  function timeoutSeconds(connection){
    const value=connection?.timeoutSeconds===undefined?90:connection.timeoutSeconds;
    if(!Number.isInteger(value)||value<1||value>1800)throw new Error('connection_required');
    return value;
  }
  function request(payload){
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
  const documentText=(value,max)=>typeof value==='string'&&!!value.trim()&&value.length<=max;
  function documentRequest(payload){
    if(!payload||Object.keys(payload).some(k=>!['query','history'].includes(k))||!documentText(payload.query,300))throw new Error('invalid_request');
    const history=payload.history||[];
    if(!Array.isArray(history)||history.length>12||history.some(h=>!h||!['user','assistant'].includes(h.role)||!documentText(h.content,6000)||Object.keys(h).some(k=>!['role','content'].includes(k)))||history.reduce((n,h)=>n+h.content.length,0)>6000)throw new Error('invalid_request');
    return {query:payload.query,history};
  }
  function documentReply(body){
    if(!body||!['answer','fallback'].includes(body.kind)||!documentText(body.text,60000)||body.evidence!==undefined&&!Array.isArray(body.evidence))throw new Error('invalid_reply');
    const evidence=body.evidence||[];
    if(evidence.length>60||evidence.some(e=>!e||typeof e.chunk_id!=='string'||typeof e.document_id!=='string'||typeof e.context!=='string'||typeof e.quote!=='string'||typeof e.source_url!=='string'||!Array.isArray(e.pages)||e.pages.some(p=>!Number.isInteger(p)||p<1)||!Array.isArray(e.source_blocks)||e.source_blocks.some(b=>typeof b!=='string')))throw new Error('invalid_reply');
    return {kind:body.kind,text:body.text,evidence};
  }
  const adminSession=(value)=>!!value&&typeof value.token==='string'&&/^[A-Za-z0-9_-]{32,256}$/.test(value.token)&&Number.isInteger(value.expiresAt)&&value.expiresAt>Date.now()/1000;
  const api={id,text,official,request,reply,timeoutSeconds,documentRequest,documentReply,adminSession};globalThis.GyeoteProtocol=Object.freeze(api);
  if(typeof module!=='undefined')module.exports=api;
})();
