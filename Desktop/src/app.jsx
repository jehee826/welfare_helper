import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";
import visibility from "../shared/visibility.cjs";
const { intersect, viewportVisibility } = visibility;
const initial = { status: "idle", collapsed: false, text: "시연을 골라 플로팅 창의 동작을 확인하세요." };
function Panel() {
  const [state,setState] = useState({...initial,mode:"screen",screenMessages:[],ragMessages:[]});
  const [input,setInput] = useState("");
  useEffect(()=>{const stop=window.desktop.onState(setState);void window.desktop.command("state");return stop;},[]);
  const command=(action,payload)=>{void window.desktop.command(action,payload).catch(()=>{});};
  const demo=state.mode==="demo",rag=state.mode==="rag";
  const messages=rag?state.ragMessages:state.screenMessages;
  return <main className={state.collapsed?"panel collapsed":"panel"}>
    <header className="drag"><div><strong>곁에</strong><span className="tag">{demo?"개발용 고정 시연":"로컬 연결"}</span></div>
      <div className="controls"><button aria-label={state.collapsed?"펼치기":"접기"} onClick={()=>command("collapse")}>{state.collapsed?"+":"−"}</button><button aria-label="트레이로 숨기기" onClick={()=>command("hide")}>×</button></div></header>
    {!state.collapsed && <><nav className="modes" aria-label="상담 모드">{[["rag","RAG 상담"],["screen","화면 안내"],["demo","개발 시연"]].map(([value,label])=><button key={value} aria-pressed={state.mode===value} onClick={()=>{setInput("");command("mode",value);}}>{label}</button>)}</nav>
      <p className="muted">{demo?"연습 창의 고정 시나리오입니다. 실제 인식이 아닙니다.":rag?"기존 로컬 RAG API · 화면 안내와 이력 분리":`${state.connection||"복지로 대기"} · 입력값/화면 이미지 수집 없음`}</p>
      <section className={"message "+state.status} aria-live="polite"><span className="status">{{idle:"대기",waiting:"준비 중",guide:"안내",error:"보류",done:"완료"}[state.status]}</span><p>{state.text}</p></section>
      {!demo && <><div className="conversation" role="log" aria-label={rag?"RAG 대화":"화면 안내 진행"}>{(messages||[]).map((m,i)=><section key={i}><small>{m.role==="user"?"나":"곁에"}</small><p>{m.text}</p>{m.evidence?.map((e,j)=><details key={j}><summary>검색 원문 · {e.pages.join(", ")}쪽</summary><p>{e.context}</p></details>)}</section>)}</div>
      <form onSubmit={e=>{e.preventDefault();command(rag?"rag":"goal",input);setInput("");}}><label htmlFor="goal">{rag?"복지 문서 질문":state.awaitingClarification?"추가질문에 대한 답변 (개인정보 제외)":"안내받을 목표 (개인정보 제외)"}</label><input id="goal" maxLength={240} value={input} onChange={e=>setInput(e.target.value)} autoComplete="off"/><button className="primary" disabled={!input.trim()||state.status==="waiting"}>{rag?"질문 보내기":state.awaitingClarification?"답변 보내기":"현재 화면으로 안내"}</button></form>
      {!rag && <><button disabled={state.status==="waiting"||state.awaitingClarification} onClick={()=>command("advance")}>화면 변화 확인</button><button onClick={()=>{setInput("");command("reset");}}>새 안내 시작</button></>}<p className="muted">생성 모델: {state.model} · 서버 OLLAMA_LLM 공통 설정</p></>}
      {demo && <div className="actions"><button className="primary" disabled={state.status==="waiting"} onClick={()=>command("guide")}>버튼 강조 연습</button><button onClick={()=>command("error")}>오류 상태 보기</button><button onClick={()=>command("reset")}>초기화 · 강조 지우기</button></div>}
      <footer>상단을 끌어 이동 · 닫으면 트레이로 숨김<br/>자동 클릭·입력·제출·화면 캡처 없음</footer></>}
  </main>;
}
function Stage() {
  const button = useRef(null);
  const [clicks, setClicks] = useState(0);
  useEffect(() => {
    let frame = 0, active = true, version = -1;
    const rectOf = node => { const {x,y,width,height} = node.getBoundingClientRect(); return {x,y,width,height}; };
    const report = () => {
      frame = 0;
      if (!active || version < 0 || !button.current) return;
      const element = button.current, rect = rectOf(element);
      const viewport = {x:0,y:0,width:window.innerWidth,height:window.innerHeight};
      let clip = viewport, hidden = false;
      for (let parent = element; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        hidden ||= style.visibility !== "visible" || style.display === "none" || Number(style.opacity) === 0;
        if (parent === element || parent === document.body || parent === document.documentElement) continue;
        const box = rectOf(parent);
        const sx = parent.offsetWidth ? box.width / parent.offsetWidth : 1;
        const sy = parent.offsetHeight ? box.height / parent.offsetHeight : 1;
        const client = {x:box.x+parent.clientLeft*sx,y:box.y+parent.clientTop*sy,width:parent.clientWidth*sx,height:parent.clientHeight*sy};
        const clipsX = /auto|scroll|hidden|clip/.test(style.overflowX);
        const clipsY = /auto|scroll|hidden|clip/.test(style.overflowY);
        clip = intersect(clip,{x:clipsX?client.x:clip.x,y:clipsY?client.y:clip.y,
          width:clipsX?client.width:clip.width,height:clipsY?client.height:clip.height});
      }
      const points = [[.1,.1],[.9,.1],[.5,.5],[.1,.9],[.9,.9]];
      const unobscured = !hidden && points.every(([x,y]) => {
        const hit = document.elementFromPoint(rect.x+rect.width*x,rect.y+rect.height*y);
        return hit === element || element.contains(hit);
      });
      window.desktop.reportTarget({version,rect,viewport,clip,visibility:viewportVisibility(rect,clip,unobscured)});
    };
    const schedule = () => { if (active && !frame) frame = requestAnimationFrame(report); };
    const unsubscribe = window.desktop.onMeasure(next => { version = next; schedule(); });
    window.desktop.layoutVersion().then(next => { if (active) { version = Math.max(version,next); schedule(); } });
    const observer = new ResizeObserver(schedule);
    for (let node = button.current; node; node = node.parentElement) observer.observe(node);
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
    document.addEventListener("scroll",schedule,true);
    window.addEventListener("resize",schedule);
    document.addEventListener("transitionend",schedule,true);
    document.addEventListener("animationend",schedule,true);
    window.visualViewport?.addEventListener("resize",schedule);
    window.visualViewport?.addEventListener("scroll",schedule);
    document.fonts.ready.then(schedule);
    return () => {
      active = false; cancelAnimationFrame(frame); observer.disconnect(); mutations.disconnect(); unsubscribe();
      document.removeEventListener("scroll",schedule,true); window.removeEventListener("resize",schedule);
      document.removeEventListener("transitionend",schedule,true); document.removeEventListener("animationend",schedule,true);
      window.visualViewport?.removeEventListener("resize",schedule); window.visualViewport?.removeEventListener("scroll",schedule);
    };
  }, []);
  return <main className="stage"><div className="stage-label">곁에 · 가상 서비스 화면</div><h1>복지서비스 이용 연습</h1>
    <p>실제 복지로 사이트가 아닙니다. 아래 버튼에는 신청·제출 기능이 없습니다.</p>
    <p className="scroll-intro">아래로 내려 버튼을 숨긴 뒤, 다시 위로 올려 안내 변화를 확인하세요.</p>
    <div className="nested-scroll" tabIndex={0} aria-label="버튼 스크롤 연습 영역"><p>이 영역 안에서도 직접 위아래로 스크롤할 수 있습니다.</p><section className="practice"><span className="tag">연습 자료</span><h2>신청 방법 살펴보기</h2><p>파란 테두리가 나타나도 버튼을 직접 누를 수 있어야 합니다.</p>
      <button ref={button} id="practice-target" className="primary" onClick={() => { setClicks(n => n + 1); window.desktop.clicked(); }}>신청 방법 보기</button>
      <p role="status" id="click-count">직접 클릭 {clicks}회</p></section><div className="nested-space">버튼이 위로 사라질 때까지 내려보세요.</div></div><div className="page-space">바깥 페이지도 스크롤할 수 있습니다. 위로 올리면 버튼이 다시 나타납니다.</div><p className="muted">창 이동·크기 변경 시 강조 위치도 따라갑니다. 실제 화면 좌표를 인식하지 않습니다.</p></main>;
}
createRoot(document.getElementById("root")).render(new URLSearchParams(location.search).has("stage") ? <Stage/> : <Panel/>);
