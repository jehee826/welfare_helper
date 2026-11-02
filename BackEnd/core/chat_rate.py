"""공개 상담의 프로세스 내 IP별 요청 수를 최근60초 기준으로 제한한다."""

from collections import OrderedDict, deque
from math import ceil
from threading import Lock
from time import monotonic

from fastapi import HTTPException, Request

from BackEnd.admin.session import login_client_key
from BackEnd.core.settings import get_settings


class ChatRateLimiter:
    def __init__(self, *, capacity=4096, clock=monotonic):
        self.capacity = capacity
        self.clock = clock
        self.windows = OrderedDict()
        self.lock = Lock()

    def admit(self, key: str, limit: int) -> int | None:
        with self.lock:
            now = self.clock()
            cutoff = now - 60
            # 마지막 허용 시각 순서이므로 만료된 키만 앞에서 정리한다.
            while self.windows and next(iter(self.windows.values()))[-1] <= cutoff:
                self.windows.popitem(last=False)
            window = self.windows.get(key)
            if window is None:
                if len(self.windows) >= self.capacity:
                    oldest = next(iter(self.windows.values()))[-1]
                    return max(1, min(60, ceil(oldest + 60 - now)))
                window = self.windows[key] = deque()
            while window and window[0] <= cutoff:
                window.popleft()
            if len(window) >= limit:
                return max(1, min(60, ceil(window[0] + 60 - now)))
            window.append(now)
            self.windows.move_to_end(key)
            return None


chat_rate_limiter = ChatRateLimiter()


def enforce_chat_rate_limit(request: Request) -> None:
    retry = chat_rate_limiter.admit(login_client_key(request), get_settings().chat_rate_limit_per_minute)
    if retry is not None:
        raise HTTPException(429, "chat_rate_limited", headers={"Retry-After": str(retry)})
