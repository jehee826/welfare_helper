try{const origin=GyeoteProtocol.documentOrigin();document.querySelector('#document-server').textContent='서버: '+origin+' · 공개 문서 상담과 화면 안내를 제공합니다.';}
catch{document.querySelector('#document-server').textContent='설치 패키지의 서버 설정을 확인하지 못했습니다. 올바른 패키지로 다시 설치해 주세요.';}
