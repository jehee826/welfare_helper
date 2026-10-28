#!/bin/sh
set -eu

ready_file=/tmp/ollama-models-ready
rm -f "$ready_file"
ollama serve &
server_pid=$!
cleanup() {
  rm -f "$ready_file"
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 143' TERM INT

echo "Waiting for Ollama server..."
remaining=60
until ollama list >/dev/null 2>&1; do
  if ! kill -0 "$server_pid" 2>/dev/null || [ "$remaining" -le 0 ]; then
    echo "Ollama server startup failed" >&2
    exit 1
  fi
  remaining=$((remaining - 1))
  sleep 1
done

: "${OLLAMA_PULL_MODELS:?Configure OLLAMA_PULL_MODELS}"
for model in $OLLAMA_PULL_MODELS; do
  # :latest 별칭도 같은 설치 모델로 확인해 불필요한 pull을 막는다.
  if ollama show "$model" >/dev/null 2>&1; then
    echo "Model already exists: $model"
  else
    echo "Downloading model: $model"
    ollama pull "$model"
    ollama show "$model" >/dev/null
  fi
done

touch "$ready_file"
wait "$server_pid"
# 서버가 예상치 않게 정상 코드로 종료돼도 서비스 중단으로 기록한다.
echo "Ollama server stopped unexpectedly" >&2
exit 1
