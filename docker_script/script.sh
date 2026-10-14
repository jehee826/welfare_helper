#!/bin/sh
set -e

# 1. 백그라운드로 ollama 서버 실행
ollama serve &
PID=$!

# 2. 서버가 완전히 뜰 때까지 대기
echo "Waiting for Ollama server..."
until ollama list >/dev/null 2>&1; do
  sleep 1
done

# 3. 환경변수(OLLAMA_PULL_MODELS)에 있는 모델들을 체크해서 없으면 다운로드
for model in $OLLAMA_PULL_MODELS; do
  if ollama list | awk '{print $1}' | grep -Fxq "$model"; then
    echo "Model already exists: $model"
  else
    echo "Downloading model: $model"
    ollama pull "$model"
  fi
done

# 4. 서버 프로세스 유지
wait $PID
