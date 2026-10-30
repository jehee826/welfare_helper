const {spawn}=require("node:child_process");
const path=require("node:path");
const {verifiedPresence,focusUpdate}=require("./watch-status.cjs");
const {sanitizeSnapshot}=require("./assistant-policy.cjs");
function watchChrome(onSnapshot) {
  if(process.platform!=="win32"){onSnapshot(null,"windows_required");return ()=>{};}
  const shell=path.join(process.env.SystemRoot||"C:\\Windows","System32/WindowsPowerShell/v1.0/powershell.exe");
  const child=spawn(shell,["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",path.join(__dirname,"../native/watch.ps1"),"-OwnerPid",String(process.pid)],{windowsHide:true,stdio:["pipe","pipe","ignore"]});
  let stopped=false,buffer="",last=Date.now(),terminal=false,cached=null,cachedPresence=null,previousFocus="";
  child.stdin.on("error",()=>{});
  child.stdout.setEncoding("utf8");
  child.stdout.on("data",chunk=>{buffer+=chunk;if(buffer.length>256000){child.kill();return;}let index;
    while((index=buffer.indexOf("\n"))>=0){
      const line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);
      try {
        const raw=JSON.parse(line);
        if(raw.event==="foreground") {
          const prior=previousFocus;previousFocus=raw.focus;
          const presenceFresh=cachedPresence&&Date.now()-cachedPresence.at<3500;
          if(raw.focus==="panel"&&prior==="chrome"&&presenceFresh&&!cached) {
            onSnapshot(null,cachedPresence.reason,{...cachedPresence.value,active:false});continue;
          }
          if(raw.focus==="chrome"&&prior==="panel"&&presenceFresh&&!cached&&cachedPresence.value.key.split(":")[0]===raw.window)continue;
          const change=focusUpdate(raw,cached,prior);
          if(raw.focus==="other"){cached=null;cachedPresence=null;}
          if(!change.keep)onSnapshot(change.snapshot,change.reason);
          continue;
        }
        last=Date.now();
        const snapshot=sanitizeSnapshot(raw);cached=snapshot?{snapshot,at:Date.now()}:null;
        const presence=verifiedPresence(raw);
        cachedPresence=presence?{value:presence,reason:raw.reason||"",at:Date.now()}:null;
        if(snapshot?.active||presence?.active)previousFocus="chrome";
        onSnapshot(snapshot,raw.reason||"",presence);
      }catch{onSnapshot(null,"invalid_accessibility_data");}
    }
  });
  const watchdog=setInterval(()=>{if(Date.now()-last>20000){terminal=true;onSnapshot(null,"accessibility_timeout");child.kill();}},2000);
  child.on("error",()=>{terminal=true;onSnapshot(null,"accessibility_start_failed");});
  child.on("exit",()=>{clearInterval(watchdog);if(!stopped&&!terminal)onSnapshot(null,"accessibility_stopped");});
  const stop=()=>{stopped=true;clearInterval(watchdog);child.kill();};
  stop.discover=()=>{if(!stopped&&!child.killed&&child.exitCode===null)child.stdin.write("discover\n");};
  return stop;
}
module.exports={watchChrome};
