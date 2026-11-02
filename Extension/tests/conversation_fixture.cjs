const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const key='gyeote.conversations',profileKey='gyeote.profile';
const profile={schemaVersion:1,revision:1,onboardingCompleted:true,profile:null};
const settle=async()=>{for(let i=0;i<6;i++)await new Promise(setImmediate);};
function worker(data={[profileKey]:profile},failure={},scriptSource=source,fetcher=()=>{throw Error('실제 통신 금지');},sharedSession=null){
  let listener,changed,clicked,removed;const clients=new Map(),messages=[],calls={get:[],set:[],level:[]};
  const session=sharedSession||{documentAccess:'anonymous',documentAccessId:'public-1'};
  const chrome={runtime:{id:'x',getURL:name=>'chrome-extension://x/'+name,onMessage:{addListener(fn){listener=fn;}},sendMessage:async message=>messages.push(plain(message)),getContexts:async()=>[{}]},
    storage:{local:{setAccessLevel:async value=>{calls.level.push(value);if(failure.level)throw Error('private failure');},get:async name=>{calls.get.push(name);if(![key,profileKey].includes(name))throw Error('임의 key 접근');if(failure.get)throw Error('private failure');if(failure.beforeGet)await failure.beforeGet(name);return {[name]:plain(data[name]??null)===null?undefined:plain(data[name])};},set:async value=>{
      calls.set.push(plain(value));if(failure.set||failure.quota&&key in value)throw Error('private quota failure');if(failure.beforeSet)await failure.beforeSet(value);
      const changes={};for(const [name,item] of Object.entries(value)){changes[name]={oldValue:data[name],newValue:plain(item)};data[name]=plain(item);}changed(changes,'local');
    }},session:{setAccessLevel:async()=>{},get:async keys=>{if(failure.beforeSessionGet)await failure.beforeSessionGet(keys);return Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(name=>[name,session[name]]));},set:async value=>{if(failure.sessionSet)throw Error('session failure');if(failure.beforeSessionSet)await failure.beforeSessionSet(value);const changes={};for(const [name,item] of Object.entries(value)){changes[name]={oldValue:session[name],newValue:item};session[name]=plain(item);}changed(changes,'session');},remove:async name=>{delete session[name];}},onChanged:{addListener(fn){changed=fn;}}},
    tabs:{onRemoved:{addListener(fn){removed=fn;}},query:async()=>[...clients.keys()].map(id=>({id})),sendMessage:async(id,message)=>clients.get(id)?.(plain(message),{id:'x'},()=>{})},action:{onClicked:{addListener(fn){clicked=fn;}}}};
  const sandbox={chrome,URL,TextEncoder,TextDecoder,crypto:require('node:crypto').webcrypto,AbortController,setTimeout,clearTimeout,fetch:fetcher};
  const context=vm.createContext(sandbox);sandbox.importScripts=(...names)=>names.forEach(name=>vm.runInContext(scriptSource(name),context));vm.runInContext(scriptSource('worker.js'),context);
  const sender=id=>({id:'x',frameId:0,url:'https://www.bokjiro.go.kr/',tab:{id,url:'https://www.bokjiro.go.kr/'}});
  const send=(message,from=sender(1))=>new Promise(resolve=>{if(!listener(plain(message),from,value=>resolve(plain(value))))resolve(undefined);});
  const action=(operation,fields={},id=1)=>send({type:'gyeote:conversations-'+operation,accessId:session.documentAccessId,...fields},sender(id));
  return {data,failure,session,calls,messages,clients,send,sender,action,source:scriptSource,click:tab=>clicked(tab),removeTab:id=>removed(id),notify:(change,area='local')=>changed(change,area)};
}
function ui(server,id=1,setup=()=>{}){
  const {JSDOM}=require('../../FrontEnd/node_modules/jsdom');
  const dom=new JSDOM('<main><button>공개 메뉴</button></main>',{url:'https://www.bokjiro.go.kr/',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;let root,listener;
  const ports=[],requests=[];
  w.TextEncoder=TextEncoder;w.TextDecoder=TextDecoder;
  const attach=w.Element.prototype.attachShadow;w.Element.prototype.attachShadow=function(options){const result=attach.call(this,options);if(this.hasAttribute('data-gyeote-host'))root=result;return result;};
  w.Element.prototype.getBoundingClientRect=()=>({x:40,y:60,left:40,top:60,right:180,bottom:100,width:140,height:40});
  const computed=w.getComputedStyle.bind(w);w.getComputedStyle=node=>{const style=computed(node);return {display:style.display,visibility:style.visibility||'visible',opacity:style.opacity||'1',position:style.position||'static'};};
  w.document.elementFromPoint=()=>w.document.querySelector('main button');w.requestAnimationFrame=fn=>{queueMicrotask(fn);return 1;};w.cancelAnimationFrame=()=>{};
  w.Storage.prototype.getItem=w.Storage.prototype.setItem=()=>{throw Error('호스트 저장소 금지');};
  w.chrome={runtime:{id:'x',onMessage:{addListener(fn){listener=fn;server.clients.set(id,fn);}},sendMessage:async message=>{requests.push(plain(message));return server.send(message,server.sender(id));},connect:()=>{
    const port={onMessage:{addListener(fn){port.receive=fn;}},onDisconnect:{addListener(fn){port.disconnectedListener=fn;}},postMessage(packet){port.packet=plain(packet);},disconnect(){port.disconnected=true;port.disconnectedListener?.();}};ports.push(port);return port;
  }}};
  setup(w);
  const scriptSource=server.source||source;
  for(const name of JSON.parse(scriptSource('manifest.json')).content_scripts[0].js)w.eval(scriptSource(name));
  const button=(text,scope=root)=>[...scope.querySelectorAll('button')].find(node=>node.textContent===text||node.getAttribute('aria-label')===text);
  return {w,root,ports,requests,ready:settle,button,
    click:async(text,scope=root)=>{const node=button(text,scope);if(!node)throw Error('버튼 없음: '+text);node.click();await settle();},
    question:async text=>{root.querySelector('#gyeote-question').value=text;root.querySelector('.consultation form').dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();},
    answer:async(body,port=ports.at(-1),type='result')=>{await port.receive({type,requestId:port.packet.requestId,body});await settle();},
    mode:async value=>{const node=root.querySelector('.mode');node.value=value;node.dispatchEvent(new w.Event('change'));await settle();},
    notify:message=>listener(message,{id:'x'},()=>{}),close:()=>{w.dispatchEvent(new w.Event('pagehide'));server.clients.delete(id);w.close();}};
}
const expected=state=>({expectedRevision:state.revision,generation:state.generation,conversationId:state.lastActiveConversationId});
const answer={kind:'answer',text:'합성 복지 안내',evidence:[]};
async function append(f,state,pairId='A'.repeat(20),question='합성 질문',body=answer,id=1){const fields={...expected(state),pairId,profileRevision:1};const begun=await f.action('begin',fields,id);if(!begun.ok)return begun;return f.action('append',{...fields,question,answer:body},id);}
module.exports={worker,ui,key,profileKey,profile,plain,source,settle,expected,answer,append};
