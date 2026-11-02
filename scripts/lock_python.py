"""Python 3.12 Linux 실행 환경의 버전·배포 파일 해시를 고정한다."""

import os
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]
LOCKS = Path("requirements/locks")
CPU_INDEX = "https://download.pytorch.org/whl/cpu"


def main():
    os.chdir(ROOT)
    LOCKS.mkdir(parents=True, exist_ok=True)
    profiles = {
        "backend": ["pyproject.toml", "--extra", "reranker"],
        "worker": ["requirements-document-worker.txt", "--torch-backend", "cpu"],
        "dev": ["pyproject.toml", "--extra", "reranker", "--group", "dev",
                "--constraint", str(LOCKS / "backend-py312-linux.txt")],
        "build": ["requirements-build.in"],
    }
    # 사용자별 index·env 파일 설정을 잠금 결과에 포함하지 않는다.
    env = {key: value for key, value in os.environ.items()
           if not key.upper().startswith(("UV_", "PIP_"))}
    if "UV_CACHE_DIR" in os.environ:
        env["UV_CACHE_DIR"] = os.environ["UV_CACHE_DIR"]
    for name, inputs in profiles.items():
        output = LOCKS / f"{name}-py312-linux.txt"
        subprocess.run([
            "uv", "--no-config", "pip", "compile", *inputs,
            "--python-version", "3.12", "--python-platform", "x86_64-unknown-linux-gnu",
            "--default-index", "https://pypi.org/simple", "--emit-index-url",
            "--generate-hashes", "--custom-compile-command", "python scripts/lock_python.py",
            "--output-file", str(output),
        ], check=True, env=env)
        if name == "worker":
            # CPU 전용 resolver가 생략하는 pip 설치용 index를 명시한다.
            content = output.read_text(encoding="utf-8")
            directive = f"--extra-index-url {CPU_INDEX}\n"
            if directive not in content:
                content = directive + content
            output.write_text(content, encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
