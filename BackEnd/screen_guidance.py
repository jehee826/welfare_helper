"""명시적으로 활성화한 공개 DOM 안내. 인증·이미지 수집 기능은 제공하지 않는다."""

import os

from fastapi import APIRouter, Depends, HTTPException, Request

from BackEnd.core.chat_rate import enforce_chat_rate_limit
from BackEnd.core.execution import inference_request
from BackEnd.core.settings import get_settings
from BackEnd.desktop_guidance import DomGuideRequest, RemoteDomGuideRequest, guidance_result
from BackEnd.rag.ollama import ContextBudgetError, GenerationCancelledError, GenerationTimeoutError


router = APIRouter()


def remote_screen_enabled():
    return get_settings().remote_dom_guidance_enabled and not os.getenv("VERCEL")


def require_remote_screen(request: Request):
    if not remote_screen_enabled():
        raise HTTPException(404, "screen_guidance_disabled")
    enforce_chat_rate_limit(request)


@router.post("/api/v1/screen/guide", dependencies=[Depends(require_remote_screen)])
def screen_guide(request: RemoteDomGuideRequest, transport: Request):
    settings = get_settings()
    try:
        with inference_request(transport, settings.desktop_timeout_seconds, request.timeout_seconds or 90,
                               prefix="screen_request") as budget:
            return guidance_result(DomGuideRequest(**request.model_dump()), settings, budget)
    except HTTPException:
        raise
    except GenerationTimeoutError:
        raise HTTPException(504, "screen_request_timeout") from None
    except GenerationCancelledError:
        raise HTTPException(499, "screen_request_cancelled") from None
    except ContextBudgetError:
        raise HTTPException(422, "screen_context_budget_exceeded") from None
    except Exception:
        raise HTTPException(503, "screen_generation_failed") from None
