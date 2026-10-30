function validRect(rect) {
  return rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    && rect.width > 0 && rect.height > 0;
}
function intersect(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return { x, y, width: Math.max(0, Math.min(a.x+a.width, b.x+b.width)-x),
    height: Math.max(0, Math.min(a.y+a.height, b.y+b.height)-y) };
}
function contains(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y
    && inner.x+inner.width <= outer.x+outer.width && inner.y+inner.height <= outer.y+outer.height;
}
function viewportVisibility(rect, clip, unobscured) {
  if (!validRect(rect) || !validRect(clip)) return "unknown";
  if (rect.width > clip.width || rect.height > clip.height) return "oversized";
  if (rect.y+rect.height <= clip.y) return "above";
  if (rect.y >= clip.y+clip.height) return "below";
  if (rect.x+rect.width <= clip.x) return "left";
  if (rect.x >= clip.x+clip.width) return "right";
  if (!contains(clip,rect)) {
    const vertical = rect.y < clip.y ? "above" : rect.y+rect.height > clip.y+clip.height ? "below" : null;
    const horizontal = rect.x < clip.x ? "left" : rect.x+rect.width > clip.x+clip.width ? "right" : null;
    return vertical && horizontal ? "partial" : "partial-" + (vertical || horizontal);
  }
  return unobscured ? "visible" : "occluded";
}
function toDip(rect, content, zoom) {
  return { x: content.x + rect.x*zoom, y: content.y+rect.y*zoom, width:rect.width*zoom, height:rect.height*zoom };
}
// 여러 디스플레이의 합집합을 사용해 음수 좌표·모니터 사이 빈 공간도 구분한다.
function coveredByDisplays(rect, displays) {
  let remaining = [rect];
  for (const display of displays) {
    remaining = remaining.flatMap(piece => {
      const cut = intersect(piece,display);
      if (!validRect(cut)) return [piece];
      return [
        {x:piece.x,y:piece.y,width:piece.width,height:cut.y-piece.y},
        {x:piece.x,y:cut.y+cut.height,width:piece.width,height:piece.y+piece.height-cut.y-cut.height},
        {x:piece.x,y:cut.y,width:cut.x-piece.x,height:cut.height},
        {x:cut.x+cut.width,y:cut.y,width:piece.x+piece.width-cut.x-cut.width,height:cut.height},
      ].filter(validRect);
    });
  }
  return remaining.length === 0;
}
function guidance({ target, content, zoom, displays, panelBounds, active }) {
  if (!active) return {kind:"inactive",text:"연습 화면을 직접 선택해 활성화하세요. 다른 창 위에는 강조하지 않습니다."};
  if (!target || !validRect(target.rect) || !validRect(target.viewport) || !Number.isFinite(zoom) || zoom <= 0)
    return {kind:"unknown",text:"버튼 위치를 다시 확인하고 있습니다. 방향을 추측해 안내하지 않습니다."};
  if (Math.abs(target.viewport.width*zoom-content.width)>2 || Math.abs(target.viewport.height*zoom-content.height)>2)
    return {kind:"unknown",text:"창 크기가 바뀌었습니다. 버튼 위치를 다시 확인하고 있습니다."};
  if (!coveredByDisplays(content,displays))
    return {kind:"off-display",text:"연습 창이 화면 밖이나 작업 표시줄에 걸쳐 있습니다. 창을 화면 안으로 옮기거나 크기를 줄여주세요."};
  const world = toDip(target.rect,content,zoom);
  // 페이지 밖 버튼은 원래 CSS 좌표로 판단하고, 보이는 부분의 OS 위치만 화면과 비교한다.
  const visiblePart = intersect(target.rect,target.clip);
  if (validRect(visiblePart) && !coveredByDisplays(toDip(visiblePart,content,zoom),displays))
    return {kind:"off-display",text:"연습 창이 화면 밖이나 작업 표시줄에 걸쳐 있습니다. 창을 화면 안으로 옮겨주세요."};
  if (panelBounds && validRect(visiblePart) && validRect(intersect(toDip(visiblePart,content,zoom),panelBounds)))
    return {kind:"panel-covered",text:"도움 패널이 버튼을 가리고 있습니다. 패널을 옆으로 옮겨주세요."};
  const kind = viewportVisibility(target.rect,target.clip,target.visibility === "visible");
  const messages = {
    above:"버튼이 위에 있습니다. 버튼이 있는 영역을 위로 스크롤하세요.",
    below:"버튼이 아래에 있습니다. 버튼이 있는 영역을 아래로 스크롤하세요.",
    left:"버튼이 왼쪽에 있습니다. 버튼이 있는 영역을 왼쪽으로 스크롤하세요.",
    right:"버튼이 오른쪽에 있습니다. 버튼이 있는 영역을 오른쪽으로 스크롤하세요.",
    "partial-above":"버튼 위쪽이 잘렸습니다. 영역을 위로 스크롤해 버튼 전체를 표시하세요.",
    "partial-below":"버튼 아래쪽이 잘렸습니다. 영역을 아래로 스크롤해 버튼 전체를 표시하세요.",
    "partial-left":"버튼 왼쪽이 잘렸습니다. 영역을 왼쪽으로 스크롤해 버튼 전체를 표시하세요.",
    "partial-right":"버튼 오른쪽이 잘렸습니다. 영역을 오른쪽으로 스크롤해 버튼 전체를 표시하세요.",
    partial:"버튼이 여러 방향으로 잘렸습니다. 영역을 조정해 버튼 전체를 표시하세요.",
    oversized:"표시 영역이 버튼보다 작습니다. 연습 창이나 스크롤 영역을 넓혀주세요.",
    occluded:"화면 요소가 버튼을 가리고 있습니다. 가리는 요소를 닫거나 옮겨주세요.",
    unknown:"버튼의 표시 상태를 확인할 수 없습니다. 창과 스크롤 영역을 확인하세요.",
    visible:"이 버튼을 누르세요. 파란 테두리는 클릭을 가로채지 않습니다.",
  };
  return {kind:messages[kind]?kind:"unknown", text:messages[kind] || messages.unknown, ...(kind === "visible" ? {rect:world} : {})};
}
module.exports = { validRect, intersect, viewportVisibility, toDip, coveredByDisplays, guidance };
