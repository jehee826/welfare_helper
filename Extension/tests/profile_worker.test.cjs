const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const protocol=require('../protocol.js'),source=fs.readFileSync(path.join(__dirname,'../worker.js'),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const key='gyeote.profile',profile={age:70,income:'under50',household:'single',region:'서울특별시',disability:false};
function worker(data={},failure={}){
 let listener,changed;const calls={get:0,set:0,level:[]},tabMessages=[],runtimeMessages=[];
 const chrome={runtime:{id:'x',getURL:n=>'chrome-extension://x/'+n,onMessage:{addListener(fn){listener=fn;}},sendMessage:async m=>runtimeMessages.push(m)},
  storage:{local:{async setAccessLevel(value){calls.level.push(value);if(failure.level)throw Error('private level error');},async get(name){calls.get++;assert.equal(name,key);if(failure.get)throw Error('private read error');return {[key]:data[key]};},async set(value){calls.set++;if(failure.set)throw Error('private write error');const previous=data[key];Object.assign(data,plain(value));changed?.({[key]:{oldValue:previous,newValue:data[key]}},'local');}},onChanged:{addListener(fn){changed=fn;}}},
  tabs:{query:async()=>[{id:1}],sendMessage:async(_id,message)=>tabMessages.push(message)},action:{onClicked:{addListener(){}}}};
 vm.runInNewContext(source,{chrome,GyeoteProtocol:protocol,importScripts(){},URL,crypto:require('node:crypto').webcrypto});
 const sender={id:'x',frameId:0,url:'https://www.bokjiro.go.kr/',tab:{id:1,url:'https://www.bokjiro.go.kr/'}};
 const send=(message,from=sender)=>new Promise(resolve=>{if(!listener(message,from,value=>resolve(plain(value))))resolve(undefined);});
 return {data,calls,send,sender,tabMessages,runtimeMessages};
}

test('첫 읽기·저장·worker 재생성·나중 입력·삭제는 revision과 확장 저장소를 유지한다',async()=>{
 const data={},f=worker(data);const first=await f.send({type:'gyeote:profile-get'});
 assert.deepEqual(first.state,{schemaVersion:1,revision:0,onboardingCompleted:false,profile:null});assert.equal(f.calls.set,0);
 assert.deepEqual(plain(f.calls.level),[{accessLevel:'TRUSTED_CONTEXTS'}]);
 const saved=await f.send({type:'gyeote:profile-save',expectedRevision:0,profile});assert.equal(saved.state.revision,1);assert.deepEqual(saved.state.profile,profile);
 assert.deepEqual((await worker(data).send({type:'gyeote:profile-get'})).state,saved.state);
 const cleared=await f.send({type:'gyeote:profile-clear',expectedRevision:1});assert.equal(cleared.state.revision,2);assert.equal(cleared.state.onboardingCompleted,false);assert.equal(cleared.state.profile,null);
 assert.equal((await f.send({type:'gyeote:profile-save',expectedRevision:1,profile})).error,'profile_conflict');
 const skipped=await f.send({type:'gyeote:profile-save',expectedRevision:2,profile:null});assert.equal(skipped.state.onboardingCompleted,true);assert.equal(skipped.state.revision,3);assert.equal(skipped.state.profile,null);
 assert.deepEqual(Object.keys(data),[key]);assert.ok(!JSON.stringify(f.tabMessages).includes('서울'));assert.ok(!JSON.stringify(f.runtimeMessages).includes('서울'));
});

test('복수 탭의 동시 저장은 하나만 성공하고 오래된 수정·삭제를 거절한다',async()=>{
 const f=worker();const replies=await Promise.all([f.send({type:'gyeote:profile-save',expectedRevision:0,profile}),f.send({type:'gyeote:profile-save',expectedRevision:0,profile:{...profile,age:40}})]);
 assert.equal(replies.filter(r=>r.ok).length,1);assert.equal(replies.find(r=>!r.ok).error,'profile_conflict');assert.equal(f.data[key].revision,1);
 assert.equal((await f.send({type:'gyeote:profile-clear',expectedRevision:0})).error,'profile_conflict');assert.equal(f.calls.set,1);
});

test('TRUSTED_CONTEXTS 준비 실패는 읽기·쓰기를 막고 원문 오류를 내보내지 않는다',async()=>{
 const f=worker({}, {level:true});const result=await f.send({type:'gyeote:profile-get'});
 assert.deepEqual(result,{ok:false,error:'profile_storage_failed'});assert.equal(f.calls.get,0);assert.equal(f.calls.set,0);
});

test('읽기·쓰기 실패는 기존 데이터를 보존하고 다음 저장을 막지 않는다',async()=>{
 const original={schemaVersion:1,revision:1,onboardingCompleted:true,profile},data={[key]:original},failure={set:true},f=worker(data,failure);
 assert.equal((await f.send({type:'gyeote:profile-save',expectedRevision:1,profile:null})).error,'profile_storage_failed');assert.deepEqual(data[key],original);
 failure.set=false;assert.equal((await f.send({type:'gyeote:profile-save',expectedRevision:1,profile:null})).state.revision,2);
 failure.get=true;assert.equal((await f.send({type:'gyeote:profile-get'})).error,'profile_storage_failed');assert.equal(data[key].revision,2);
});

for(const raw of ['broken',{schemaVersion:2,revision:4,onboardingCompleted:true,profile},{schemaVersion:1,revision:'bad',onboardingCompleted:true,profile}])test('손상·새 스키마는 자동 초기화하지 않고 확인한 상태만 명시적으로 재설정한다: '+JSON.stringify(raw),async()=>{
 const data={[key]:raw},f=worker(data),read=await f.send({type:'gyeote:profile-get'});
 assert.equal(read.error,'profile_data_invalid');assert.ok(read.resetToken);assert.equal(f.calls.set,0);assert.deepEqual(data[key],raw);
 assert.equal((await f.send({type:'gyeote:profile-reset',resetToken:'incorrect'})).error,'profile_conflict');
 const reset=await f.send({type:'gyeote:profile-reset',resetToken:read.resetToken});assert.equal(reset.ok,true);assert.equal(reset.state.onboardingCompleted,false);assert.equal(reset.state.profile,null);
});

test('늦은 재설정은 이미 정상화된 새 정보를 덮지 않는다',async()=>{
 const data={[key]:'broken'},f=worker(data),read=await f.send({type:'gyeote:profile-get'});
 data[key]={schemaVersion:1,revision:8,onboardingCompleted:true,profile};
 assert.equal((await f.send({type:'gyeote:profile-reset',resetToken:read.resetToken})).error,'profile_conflict');assert.equal(data[key].revision,8);assert.equal(f.calls.set,0);
});

test('공식 최상위 동일 탭 외 sender와 arbitrary key 메시지는 저장소를 열지 않는다',async()=>{
 const f=worker();
 for(const change of [{id:'other'},{frameId:1},{url:'https://example.invalid/'},{url:'chrome-extension://x/options.html'},{url:'chrome-extension://x/offscreen.html'},{tab:{id:1,url:'https://www.bokjiro.go.kr/changed'}},{tab:{url:'https://www.bokjiro.go.kr/'}}])assert.equal(await f.send({type:'gyeote:profile-get'},{...f.sender,...change}),undefined);
 assert.equal(f.calls.get,0);
 assert.equal((await f.send({type:'gyeote:profile-get',key:'documentAdminSession'})).error,'invalid_profile');
 assert.equal((await f.send({type:'gyeote:profile-save',expectedRevision:0,profile:{...profile,token:'private'}})).error,'invalid_profile');assert.equal(f.calls.set,0);
});

test('모름과 정상 프로필은 정규화하고 조작값·화면 프로필 전송은 거절한다',()=>{
 assert.deepEqual(protocol.profile({}),{age:null,income:'unknown',household:null,region:null,disability:null});
 assert.deepEqual(protocol.documentRequest({query:'질문',profile}).profile,profile);
 for(const value of [{...profile,age:true},{...profile,age:121},{...profile,household:'invented'},{...profile,region:'상세주소'},{...profile,income:null},{...profile,disability:'false'}])assert.throws(()=>protocol.documentRequest({query:'질문',profile:value}));
 assert.throws(()=>protocol.request({profile}));assert.equal(protocol.documentRequest({query:'질문',profile:null}).profile,null);
});
