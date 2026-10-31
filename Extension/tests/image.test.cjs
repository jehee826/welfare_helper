const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
test('이미지 크기·CSS 마스크 배율·원본 해제를 제한하고 잘못된 영역은 거부',async()=>{
 let dimensions,fills=[],closed=0;
 class Canvas{constructor(width,height){dimensions={width,height};}getContext(){return {drawImage(){},fillRect(...args){fills.push(args);},set fillStyle(value){}};}async convertToBlob(){return new Blob([new Uint8Array([1,2,3])],{type:'image/png'});}}
 const context={Blob,Uint8Array,atob,btoa,OffscreenCanvas:Canvas,createImageBitmap:async()=>({width:1920,height:1200,close(){closed++;}})};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../image.js'),'utf8'),context);
 const image='data:image/png;base64,'+btoa('synthetic');
 await context.GyeoteImage.prepare(image,{width:960,height:600},[{x:10,y:20,width:100,height:30}]);
 assert.deepEqual(dimensions,{width:1280,height:800});assert.deepEqual(fills[0],[13,26,134,41]);assert.equal(closed,1);
 await assert.rejects(context.GyeoteImage.prepare(image,{width:960,height:600},[{x:-1,y:20,width:100,height:30}]));assert.equal(closed,2);
 await assert.rejects(context.GyeoteImage.prepare('https://other.test/image.png',{width:960,height:600},[]));
});
test('탭 캡처 권한 오류는 이미지 없는 성공으로 바꾸지 않음',async()=>{
 let listener,processed=0;
 const protocol=require('../protocol.js');
 const chrome={runtime:{id:'a'.repeat(32),getURL:filename=>'chrome-extension://'+'a'.repeat(32)+'/'+filename,getContexts:async()=>[{}],onMessage:{addListener(fn){listener=fn;}},sendMessage:async()=>{processed++;return {ok:true,image:'unused'};}},action:{onClicked:{addListener(){}}},tabs:{get:async()=>({active:true,url:'https://www.bokjiro.go.kr/ssis-tbu/index.do'}),captureVisibleTab:async()=>{throw Error('permission denied');}},windows:{get:async()=>({focused:true})}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../worker.js'),'utf8'),{chrome,importScripts(){},GyeoteProtocol:protocol});
 const sender={id:chrome.runtime.id,frameId:0,url:'https://www.bokjiro.go.kr/ssis-tbu/index.do',tab:{id:1,windowId:2,url:'https://www.bokjiro.go.kr/ssis-tbu/index.do'}};
 const result=await new Promise(resolve=>listener({type:'gyeote:capture',masks:[],viewport:{width:960,height:600}},sender,resolve));
 assert.equal(result.ok,false);assert.equal(result.error,'capture_permission_or_failed');assert.equal(processed,0);
});
