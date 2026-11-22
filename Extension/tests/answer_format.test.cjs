const test=require('node:test'),assert=require('node:assert/strict');
const {JSDOM}=require('../../FrontEnd/node_modules/jsdom');
const format=require('../answer-format.js');
const container=()=>new JSDOM('<div></div>').window.document.querySelector('div');

test('목록·번호·소제목·라벨 줄을 블록으로 나누고 원문 글자를 보존한다',()=>{
  const parsed=format.blocks('### 지원 대상\n- 만 65세 이상\n- 소득 하위 70%\n\n1. 신분증\n2) 통장 사본\n① 주민센터 방문\n지원 금액: 월 최대 33만 원');
  assert.deepEqual(parsed.map(block=>block.type),['heading','ul','ol','ol','paragraph']);
  assert.deepEqual(parsed[1].items.map(item=>item.text),['만 65세 이상','소득 하위 70%']);
  assert.deepEqual(parsed[2].items.map(item=>item.number),[1,2]);
  assert.equal(parsed[3].start,1);assert.equal(parsed[4].text,'지원 금액: 월 최대 33만 원');
});

test('줄바꿈 없는 긴 단락은 문장 경계에서 나누고 숫자 뒤 마침표는 자르지 않는다',()=>{
  const sentence='기초연금은 만 65세 이상이고 소득인정액이 선정기준액 이하인 분이 받을 수 있습니다.';
  const parsed=format.blocks([sentence,sentence,'금액은 2025. 1. 1. 기준 1.5배로 계산합니다.',sentence].join(' '));
  assert.ok(parsed.length>=2);assert.ok(parsed.every(block=>block.type==='paragraph'));
  assert.match(parsed.map(block=>block.text).join(' '),/2025\. 1\. 1\. 기준 1\.5배/);
  assert.equal(parsed.map(block=>block.text).join(' '),[sentence,sentence,'금액은 2025. 1. 1. 기준 1.5배로 계산합니다.',sentence].join(' '));
});

test('render는 HTML을 해석하지 않고 굵게·라벨만 요소로 만든다',()=>{
  const node=container();
  format.render(node,'<img src=x onerror=alert(1)> **중요** 확인\n신청 방법: 주민센터 방문\n- **대상**: 노인');
  assert.equal(node.querySelector('img'),null);
  assert.match(node.querySelector('p').textContent,/<img src=x onerror=alert\(1\)>/);
  assert.equal(node.querySelector('p strong').textContent,'중요');
  assert.equal(node.querySelectorAll('p')[1].querySelector('.answer-label').textContent,'신청 방법: ');
  assert.equal(node.querySelector('li').textContent,'대상: 노인');
});

test('입력 중 표시는 마지막 블록 끝에만 붙고 닫히지 않은 굵게도 별표 없이 보인다',()=>{
  const node=container();
  format.render(node,'첫 문단\n- 항목 **강조 중',{caret:true});
  const caret=node.querySelectorAll('.typing-caret');
  assert.equal(caret.length,1);assert.equal(caret[0].parentElement.tagName,'LI');
  assert.doesNotMatch(node.textContent,/\*\*/);
  format.render(node,'끝난 답변');assert.equal(node.querySelector('.typing-caret'),null);
});

test('요약은 목록·문장·쉼표 나열 순으로 항목을 만든다',()=>{
  assert.deepEqual(format.summaryItems('- 기초연금 자격\n- 장애인 활동지원 신청'),['기초연금 자격','장애인 활동지원 신청']);
  assert.deepEqual(format.summaryItems('기초연금 자격을 물었습니다. 청년 월세 지원을 물었습니다.'),['기초연금 자격을 물었습니다.','청년 월세 지원을 물었습니다.']);
  assert.deepEqual(format.summaryItems('기초연금 수급 자격과 신청 방법, 장애인 활동지원 서비스 이용 조건, 청년 월세 지원 금액에 대해 질문함.'),['기초연금 수급 자격과 신청 방법','장애인 활동지원 서비스 이용 조건','청년 월세 지원 금액에 대해 질문함.']);
  assert.deepEqual(format.summaryItems('짧은 요약입니다.'),['짧은 요약입니다.']);
  const node=container();format.renderSummary(node,'가 주제. 나 주제.');
  assert.equal(node.querySelectorAll('li').length,2);
  format.renderSummary(node,'한 주제만 있습니다.');assert.equal(node.querySelector('li'),null);assert.equal(node.textContent,'한 주제만 있습니다.');
});
