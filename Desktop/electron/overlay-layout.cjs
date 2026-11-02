const {intersect,validRect}=require("../shared/visibility.cjs");
const contains=(a,b)=>b.x>=a.x&&b.y>=a.y&&b.x+b.width<=a.x+a.width&&b.y+b.height<=a.y+a.height;
function overlayLayout(rect,area,panel,label,viewport,demo=false){
  const width=220,height=96,gap=24;
  const cy=rect.y+rect.height/2,cx=rect.x+rect.width/2;
  const clampY=y=>Math.max(area.y,Math.min(y,area.y+area.height-height));
  const clampX=x=>Math.max(area.x,Math.min(x,area.x+area.width-width));
  const choices=[
    {x:rect.x-gap-width,y:clampY(cy-height/2),width,height,side:"left"},
    {x:rect.x+rect.width+gap,y:clampY(cy-height/2),width,height,side:"right"},
    {x:clampX(cx-width/2),y:rect.y+rect.height+gap,width,height,side:"bottom"},
    {x:clampX(cx-width/2),y:rect.y-gap-height,width,height,side:"top"},
  ];
  const card=choices.find(c=>contains(area,c)&&!validRect(intersect(c,rect))&&(!panel||!validRect(intersect(c,panel))));
  if(!card)return null;
  const x=Math.floor(Math.max(area.x,Math.min(rect.x,card.x)-6)),y=Math.floor(Math.max(area.y,Math.min(rect.y,card.y)-6));
  const right=Math.ceil(Math.min(area.x+area.width,Math.max(rect.x+rect.width,card.x+width)+6));
  const bottom=Math.ceil(Math.min(area.y+area.height,Math.max(rect.y+rect.height,card.y+height)+6));
  let start,end;
  if(card.side==="left"){start={x:card.x+width,y:cy};end={x:rect.x-3,y:cy};}
  if(card.side==="right"){start={x:card.x,y:cy};end={x:rect.x+rect.width+3,y:cy};}
  if(card.side==="bottom"){start={x:cx,y:card.y};end={x:cx,y:rect.y+rect.height+3};}
  if(card.side==="top"){start={x:cx,y:card.y+height};end={x:cx,y:rect.y-3};}
  const relative=r=>({x:r.x-x,y:r.y-y,width:r.width,height:r.height});
  const direction=cx<viewport.x+viewport.width/3?"왼쪽":cx>viewport.x+viewport.width*2/3?"오른쪽":cy<viewport.y+viewport.height/3?"위쪽":cy>viewport.y+viewport.height*2/3?"아래쪽":"가운데";
  return {bounds:{x,y,width:right-x,height:bottom-y},ring:relative(rect),card:relative(card),arrow:{x:start.x-x,y:start.y-y,length:Math.hypot(end.x-start.x,end.y-start.y),angle:Math.atan2(end.y-start.y,end.x-start.x)*180/Math.PI},label,demo,direction};
}
class OverlayPresenter{
  constructor(window){this.window=window;this.version=0;this.key=null;this.shown=false;this.ready=null;}
  hide(){this.version++;this.key=null;this.shown=false;this.ready=null;this.window.hide();}
  present(layout,onReady){
    const key=JSON.stringify(layout);
    if(key===this.key){if(this.shown)onReady();else this.ready=onReady;return;}
    this.hide();this.key=key;this.ready=onReady;this.window.setBounds(layout.bounds);
    this.window.webContents.send("overlay:layout",{...layout,version:this.version});
  }
  acknowledge(version){if(version!==this.version||!this.key)return;this.shown=true;this.window.showInactive();this.ready?.();this.ready=null;}
}
module.exports={overlayLayout,OverlayPresenter};
