const {ipcRenderer}=require("electron");
window.addEventListener("DOMContentLoaded",()=>{
  const ring=document.querySelector(".ring"),card=document.querySelector(".callout"),arrow=document.querySelector(".arrow");
  const box=(element,r)=>{element.style.left=r.x+"px";element.style.top=r.y+"px";element.style.width=r.width+"px";element.style.height=r.height+"px";};
  let latest=0;
  ipcRenderer.on("overlay:layout",(_event,data)=>{
    if(!Number.isInteger(data?.version)||![data.ring,data.card].every(r=>r&&[r.x,r.y,r.width,r.height].every(Number.isFinite)))return;
    latest=data.version;box(ring,data.ring);box(card,data.card);
    card.querySelector("strong").textContent=data.demo?"개발 시연 · 직접 눌러보세요":"여기를 눌러 주세요";
    card.querySelector("span").textContent=String(data.label).slice(0,100);
    arrow.style.left=data.arrow.x+"px";arrow.style.top=data.arrow.y+"px";arrow.style.width=data.arrow.length+"px";arrow.style.transform=`rotate(${data.arrow.angle}deg)`;
    requestAnimationFrame(()=>requestAnimationFrame(()=>{if(latest===data.version)ipcRenderer.send("overlay:ready",data.version);}));
  });
});
