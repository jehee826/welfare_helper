const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('../../FrontEnd/node_modules/jsdom');
const protocol=require('../protocol.js');
test('연결 파일 재설정과 잘못된 형식 거절 및 지우기',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../options.html'),'utf8'),{runScripts:'outside-only'}),w=dom.window;
 let stored=null;w.GyeoteProtocol=protocol;w.chrome={storage:{session:{set:async data=>{stored=data.connection},remove:async()=>{stored=null}}}};
 w.eval(fs.readFileSync(path.join(__dirname,'../options.js'),'utf8'));
 const input=w.document.querySelector('#file'),status=w.document.querySelector('#status');
 async function load(data){Object.defineProperty(input,'files',{configurable:true,value:[{size:100,text:async()=>JSON.stringify(data)}]});input.dispatchEvent(new w.Event('change'));await new Promise(setImmediate);}
 try{
  await load({version:1,token:'a'.repeat(40),imageEnabled:false,timeoutSeconds:600});assert.equal(stored.timeoutSeconds,600);assert.match(status.textContent,/600초/);
  await load({version:1,token:'b'.repeat(40),imageEnabled:true});assert.equal(stored.timeoutSeconds,undefined);assert.equal(stored.imageEnabled,true);assert.match(status.textContent,/화면 90초 · 문서 600초/);
  await load({version:1,token:'c'.repeat(40),imageEnabled:false,timeoutSeconds:null});assert.equal(stored.token,'b'.repeat(40));assert.match(status.textContent,/유효한 연결 파일/);
  w.document.querySelector('#clear').click();await new Promise(setImmediate);assert.equal(stored,null);assert.match(status.textContent,/지웠습니다/);
 }finally{w.close()}
});
