const {spawn}=require("node:child_process");
const path=require("node:path");
const {validRect}=require("../shared/visibility.cjs");
function captureKey(snapshot){return JSON.stringify([snapshot.context,snapshot.signature,snapshot.viewport,snapshot.windowRect,snapshot.maskRects,snapshot.scrollPercent,snapshot.elements.map(e=>[e.id,e.rect,e.offscreen])]);}
function capturePacket(snapshot,panelWindow,panelBounds){
  if(!snapshot?.captureEligible||snapshot.partial||snapshot.modalOpen||!validRect(snapshot.windowRect)||!validRect(snapshot.viewport)||!Array.isArray(snapshot.maskRects)||snapshot.maskRects.length>40||!snapshot.maskRects.every(validRect)||Date.now()-snapshot.verifiedAt>1500||!snapshot.active&&!snapshot.panelFocused)throw new Error("capture_not_safe");
  // 대상 HWND의 자체 렌더링만 사용하므로 별도 패널·타 앱을 합성하지 않는다.
  const ints=r=>[Math.floor(r.x),Math.floor(r.y),Math.ceil(r.width),Math.ceil(r.height)];
  return {window:snapshot.context.split(":")[0],panel:panelWindow,owner:process.pid,bounds:ints(snapshot.windowRect),crop:ints(snapshot.viewport),masks:snapshot.maskRects.map(ints)};
}
function captureScreen(packet,signal){
  return new Promise((resolve,reject)=>{
    const shell=path.join(process.env.SystemRoot||"C:\\Windows","System32/WindowsPowerShell/v1.0/powershell.exe");
    const child=spawn(shell,["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",path.join(__dirname,"../native/capture.ps1")],{windowsHide:true,stdio:["pipe","pipe","ignore"]});
    let output="",settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener("abort",abort);child.kill();error?reject(new Error(error)):resolve(value);};
    const abort=()=>finish("capture_cancelled");
    const timer=setTimeout(()=>finish("capture_timeout"),8000);
    signal.addEventListener("abort",abort,{once:true});
    child.stdin.on("error",()=>finish("capture_unavailable"));
    child.on("error",()=>finish("capture_unavailable"));
    child.stdout.setEncoding("utf8");child.stdout.on("data",chunk=>{output+=chunk;if(output.length>2*1024*1024+4)finish("capture_size_limit");});
    child.on("exit",code=>{const image=output.trim();if(code!==0||!/^iVBOR[A-Za-z0-9+/=]+$/.test(image))finish("capture_unavailable");else finish(null,image);output="";});
    if(signal.aborted)abort();else child.stdin.end(JSON.stringify(packet));
  });
}
module.exports={capturePacket,captureScreen,captureKey};
