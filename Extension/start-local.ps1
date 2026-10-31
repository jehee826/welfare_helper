$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $root
# 모델 준비는 기존 캐시만 사용한다. 새 모델 다운로드를 시작하지 않는다.
foreach($relative in @('ollama_data/models/manifests/registry.ollama.ai/library/qwen2.5/1.5b-instruct','ollama_data/models/manifests/registry.ollama.ai/library/bge-m3/latest')){
 if(-not(Test-Path -LiteralPath (Join-Path $root $relative))){throw '기존 로컬 모델 캐시가 없습니다. 새 모델을 다운로드하지 않고 중지합니다.'}
}
$probe=New-Object Diagnostics.Process
$probe.StartInfo=New-Object Diagnostics.ProcessStartInfo
$probe.StartInfo.FileName='docker.exe';$probe.StartInfo.Arguments='version --format {{.Server.Version}}'
$probe.StartInfo.UseShellExecute=$false;$probe.StartInfo.CreateNoWindow=$true;$probe.StartInfo.RedirectStandardOutput=$true;$probe.StartInfo.RedirectStandardError=$true
[void]$probe.Start()
if(-not $probe.WaitForExit(15000)){$probe.Kill();throw 'Docker 엔진이 응답하지 않습니다. Docker Desktop의 오류를 먼저 확인하세요.'}
if($probe.ExitCode -ne 0){throw 'Docker 엔진이 준비되지 않았습니다. Docker Desktop을 확인하세요.'}
$bytes=New-Object byte[] 48;$random=[Security.Cryptography.RandomNumberGenerator]::Create();try{$random.GetBytes($bytes)}finally{$random.Dispose()}
$token=[Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
$overrides=@{OLLAMA_LLM='qwen2.5:1.5b-instruct';OLLAMA_RUNTIME='runc';DESKTOP_GUIDANCE_ENABLED='true';DESKTOP_IMAGE_ENABLED='false';DESKTOP_EXTENSION_TOKEN=$token;BACKEND_BIND_HOST='127.0.0.1';LLM_NUM_CTX='16384'}
$prior=@{}
try{
 foreach($name in $overrides.Keys){$prior[$name]=[Environment]::GetEnvironmentVariable($name,'Process');[Environment]::SetEnvironmentVariable($name,$overrides[$name],'Process')}
 # 실행 중인 Ollama 이미지를 다시 빌드해 불필요하게 재생성하지 않는다.
 & docker compose build backend
 if($LASTEXITCODE -ne 0){throw '백엔드 빌드에 실패했습니다. 연결 파일은 변경하지 않았습니다.'}
 & docker compose up -d --no-build backend
 if($LASTEXITCODE -ne 0){throw '백엔드 실행에 실패했습니다. 연결 파일은 변경하지 않았습니다.'}
 $directory=Join-Path $root '.local';[void][IO.Directory]::CreateDirectory($directory)
 & docker compose exec -T backend python -m BackEnd.desktop_connection /tmp/gyeote-extension-connection.json
 if($LASTEXITCODE -ne 0){throw '실제 서버의 연결 설정을 내보내지 못했습니다.'}
 & docker compose cp backend:/tmp/gyeote-extension-connection.json (Join-Path $directory 'extension-connection.json')
 if($LASTEXITCODE -ne 0){throw '연결 파일을 로컬로 복사하지 못했습니다.'}
 & docker compose exec -T backend python -c "from pathlib import Path; Path('/tmp/gyeote-extension-connection.json').unlink()"
 Write-Output '연결 파일 준비: .local\extension-connection.json. 서버 준비 응답 확인 후 확장 연결 설정에서 이 파일을 불러오세요.'
}finally{
 foreach($name in $prior.Keys){[Environment]::SetEnvironmentVariable($name,$prior[$name],'Process')}
 $token=$null;$connection=$null
}
