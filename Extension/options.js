const status=document.querySelector('#status');
let screenAllowed=false,configurationReady=false;
try{const origin=GyeoteProtocol.documentOrigin();screenAllowed=GyeoteProtocol.screenAvailable();configurationReady=true;document.querySelector('#document-server').textContent='문서 서버: '+origin+' · 공개 상담은 연결 파일 없이 사용할 수 있습니다.';}
catch{document.querySelector('#document-server').textContent='설치 패키지의 서버 설정을 확인하지 못했습니다. 올바른 패키지로 다시 설치해 주세요.';}
document.querySelector('#screen-connection').hidden=!screenAllowed;document.querySelector('#file').disabled=!screenAllowed;
if(!screenAllowed)status.textContent='이 패키지는 원격 화면 안내를 제공하지 않습니다.';
document.querySelector('#file').addEventListener('change',async event=>{
  try{
    if(!screenAllowed)throw new Error();
    const file=event.target.files[0];if(!file||file.size>2048)throw new Error();
    const data=JSON.parse(await file.text());
    if(!['imageEnabled,token,version','imageEnabled,timeoutSeconds,token,version'].includes(Object.keys(data).sort().join(','))||data.version!==1||typeof data.token!=='string'||!/^[A-Za-z0-9_-]{32,128}$/.test(data.token)||typeof data.imageEnabled!=='boolean')throw new Error();
    const timeoutSeconds=GyeoteProtocol.timeoutSeconds(data);
    const connection={token:data.token,imageEnabled:data.imageEnabled,...(data.timeoutSeconds===undefined?{}:{timeoutSeconds})};
    await chrome.storage.session.set({connection});
    status.textContent='연결 정보를 준비했습니다. 복지로 탭으로 돌아가 질문하세요. 이미지: '+(data.imageEnabled?'사용 가능':'꺼짐')+' · 화면 '+timeoutSeconds+'초 · 문서 '+GyeoteProtocol.documentTimeoutSeconds(connection)+'초';
  }catch{status.textContent='유효한 연결 파일을 확인하지 못했습니다. 토큰을 채팅으로 보내지 마세요.';}
  finally{event.target.value='';}
});
document.querySelector('#clear').addEventListener('click',async()=>{await chrome.storage.session.remove('connection');status.textContent='연결 정보를 지웠습니다.';});

const adminStatus=document.querySelector('#admin-status'),adminForm=document.querySelector('#admin-form'),passwordInput=document.querySelector('#admin-password');
if(!configurationReady){document.querySelector('#admin-login').disabled=true;document.querySelector('#admin-logout').disabled=true;}
let adminBusy=false,adminVersion=0;
function showAdmin(result){
  adminStatus.textContent=result?.mode==='admin'?(result.status==='ready'?'문서 접근: 관리자 연결됨':result.status==='unverified'?'문서 접근: 관리자 세션 있음 · 서버 연결 확인 필요':'문서 접근: 관리자 세션 만료 · 다시 로그인하세요.'):'문서 접근: 공개 문서 (익명)';
}
async function checkAdmin(){
  if(!configurationReady)return;
  const version=adminVersion;
  try{const result=await chrome.runtime.sendMessage({type:'gyeote:admin-check'});if(version===adminVersion&&!adminBusy)showAdmin(result);}catch{if(!adminBusy)adminStatus.textContent='확장 연결을 확인하지 못했습니다. 옵션을 다시 열어 주세요.';}
}
adminForm.addEventListener('submit',async event=>{
  event.preventDefault();if(adminBusy||!configurationReady){passwordInput.value='';return;}
  let password=passwordInput.value;passwordInput.value='';
  if(!password||password.length>256){password='';adminStatus.textContent='관리자 비밀번호를 입력하세요.';return;}
  adminBusy=true;adminVersion++;document.querySelector('#admin-login').disabled=true;document.querySelector('#admin-logout').disabled=true;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);let body;
  try{
    const origin=GyeoteProtocol.documentOrigin();
    const pending=fetch(origin+'/api/v1/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password}),credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal});password='';
    const response=await pending;
    if(!response.ok)throw new Error(response.status===401?'password':response.status===429?'rate':'connection');
    const raw=await response.text();if(raw.length>4096)throw new Error('connection');body=JSON.parse(raw);
    const session={token:body.access_token,expiresAt:body.expires_at,origin};if(!GyeoteProtocol.documentSession(session))throw new Error('connection');
    const result=await chrome.runtime.sendMessage({type:'gyeote:admin-connect',session});if(!result?.ok)throw new Error('connection');showAdmin(result);
  }catch(error){adminStatus.textContent=error.message==='password'?'관리자 비밀번호가 일치하지 않습니다.':error.message==='rate'?'로그인 시도가 많습니다. 잠시 후 다시 시도하세요.':'관리자 연결을 확인하지 못했습니다. 서버를 확인하고 직접 다시 시도하세요.';}
  finally{password='';body=null;passwordInput.value='';clearTimeout(timer);adminBusy=false;document.querySelector('#admin-login').disabled=false;document.querySelector('#admin-logout').disabled=false;}
});
document.querySelector('#admin-logout').addEventListener('click',async()=>{
  if(adminBusy)return;adminVersion++;passwordInput.value='';adminBusy=true;
  try{const result=await chrome.runtime.sendMessage({type:'gyeote:admin-logout'});showAdmin(result);if(result?.serverRevoked===false)adminStatus.textContent+=' · 서버 세션 해제는 확인하지 못했습니다.';}
  catch{adminStatus.textContent='로그아웃을 확인하지 못했습니다. 옵션을 다시 열어 확인하세요.';}
  finally{adminBusy=false;}
});
addEventListener('focus',()=>{if(!adminBusy)void checkAdmin();});
void checkAdmin();
