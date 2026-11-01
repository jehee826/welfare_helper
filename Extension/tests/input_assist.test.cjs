const {test}=require('node:test'),assert=require('node:assert/strict');
const {JSDOM}=require('../../FrontEnd/node_modules/jsdom');
const fs=require('node:fs'),path=require('node:path');
function fixture(options={}){
  const dom=new JSDOM('<form><input type="text" maxlength="300"><button type="submit">전송</button></form>',{url:'https://www.bokjiro.go.kr/',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window,form=w.document.querySelector('form'),input=form.querySelector('input'),instances=[],timers=new Map();let timerId=0,submits=0,fetches=0;
  const state={key:'one',mode:'document',available:true,blocked:false,hasHistory:false,limit:300};
  w.fetch=()=>{fetches++;throw Error('실제 네트워크 금지');};w.console.log=()=>{throw Error('인식 내용 로그 금지');};
  w.setTimeout=(fn,ms)=>{assert.equal(ms,30000);timers.set(++timerId,fn);return timerId;};w.clearTimeout=id=>timers.delete(id);
  class Recognition{
    constructor(){if(options.constructorError)throw Error('private constructor');this.starts=0;this.aborts=0;instances.push(this);}
    start(){this.starts++;if(options.startError)throw options.startError;}
    abort(){this.aborts++;this.onend?.();}
  }
  if(!options.unsupported)w[options.prefixed?'webkitSpeechRecognition':'SpeechRecognition']=Recognition;
  form.addEventListener('submit',event=>{event.preventDefault();submits++;});
  w.eval(fs.readFileSync(path.join(__dirname,'../input-assist.js'),'utf8'));
  const assist=w.GyeoteInputAssist.create(form,{state:()=>state});
  const result=(text,final=true)=>({resultIndex:0,results:[Object.assign([{transcript:text}],{isFinal:final})]});
  return {w,form,input,state,instances,timers,assist,result,start:()=>form.querySelector('.voice-start').click(),
    buttons:()=>[...form.querySelectorAll('.question-suggestions button')],status:()=>form.querySelector('.voice-status').textContent,
    edit:text=>{input.value=text;input.dispatchEvent(new w.Event('input'));},counts:()=>({submits,fetches}),
    close:()=>{assist.dispose();w.close();}};
}

test('추천 3개는 초안과 포커스만 작성하고 전송·네트워크를 호출하지 않는다',()=>{
  const f=fixture();try{
    assert.equal(f.buttons().length,3);assert.equal(f.instances.length,0);
    const button=f.buttons()[0];button.click();assert.equal(f.input.value,button.textContent);assert.equal(f.w.document.activeElement,f.input);
    assert.deepEqual(f.counts(),{submits:0,fetches:0});
    f.buttons()[1].click();assert.equal(f.input.value,button.textContent);assert.match(f.status(),/유지/);
    f.start();assert.equal(f.instances.length,0);assert.equal(f.input.value,button.textContent);
  }finally{f.close();}
});
test('추천은 현재 상담·모드·제한 상태로 재구성하고 분리된 이전 버튼은 무효다',()=>{
  const f=fixture();try{
    const old=f.buttons()[0];f.state.key='other';f.state.hasHistory=true;f.assist.update();old.click();assert.equal(f.input.value,'');
    assert.equal(f.buttons().length,3);assert.match(f.buttons()[0].textContent,/그 서비스/);
    const followup=f.buttons()[0];f.state.mode='screen';f.state.key='screen';f.assist.update();followup.click();assert.equal(f.input.value,'');assert.equal(f.form.querySelector('.question-suggestions').hidden,true);
    f.state.mode='document';f.state.blocked=true;f.assist.update();assert.ok(f.buttons().every(b=>b.disabled));assert.equal(f.form.querySelector('.voice-start').disabled,true);
  }finally{f.close();}
});
for(const prefixed of [false,true])test(`명시 클릭으로만 한국어 단회 인식을 시작하고 최종 결과만 초안으로 넣는다 (${prefixed})`,()=>{
  const f=fixture({prefixed});try{
    f.start();const recognition=f.instances[0];assert.equal(recognition.starts,1);
    assert.deepEqual([recognition.lang,recognition.continuous,recognition.interimResults,recognition.maxAlternatives],['ko-KR',false,false,1]);
    f.form.querySelector('.voice-start').dispatchEvent(new f.w.Event('click'));assert.equal(f.instances.length,1);
    assert.equal(f.form.querySelector('.voice-start').getAttribute('aria-pressed'),'true');
    recognition.onresult(f.result('중간 결과',false));assert.equal(f.input.value,'');
    recognition.onresult(f.result('  <img src=x> 합성 질문  '));assert.equal(f.input.value,'<img src=x> 합성 질문');assert.equal(f.form.querySelector('img'),null);
    assert.equal(recognition.aborts,1);assert.equal(f.timers.size,0);assert.deepEqual(f.counts(),{submits:0,fetches:0});
    assert.match(f.form.querySelector('.voice-input').textContent,/외부 인식 서비스/);
  }finally{f.close();}
});
test('수동 편집은 인식을 중단하고 옛 result/end/error가 새 인식을 건드리지 않는다',()=>{
  const f=fixture();try{
    f.start();const first=f.instances[0],late={result:first.onresult,end:first.onend,error:first.onerror};
    f.edit('직접 작성한 질문');assert.equal(first.aborts,1);late.result(f.result('덮어쓸 문장'));assert.equal(f.input.value,'직접 작성한 질문');
    f.input.value='';f.start();const second=f.instances[1];late.result(f.result('이전 문장'));late.end();late.error({error:'network',message:'private transcript'});
    assert.equal(second.aborts,0);assert.equal(f.input.value,'');assert.equal(f.form.querySelector('.voice-start').getAttribute('aria-pressed'),'true');
    second.onresult(f.result('새 인식 초안'));assert.equal(f.input.value,'새 인식 초안');
  }finally{f.close();}
});
test('30초 기한과 명시 취소는 abort하며 늦은 타이머도 다음 인식을 취소하지 않는다',()=>{
  const f=fixture();try{
    f.start();const first=f.instances[0],late=first.onresult,deadline=[...f.timers.values()][0];deadline();
    assert.equal(first.aborts,1);assert.match(f.status(),/30초/);late(f.result('기한 이후 문장'));assert.equal(f.input.value,'');
    f.start();const second=f.instances[1];deadline();assert.equal(second.aborts,0);
    f.form.querySelector('.voice-cancel').click();assert.equal(second.aborts,1);assert.equal(f.timers.size,0);
  }finally{f.close();}
});
test('컨텍스트 무효화·페이지 수명 종료 후 결과는 무시하고 복귀 때 재사용한다',()=>{
  const f=fixture();try{
    f.start();const first=f.instances[0],late=first.onresult;f.state.key='new-context';f.assist.update();assert.equal(first.aborts,1);late(f.result('옛 상태'));assert.equal(f.input.value,'');
    f.start();const second=f.instances[1],lateSecond=second.onresult;f.assist.dispose();lateSecond(f.result('이탈 이후'));assert.equal(f.input.value,'');assert.equal(second.aborts,1);
    f.assist.resume();f.start();const third=f.instances[2];f.edit('복귀 후 수동 입력');assert.equal(third.aborts,1);assert.equal(f.input.value,'복귀 후 수동 입력');
  }finally{f.close();}
});
test('긴 인식 결과를 자르지 않고 수정 가능한 초안으로 보존한다',()=>{
  const f=fixture();try{
    f.start();f.instances[0].onresult(f.result('가'.repeat(301)));assert.equal(f.input.value.length,301);assert.match(f.status(),/300자/);assert.deepEqual(f.counts(),{submits:0,fetches:0});
  }finally{f.close();}
});
for(const code of ['not-allowed','audio-capture','network','no-speech','service-not-allowed','language-not-supported','aborted','unrecognized'])test(`음성 오류 ${code}는 원시 정보 없이 텍스트 대체를 유지한다`,()=>{
  const f=fixture();try{
    f.start();const first=f.instances[0];first.onerror({error:code,message:'private transcript'});
    assert.equal(first.aborts,1);assert.doesNotMatch(f.status(),/private transcript/);assert.match(f.status(),/입력/);assert.equal(f.form.querySelector('.voice-start').disabled,false);
    f.edit('계속 직접 입력');assert.equal(f.input.value,'계속 직접 입력');assert.equal(f.instances.length,1);
  }finally{f.close();}
});
for(const options of [{constructorError:true},{startError:Error('private start')},{startError:{name:'NotAllowedError',message:'private permission'}}])test('시작 예외는 수명·타이머를 정리하고 재입력을 허용한다',()=>{
  const f=fixture(options);try{
    f.start();assert.equal(f.timers.size,0);assert.equal(f.form.querySelector('.voice-start').disabled,false);assert.doesNotMatch(f.status(),/private/);
  }finally{f.close();}
});
test('미지원 브라우저에서도 텍스트 입력을 유지하고 무음 종료는 재시작하지 않는다',()=>{
  const unsupported=fixture({unsupported:true});try{
    assert.equal(unsupported.form.querySelector('.voice-start').disabled,true);assert.match(unsupported.status(),/지원하지/);unsupported.edit('직접 질문');assert.equal(unsupported.input.value,'직접 질문');
  }finally{unsupported.close();}
  const f=fixture();try{f.start();f.instances[0].onend();assert.match(f.status(),/듣지 못/);assert.equal(f.instances.length,1);}finally{f.close();}
});
