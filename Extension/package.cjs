const fs=require('node:fs'),path=require('node:path');
const {validateDocumentOrigin,validateDocumentTimeout}=require('./protocol.js');
const runtimeFiles=Object.freeze(['manifest.json','protocol.js','worker.js','offscreen.html','offscreen.js','image.js','options.html','options.js','options.css','dom.js','capture.js','profile.js','conversations.js','conversation-store.js','conversation-panel.js','input-assist.js','content.js']);

function packageExtension({origin,name,timeoutSeconds=600,remoteScreen=false,...extra}){
  origin=validateDocumentOrigin(origin);
  timeoutSeconds=validateDocumentTimeout(timeoutSeconds);
  if(typeof remoteScreen!=='boolean'||remoteScreen&&origin==='http://127.0.0.1:8000')throw new Error('원격 DOM 옵션은 HTTPS 패키지에서만 지정하세요.');
  if(Object.keys(extra).length||typeof name!=='string'||!/^\w[\w-]{0,63}$/.test(name))throw new Error('패키지 이름은 영문·숫자·밑줄·하이픈 1~64자로 지정하세요.');
  const repository=fs.realpathSync(path.resolve(__dirname,'..')),base=path.join(repository,'.local','extension-packages'),output=path.join(base,name);
  // 기존 상위 폴더의 링크를 통해 저장소 밖으로 쓰지 않는다.
  for(const parent of [path.dirname(base),base])if(fs.existsSync(parent)){
    const relative=path.relative(repository,fs.realpathSync(parent));
    if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('출력 상위 폴더는 저장소 안에 있어야 합니다.');
  }
  if(fs.existsSync(output))throw new Error('이미 존재하는 출력 폴더는 덮어쓰지 않습니다. 새 이름을 지정하세요.');
  const files=runtimeFiles.map(name=>{
    const source=path.join(__dirname,name);
    if(!fs.lstatSync(source).isFile())throw new Error('운영 파일은 일반 파일이어야 합니다.');
    let content=fs.readFileSync(source,'utf8');
    if(name==='protocol.js'){
      const marker=/const documentDeployment=Object\.freeze\(\{[^\r\n]*\}\);/g;
      if(content.match(marker)?.length!==1)throw new Error('정적 서버 설정 위치를 확인하지 못했습니다.');
      content=content.replace(marker,'const documentDeployment=Object.freeze('+JSON.stringify({origin,timeoutSeconds})+');');
      const screenMarker=/const remoteScreenDeployment=(?:true|false);/g;
      if(content.match(screenMarker)?.length!==1)throw new Error('원격 DOM 설정 위치를 확인하지 못했습니다.');
      content=content.replace(screenMarker,'const remoteScreenDeployment='+remoteScreen+';');
    }
    if(name==='manifest.json'){
      const manifest=JSON.parse(content);manifest.host_permissions=[origin+'/*'];
      if(origin!=='http://127.0.0.1:8000'){
        manifest.name=remoteScreen?'곁에 · 복지 상담과 화면 안내':'곁에 · 복지 상담';manifest.description=remoteScreen?'등록 문서 상담과 공개 복지로 DOM 화면 안내를 제공합니다. 이미지는 전송하지 않습니다.':'등록된 복지 문서를 검색하고 상담합니다. 원격 화면 안내는 제공하지 않습니다.';manifest.action.default_title='곁에 열기';
      }
      content=JSON.stringify(manifest,null,2)+'\n';
    }
    if(name==='options.html'||name==='offscreen.html'){
      const connect=/connect-src [^;"\r\n]+/g;
      if(content.match(connect)?.length!==1)throw new Error('서버 연결 정책 위치를 확인하지 못했습니다.');
      content=content.replace(connect,'connect-src '+origin);
    }
    return [name,content];
  });
  fs.mkdirSync(base,{recursive:true});fs.mkdirSync(output);
  for(const [name,content] of files)fs.writeFileSync(path.join(output,name),content,{flag:'wx'});
  return output;
}
if(require.main===module){
  try{
    const args=process.argv.slice(2),remoteScreen=args.at(-1)==='--remote-screen';if(remoteScreen)args.pop();
    if(![4,6].includes(args.length)||args[0]!=='--origin'||args[2]!=='--name'||args.length===6&&args[4]!=='--timeout')throw new Error('사용법: node Extension/package.cjs --origin HTTPS_ORIGIN --name NEW_NAME [--timeout SECONDS] [--remote-screen]');
    process.stdout.write(packageExtension({origin:args[1],name:args[3],remoteScreen,...(args.length===6?{timeoutSeconds:Number(args[5])}:{})})+'\n');
  }catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
}
module.exports={packageExtension,runtimeFiles};
