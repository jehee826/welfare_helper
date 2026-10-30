const crypto = require("node:crypto");
const labels = new Set(require("../shared/public-labels.json"));
const {validRect,contains,intersect} = (() => { const geometry=require("../shared/visibility.cjs"); return {...geometry,contains:(a,b)=>b.x>=a.x&&b.y>=a.y&&b.x+b.width<=a.x+a.width&&b.y+b.height<=a.y+a.height}; })();
function bokjiroUrl(value) {
  try { const u=new URL(value); return u.protocol==="https:" && u.hostname==="www.bokjiro.go.kr" && u.port==="" && !u.username && !u.password; }catch{return false;}
}
function localOrigin(value,port) {
  const u=new URL(value);
  if(u.protocol!=="http:" || !["127.0.0.1","localhost"].includes(u.hostname) || u.port!==String(port) || u.pathname!=="/" || u.search || u.hash || u.username || u.password) throw new Error("local_configuration_only");
  return u.origin;
}
function safeGoal(value) {
  if(typeof value!=="string" || !value.trim() || value.length>240 || /\d{4,}|@|비밀번호|인증.?코드|주민.?번호|password|token|otp/i.test(value)) throw new Error("goal_private_or_invalid");
  return value.trim();
}
function sanitizeSnapshot(raw) {
  if(!raw?.available || !/^[0-9]+$/.test(raw.window) || !/^[A-F0-9]{20}$/.test(raw.tab) || !/^[A-F0-9]{20}$/.test(raw.document) || !/^[A-F0-9]{20}$/.test(raw.navigation) || !validRect(raw.viewport)) return null;
  // helper가 공개 목록을 적용했어도 프로세스 경계에서 다시 제한한다.
  const elements=(Array.isArray(raw.elements)?raw.elements:[]).filter(e=>labels.has(e.name) && /^[A-F0-9]{20}$/.test(e.id) && ["Button","Hyperlink","MenuItem"].includes(e.role) && validRect(e.rect)).slice(0,60).map(e=>({id:e.id,name:e.name,role:e.role,rect:e.rect,offscreen:!!e.offscreen,enabled:!!e.enabled,hit:!!e.hit}));
  const context=[raw.window,raw.tab,raw.document,raw.navigation].join(":");
  const signature=crypto.createHash("sha256").update(JSON.stringify([context,elements.map(e=>[e.id,e.name,e.role,e.enabled]).sort((a,b)=>a[0].localeCompare(b[0]))])).digest("hex");
  return {context,signature,elements,viewport:raw.viewport,active:!!raw.active,partial:!!raw.partial};
}
function parseStep(text,elements) {
  const step=JSON.parse(text);
  if(!step || Object.keys(step).sort().join(",")!=="action,expect_label,instruction,target_id" || !["안내","추가질문","대기","보류"].includes(step.action) || typeof step.instruction!=="string" || !step.instruction.trim() || step.instruction.length>180 || /\d{4,}|@/.test(step.instruction) || !(step.expect_label===null||labels.has(step.expect_label))) throw new Error("invalid_step");
  if(step.action==="안내") { if(!elements.some(e=>e.id===step.target_id && e.enabled)) throw new Error("unknown_target"); }
  else if(step.target_id!==null) throw new Error("unexpected_target");
  return step;
}
function realHighlight(snapshot,id,convert,displays,panelBounds,focused) {
  const e=snapshot?.elements.find(item=>item.id===id);
  if(!focused || !snapshot?.active || !e || !e.enabled || e.offscreen || !e.hit) return null;
  if(!contains(snapshot.viewport,e.rect)) return null;
  const rect=convert(e.rect);
  // 서로 다른 배율의 모니터를 가로지르는 강조는 보류한다.
  if(!validRect(rect) || !displays.some(d=>contains(d,rect))) return null;
  if(panelBounds && validRect(intersect(rect,panelBounds))) return null;
  return rect;
}
module.exports={bokjiroUrl,localOrigin,safeGoal,sanitizeSnapshot,parseStep,realHighlight};
