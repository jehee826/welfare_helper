(() => {
  function inspect(){
    if(!GyeoteDOM.publicPage())throw new Error('capture_public_required');
    if(document.hidden)throw new Error('capture_tab_hidden');
    if(GyeoteDOM.activeModal())throw new Error('capture_modal_open');
    const roots=GyeoteDOM.publicRoots(),masks=[],nodes=[];let partial=false;
    for(const root of roots){
      for(const node of root.querySelectorAll('[aria-expanded="true"][role="combobox"]'))if(GyeoteDOM.visible(node))throw new Error('capture_expanded_combo');
      for(const node of root.querySelectorAll('*'))if(node.localName.includes('-')&&!node.shadowRoot&&GyeoteDOM.visible(node))throw new Error('capture_closed_shadow');
      for(const node of root.querySelectorAll('iframe,object,embed,canvas,video,input,textarea,select,[contenteditable],[role="textbox"],[role="combobox"],[role="checkbox"],[role="radio"]')){
        if(!GyeoteDOM.visible(node))continue;
        if(node.matches('iframe,object,embed,canvas,video'))partial=true;
        const r=node.getBoundingClientRect();
        if(masks.length>=60||![r.left,r.top,r.width,r.height].every(Number.isFinite))throw new Error('capture_mask_limit');
        nodes.push(node);
        masks.push({x:Math.max(0,r.left-8),y:Math.max(0,r.top-8),width:Math.min(innerWidth,r.right+8)-Math.max(0,r.left-8),height:Math.min(innerHeight,r.bottom+8)-Math.max(0,r.top-8)});
      }
    }
    return {masks,nodes,partial};
  }
  function plan(){
    const {masks,nodes,partial}=inspect();
    const host=document.createElement('div');host.dataset.gyeoteMask='';host.style.cssText='position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    const shadow=host.attachShadow({mode:'closed'});
    for(const rect of masks){const node=document.createElement('div');node.style.cssText=`position:fixed;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;background:#000;pointer-events:none;`;shadow.append(node);}
    return {masks,partial,viewport:{width:innerWidth,height:innerHeight},current(){
      try{
        const next=inspect();
        return next.nodes.length===nodes.length&&next.nodes.every((node,index)=>node===nodes[index]&&
          ['x','y','width','height'].every(key=>next.masks[index][key]===masks[index][key]));
      }catch{return false;}
    },mount(){document.documentElement.append(host);},remove(){host.remove();}};
  }
  globalThis.GyeoteCapture=Object.freeze({plan});
})();
