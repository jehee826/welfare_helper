const messages={
  chrome_not_found:"사용 가능한 Chrome 창이 없습니다. 기존 Chrome에서 복지로를 열어주세요.",
  target_not_found:"Chrome은 있지만 현재 선택 탭에서 복지로를 확인하지 못했습니다. 복지로 탭을 직접 선택하세요.",
  target_not_selected:"연결할 Chrome 대상이 없습니다. 원하는 복지로 창을 활성화하거나 트레이에서 다시 열어주세요.",
  ambiguous_target:"복지로 창이 여러 개입니다. 연결할 Chrome 창의 복지로 탭을 직접 활성화하세요.",
  other_app:"다른 앱이 활성입니다. 이전 Chrome 대상은 기억하되 안내·강조를 중지합니다.",
  foreground_unavailable:"현재 활성 창을 확인하지 못했습니다. 진단 명령으로 사용자 세션 접근을 확인하세요.",
  addressbar_missing:"Chrome 주소창을 읽지 못했습니다. 전체 URL이나 창 제목으로 대신 판단하지 않습니다.",
  url_scheme_missing:"주소창이 HTTPS scheme을 노출하지 않아 안전한 복지로 주소인지 확인할 수 없습니다.",
  url_not_target:"현재 Chrome 탭의 주소가 허용된 HTTPS 복지로 주소로 검증되지 않았습니다.",
  selected_tab_unverified:"Chrome의 선택 탭을 확인하지 못했습니다. 원하는 복지로 탭을 직접 선택하세요.",
  no_accessibility_document:"복지로 주소·탭은 확인했지만 페이지 접근성 문서를 읽지 못했습니다.",
  chrome_closed:"보존된 Chrome 창이 닫혔습니다. Chrome을 연 뒤 트레이에서 다시 연결하세요.",
  target_rechecking:"Chrome의 현재 탭을 다시 검증하고 있습니다. 이전 화면의 강조는 보류합니다.",
  target_changed_during_read:"읽는 중 탭이나 활성 창이 바뀌었습니다. 이전 결과를 사용하지 않습니다.",
  dpi_unverified:"접근성 좌표의 화면 배율을 확인하지 못해 강조를 중지했습니다.",
  accessibility_timeout:"UIA 읽기가 20초를 초과해 앱 소유 읽기 프로세스만 중단했습니다. 진단 명령을 확인하세요.",
  accessibility_stopped:"접근성 읽기 프로세스가 종료됐습니다. 진단 결과를 확인한 뒤 앱을 다시 실행하세요.",
  accessibility_start_failed:"접근성 읽기 프로세스를 시작하지 못했습니다. 진단 명령을 확인하세요.",
  windows_required:"Windows UI Automation이 필요한 기능입니다.",
  uia_read_failed:"Windows 접근성 읽기에 실패했습니다. 개인정보를 출력하지 않는 진단 명령으로 원인을 확인하세요.",
  uia_unavailable:"UIA 준비 또는 컴파일에 실패했습니다. 진단 명령을 확인하세요.",
};
function watchMessage(reason){return messages[reason]||"접근성 정보를 확인하지 못했습니다. 진단 명령을 확인하세요.";}
function verifiedPresence(raw){
  return raw?.verified && /^[0-9]+$/.test(raw.window) && /^[A-F0-9]{20}$/.test(raw.tab)
    ? {key:raw.window+":"+raw.tab,active:raw.active===true}:null;
}
function focusUpdate(event,cached,previous,now=Date.now()) {
  const fresh=cached && now-cached.at<3500;
  if(event.focus==="panel" && previous==="chrome" && fresh)return {snapshot:{...cached.snapshot,active:false},reason:""};
  if(event.focus==="chrome" && previous==="panel" && fresh && cached.snapshot.context.split(":")[0]===event.window)return {keep:true};
  return {snapshot:null,reason:event.focus==="other"?"other_app":"target_rechecking"};
}
module.exports={watchMessage,verifiedPresence,focusUpdate};
