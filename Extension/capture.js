(() => {
  function plan(){
    if(!GyeoteDOM.publicPage()||document.hidden||GyeoteDOM.activeModal())throw new Error('capture_not_safe');
    const roots=GyeoteDOM.publicRoots(),masks=[];
    for(const root of roots){
      for(const node of root.querySelectorAll('iframe,object,embed,canvas,video,[aria-expanded="true"][role="combobox"]'))if(GyeoteDOM.visible(node))throw new Error('capture_not_safe');
      for(const node of root.querySelectorAll('*'))if(node.localName.includes('-')&&!node.shadowRoot&&GyeoteDOM.visible(node))throw new Error('capture_not_safe');
      for(const node of root.querySelectorAll('input,textarea,select,[contenteditable],[role="textbox"],[role="combobox"],[role="checkbox"],[role="radio"]')){
        if(!GyeoteDOM.visible(node))continue;
        const r=node.getBoundingClientRect();
        if(masks.length>=60||![r.left,r.top,r.width,r.height].every(Number.isFinite))throw new Error('capture_not_safe');
        masks.push({x:Math.max(0,r.left-8),y:Math.max(0,r.top-8),width:Math.min(innerWidth,r.right+8)-Math.max(0,r.left-8),height:Math.min(innerHeight,r.bottom+8)-Math.max(0,r.top-8)});
      }
    }
    const host=document.createElement('div');host.dataset.gyeoteMask='';host.style.cssText='position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    const shadow=host.attachShadow({mode:'closed'});
    for(const rect of masks){const node=document.createElement('div');node.style.cssText=`position:fixed;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;background:#000;pointer-events:none;`;shadow.append(node);}
    return {masks,viewport:{width:innerWidth,height:innerHeight},mount(){document.documentElement.append(host);},remove(){host.remove();}};
  }
  globalThis.GyeoteCapture=Object.freeze({plan});
})();
