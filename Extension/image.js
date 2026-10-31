(() => {
  async function prepare(dataUrl,viewport,masks){
    if(typeof dataUrl!=='string'||!dataUrl.startsWith('data:image/png;base64,')||dataUrl.length>16*1024*1024||!viewport||![viewport.width,viewport.height].every(n=>Number.isFinite(n)&&n>0)||!Array.isArray(masks)||masks.length>60)throw new Error('capture_failed');
    const bytes=Uint8Array.from(atob(dataUrl.split(',')[1]),c=>c.charCodeAt(0));
    const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
    try{
      const sx=bitmap.width/viewport.width,sy=bitmap.height/viewport.height;
      if(bitmap.width>8192||bitmap.height>8192||bitmap.width*bitmap.height>33554432||Math.abs(sx-sy)/Math.max(sx,sy)>.03)throw new Error('capture_failed');
      const scale=Math.min(1,1280/bitmap.width,800/bitmap.height),canvas=new OffscreenCanvas(Math.max(1,Math.floor(bitmap.width*scale)),Math.max(1,Math.floor(bitmap.height*scale))),ctx=canvas.getContext('2d',{alpha:false});
      ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);ctx.fillStyle='#000';
      for(const r of masks){
        if(![r.x,r.y,r.width,r.height].every(Number.isFinite)||r.x<0||r.y<0||r.width<=0||r.height<=0||r.x+r.width>viewport.width+1||r.y+r.height>viewport.height+1)throw new Error('capture_failed');
        const left=Math.floor(r.x*sx*scale),top=Math.floor(r.y*sy*scale);
        ctx.fillRect(left,top,Math.ceil((r.x+r.width)*sx*scale)-left,Math.ceil((r.y+r.height)*sy*scale)-top);
      }
      const blob=await canvas.convertToBlob({type:'image/png'});if(blob.size>1536*1024)throw new Error('capture_failed');
      const output=new Uint8Array(await blob.arrayBuffer());let binary='';for(let i=0;i<output.length;i+=8192)binary+=String.fromCharCode(...output.subarray(i,i+8192));
      return btoa(binary);
    }finally{bitmap.close();}
  }
  globalThis.GyeoteImage=Object.freeze({prepare});
})();
