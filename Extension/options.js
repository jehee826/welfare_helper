let configurationReady=false;
try{const origin=GyeoteProtocol.documentOrigin();configurationReady=true;document.querySelector('#document-server').textContent='서버: '+origin+' · 공개 상담과 화면 안내는 관리자 로그인 없이 사용할 수 있습니다.';}
catch{document.querySelector('#document-server').textContent='설치 패키지의 서버 설정을 확인하지 못했습니다. 올바른 패키지로 다시 설치해 주세요.';}

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
