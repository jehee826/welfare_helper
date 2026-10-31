(() => {
  const id=value=>typeof value==='string'&&/^[A-F0-9]{20}$/.test(value);
  const text=(value,max)=>typeof value==='string'&&value.trim()&&value.length<=max&&!/\d{4,}|@|[<>\x00-\x08]|주민등록|인증번호|인증코드|비밀번호|password|\bOTP\b/i.test(value);
  const official=value=>{try{const u=new URL(value);return u.origin==='https://www.bokjiro.go.kr'&&!u.username&&!u.password;}catch{return false;}};
  function request(payload){
    if(!payload||payload.source!=='dom'||!id(payload.snapshot_id)||!text(payload.question,240)||!Array.isArray(payload.candidates)||payload.candidates.length>60||!Array.isArray(payload.screen_context)||payload.screen_context.length>8)throw new Error('invalid_request');
    const ids=new Set();
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
  const api={id,text,official,request,reply};globalThis.GyeoteProtocol=Object.freeze(api);
  if(typeof module!=='undefined')module.exports=api;
})();
