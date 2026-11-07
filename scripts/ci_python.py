"""실제 환경파일·DB·모델 없이 실행할 CI 범위를 고정한다."""

import argparse
import importlib
from importlib.metadata import distributions, version
import os
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("imports", "tests"))
    parser.add_argument("--profile", choices=("backend", "worker", "dev"), default="dev")
    args = parser.parse_args()
    if sys.version_info[:2] != (3, 12):
        raise SystemExit("Python 3.12가 필요합니다.")
    os.chdir(ROOT)
    from BackEnd.core.settings import Settings

    setting_names = {name.casefold() for name in Settings.model_fields}
    for key in tuple(os.environ):
        if key.casefold() in setting_names:
            os.environ.pop(key)
    Settings.model_config["env_file"] = None
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"

    if args.operation == "imports":
        for name in ("BackEnd.main", "BackEnd.documents.analysis", "BackEnd.documents.indexing"):
            importlib.import_module(name)
        if args.profile == "worker":
            import torch
            import torchvision
            importlib.import_module("docling.document_converter")
            assert version("docling-slim") == "2.141.0"
            assert torch.__version__ == "2.10.0+cpu" and torchvision.__version__ == "0.25.0+cpu"
            assert torch.version.cuda is None
            assert not any((item.metadata["Name"] or "").lower().startswith("nvidia-") for item in distributions())
        else:
            importlib.import_module("onnxruntime")
            importlib.import_module("tokenizers")
        print(f"{args.profile}: import 확인 완료, 모델 초기화 없음")
        return

    import pytest
    files = [
        "test_api.py", "test_settings.py", "test_chat_rate_limit.py", "test_request_execution.py",
        "test_documents.py", "test_document_automatic_pipeline.py", "test_document_replacement_boundaries.py",
        "test_document_privacy.py", "test_chat_http_recovery.py",
        "test_remote_screen.py", "test_remote_screen_tcp.py", "test_qa_diagnostics.py",
        "test_welfare_qa.py", "test_conversation_context.py", "test_document_qa.py",
        "test_admin_password_rotation.py", "test_admin_auth_runtime.py", "test_admin_peer_limit.py",
        "test_admin_referrals.py", "test_admin_referrals_db.py",
        "test_admin_programs.py", "test_document_bm25_cache.py", "test_document_rag_diagnostics.py",
    ]
    raise SystemExit(pytest.main(["-q", *["BackEnd/tests/" + name for name in files]]))


if __name__ == "__main__":
    main()
