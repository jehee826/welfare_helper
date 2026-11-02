# Python 의존성 잠금

`locks/*-py312-linux.txt`는 uv 0.10.9로 해석한 **CPython 3.12·Linux AMD64** 버전·배포 파일 해시다. Windows 가상환경을 freeze한 결과가 아니며 다른 플랫폼 잠금으로 사용하지 않는다.

| 잠금 | 범위 |
|---|---|
| backend | 기본 API + ONNX 리랭커 의존성 |
| worker | Docling + torch 2.10.0+cpu·torchvision 0.25.0+cpu |
| dev | backend와 같은 버전 + pytest |
| build | pip·setuptools·wheel 및 빌드 도구 의존성 |

backend의 huggingface-hub 2.2.0과 worker의 1.33.0은 실행 환경별로 분리한다. Docling 2.141.0이 hub<2를 요구하므로 같은 환경에 합치지 않는다. worker의 정확한 `+cpu` 버전·해시와 공식 CPU index를 유지한다.

Docker와 CI는 build 잠금을 먼저 설치한 뒤 runtime 잠금을 `--require-hashes --no-build-isolation`으로 설치한다. kiwipiepy-model의 sdist 빌드에 필요한 setuptools>=77까지 고정해 격리 빌드의 숨은 의존성 다운로드를 피한다.

```sh
python -m pip install --require-hashes -r requirements/locks/build-py312-linux.txt
python -m pip install --require-hashes --no-build-isolation -r requirements/locks/dev-py312-linux.txt
python -m pip check
python scripts/ci_python.py imports --profile dev
python scripts/ci_python.py tests
```

위 명령은 별도의 Linux Python 3.12 가상환경에서 실행한다. 기존 환경을 덮어쓰지 않는다. 입력 의존성을 바꾼 뒤 저장소 루트에서 `python scripts/lock_python.py`로 네 잠금을 다시 해석하고 설치·검사를 확인한다. 기존 requirements 파일과 pyproject.toml은 해석 입력이며 Docker 설치에는 잠금을 사용한다. 이 스크립트에는 uv 0.10.9가 필요하다.

## 모델 없는 CI

`.github/workflows/ci.yml`은 backend/worker/dev를 분리 설치해 pip check·최소 import를 실행하고, dev에서는 `scripts/ci_python.py`의 선정 계약/API 검사를 실행한다. 원격 DOM의 opt-in·금지 필드·공유 예산·loopback 전송 검사도 포함한다. FrontEnd는 npm ci·test:ci·build:ci, Extension은 workflow에 지정한 일곱 계약 파일을 검사한다. 실제 .env를 읽지 않으며 개인정보·인증·빈도 제한 가드는 유지한다.

실제 DB·Ollama·모델 가중치·Docling PDF 해석은 기본 CI에 포함하지 않는다. 해당 통합 검사는 준비된 별도 환경에서 명시적으로 선택해 실행한다. CPU torch 배포 패키지 설치는 모델 가중치 다운로드나 추론이 아니다.

GitHub Actions는 [checkout](https://github.com/actions/checkout/releases/tag/v7.0.1), [setup-python](https://github.com/actions/setup-python/releases/tag/v7.1.0), [setup-node](https://github.com/actions/setup-node/releases/tag/v7.1.0)의 확인한 릴리스 commit SHA로 고정한다. 원격 CI 성공은 실제 실행 전까지 미검증이다. Python 이미지 태그·OS apt 저장소·Node 22 패치 버전과 모델 파일 자체까지 잠근 결과는 아니다.
