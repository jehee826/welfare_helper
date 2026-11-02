const { test } = require("node:test");
const assert = require("node:assert/strict");
const { viewportVisibility, toDip, coveredByDisplays, guidance } = require("./visibility.cjs");
const viewport = {x:0,y:0,width:500,height:400};
const rect = {x:30,y:100,width:100,height:40};
const target = {rect,clip:viewport,viewport,visibility:"visible"};
const base = {target,content:viewport,zoom:1,displays:[viewport],active:true,panelBounds:null};

test("스크롤 경계를 완전 표시·방향·부분 잘림으로 구분", () => {
  for (const [box, expected] of [
    [rect,"visible"], [{...rect,y:-40},"above"], [{...rect,y:400},"below"],
    [{...rect,y:-1},"partial-above"], [{...rect,y:361},"partial-below"],
    [{...rect,x:-100},"left"], [{...rect,x:500},"right"],
    [{...rect,x:-1},"partial-left"], [{...rect,x:401},"partial-right"],
    [{...rect,x:-1,y:-1},"partial"], [{...rect,width:501},"oversized"],
  ]) assert.equal(viewportVisibility(box,viewport,true),expected);
  assert.equal(viewportVisibility(rect,viewport,false),"occluded");
  assert.equal(viewportVisibility({...rect,width:0},viewport,true),"unknown");
});
test("중첩 스크롤 영역의 위쪽 경계와 부분 잘림", () => {
  const clip={x:10,y:150,width:250,height:100};
  assert.equal(viewportVisibility(rect,clip,true),"above");
  assert.equal(viewportVisibility({...rect,y:130},clip,true),"partial-above");
  assert.equal(viewportVisibility({...rect,y:160},clip,true),"visible");
});
test("CSS→DIP는 웹 확대 배율만 적용하고 음수 모니터 좌표를 보존", () => {
  assert.deepEqual(toDip(rect,{x:-1000,y:-200},1.5),{x:-955,y:-50,width:150,height:60});
  assert.deepEqual(toDip(rect,{x:100,y:20},.8),{x:124,y:100,width:80,height:32});
});
test("모니터 합집합 경계는 허용하지만 모니터 사이 틈은 숨김", () => {
  const spanning={x:-10,y:10,width:20,height:20};
  assert.equal(coveredByDisplays(spanning,[{x:-100,y:0,width:100,height:100},{x:0,y:0,width:100,height:100}]),true);
  assert.equal(coveredByDisplays(spanning,[{x:-100,y:0,width:95,height:100},{x:0,y:0,width:100,height:100}]),false);
});
test("창 이동·페이지 스크롤·패널 가림·비활성화를 서로 다른 안내로 반환", () => {
  assert.equal(guidance(base).kind,"visible");
  const above={...target,rect:{...rect,y:-40},visibility:"above"};
  assert.match(guidance({...base,target:above}).text,/위로 스크롤/);
  assert.equal(guidance({...base,content:{...viewport,y:-1}}).kind,"off-display");
  assert.equal(guidance({...base,content:{...viewport,y:-1},target:above}).kind,"off-display");
  assert.equal(guidance({...base,active:false}).kind,"inactive");
  assert.equal(guidance({...base,panelBounds:{...rect,x:rect.x+rect.width-1}}).kind,"panel-covered");
  assert.equal(guidance({...base,panelBounds:{...rect,x:rect.x+rect.width}}).kind,"visible");
  assert.equal(guidance({...base,target:{...target,visibility:"occluded"}}).kind,"occluded");
});
test("크기 측정 전·비정상 배율은 방향 추측 없이 강조 제거", () => {
  for (const options of [{target:null},{zoom:NaN},{zoom:0},{zoom:1.5}]) {
    const result=guidance({...base,...options});
    assert.equal(result.kind,"unknown"); assert.equal(result.rect,undefined);
  }
});
test("숨김→보임은 새 좌표로 복원하고 잘못된 visible 보고를 신뢰하지 않음", () => {
  assert.equal(guidance({...base,target:{...target,rect:{...rect,y:-40}}}).rect,undefined);
  assert.deepEqual(guidance(base).rect,rect);
  assert.equal(guidance({...base,target:{...target,rect:{...rect,y:380}}}).kind,"partial-below");
});
