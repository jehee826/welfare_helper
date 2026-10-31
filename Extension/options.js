const status=document.querySelector('#status');
document.querySelector('#file').addEventListener('change',async event=>{
  try{
    const file=event.target.files[0];if(!file||file.size>2048)throw new Error();
    const data=JSON.parse(await file.text());
    if(Object.keys(data).sort().join(',')!=='imageEnabled,token,version'||data.version!==1||typeof data.token!=='string'||!/^[A-Za-z0-9_-]{32,128}$/.test(data.token)||typeof data.imageEnabled!=='boolean')throw new Error();
    await chrome.storage.session.set({connection:{token:data.token,imageEnabled:data.imageEnabled}});
    status.textContent='연결 정보를 준비했습니다. 복지로 탭으로 돌아가 질문하세요. 이미지 옵션: '+(data.imageEnabled?'사용 가능':'꺼짐');
  }catch{status.textContent='유효한 연결 파일을 확인하지 못했습니다. 토큰을 채팅으로 보내지 마세요.';}
  finally{event.target.value='';}
});
document.querySelector('#clear').addEventListener('click',async()=>{await chrome.storage.session.remove('connection');status.textContent='연결 정보를 지웠습니다.';});
