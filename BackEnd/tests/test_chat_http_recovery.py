import asyncio
import json
import socket
import threading
import time
from types import SimpleNamespace

import httpx
import pytest
import uvicorn

from BackEnd.core import chat_rate, execution
from BackEnd.core.settings import Settings


@pytest.fixture
def server(monkeypatch):
    from BackEnd import main
    from BackEnd.admin import session

    settings=Settings(_env_file=None, ollama_timeout=4)
    monkeypatch.setattr(main,'get_settings',lambda:settings)
    monkeypatch.setattr(chat_rate,'get_settings',lambda:settings)
    monkeypatch.setattr(session,'get_settings',lambda:settings)
    rate_clock=[100.0]
    limiter=chat_rate.ChatRateLimiter(clock=lambda:rate_clock[0])
    monkeypatch.setattr(chat_rate,'chat_rate_limiter',limiter)
    entered,release,cancelled,all_entered=(threading.Event() for _ in range(4))
    calls=[]; factory=[]; forbidden=[]; loops=[]; statuses={}; completed={}; records_lock=threading.Lock()
    def unexpected(*args,**kwargs):
        forbidden.append('external')
        raise AssertionError('실제 DB·모델·검색 진입 금지')
    for name in ('connect','PgServiceRepository','build_chat_service','LocalReranker'):
        monkeypatch.setattr(main,name,unexpected)
    monkeypatch.setattr('BackEnd.rag.factory.OllamaClient',unexpected)
    monkeypatch.setattr('BackEnd.rag.factory.cached_reranker',unexpected)
    def service():
        factory.append('factory')
        return SimpleNamespace(repo=object())
    monkeypatch.setitem(main.app.dependency_overrides,main.get_chat_service,service)
    def qa(_repo,_service,question,**_options):
        calls.append(question)
        if question=='대기':
            budget=execution.current_budget();entered.set()
            if calls.count('대기')==3:all_entered.set()
            while not release.wait(.01):
                if budget.cancelled.is_set(): cancelled.set()
            execution.checkpoint()
        return {'kind':'fallback','text':'합성 결과','contacts':[],'suggestions':[]},{}
    monkeypatch.setattr(main,'answer_document',qa)
    async def observed(scope,receive,send):
        loops[:] = [asyncio.get_running_loop()]
        peer_port=scope['client'][1]
        with records_lock:
            statuses[peer_port]=[]
            completed[peer_port]=threading.Event()
        async def record(message):
            if message['type']=='http.response.start':
                with records_lock:statuses[peer_port].append(message['status'])
            await send(message)
        try:
            await main.app(scope,receive,record)
        finally:
            completed[peer_port].set()
    listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen(32)
    port=listener.getsockname()[1]
    app=uvicorn.Server(uvicorn.Config(observed,log_level='critical',lifespan='off'))
    thread=threading.Thread(target=app.run,kwargs={'sockets':[listener]},daemon=True);thread.start()
    try:
        deadline=time.monotonic()+4
        while not app.started and time.monotonic()<deadline:time.sleep(.01)
        assert app.started
        yield SimpleNamespace(port=port,entered=entered,all_entered=all_entered,release=release,cancelled=cancelled,
                              calls=calls,factory=factory,settings=settings,limiter=limiter,loops=loops,
                              rate_clock=rate_clock,statuses=statuses,completed=completed,forbidden=forbidden)
    finally:
        release.set();app.should_exit=True;thread.join(5);listener.close()
        assert not thread.is_alive()
        with socket.socket() as probe:
            probe.settimeout(1)
            assert probe.connect_ex(('127.0.0.1',port))!=0
        assert forbidden == []


def post(server,body):
    return httpx.post(f'http://127.0.0.1:{server.port}/api/v1/chat',json=body,
                      headers={'Origin':'http://localhost:5173'},timeout=4,trust_env=False)


def assert_safe(response,code):
    assert response.status_code == (504 if code=='request_timeout' else 429)
    assert response.json()=={'detail':code}
    assert response.headers['cache-control']=='no-store'
    assert response.headers['access-control-allow-origin']=='http://localhost:5173'
    assert '대기' not in response.text


def assert_no_disconnect_watcher(server):
    async def count():
        return sum(task.get_name()=='inference-disconnect' for task in asyncio.all_tasks())
    deadline=time.monotonic()+3
    while time.monotonic()<deadline:
        if asyncio.run_coroutine_threadsafe(count(),server.loops[0]).result(1)==0:return
        time.sleep(.02)
    pytest.fail('disconnect watcher가 정리되지 않았습니다')


def assert_available_slots(expected):
    acquired=0
    try:
        while execution.inference_gate.acquire(blocking=False):acquired+=1
        assert acquired==expected
    finally:
        for _ in range(acquired):execution.inference_gate.release()


def test_tcp_disconnect_gate_busy_rate_and_manual_recovery(server,monkeypatch):
    server.settings.chat_rate_limit_per_minute=4
    data=json.dumps({'query':'대기'}).encode()
    sockets=[socket.create_connection(('127.0.0.1',server.port),timeout=2) for _ in range(3)]
    sock=sockets[0]
    first_port=sock.getsockname()[1]
    try:
        for active in sockets:
            active.sendall(b'POST /api/v1/chat HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: '+str(len(data)).encode()+b'\r\n\r\n'+data)
        assert server.all_entered.wait(3)
        busy=post(server,{'query':'다음 질문'});assert_safe(busy,'inference_busy')
        assert busy.headers['retry-after']=='1'
        sock.close();assert server.cancelled.wait(3)
        before=(len(server.factory),len(server.calls))
        limited=post(server,{'query':'다음 질문'});assert_safe(limited,'chat_rate_limited')
        assert 1<=int(limited.headers['retry-after'])<=60
        assert (len(server.factory),len(server.calls))==before
        assert server.forbidden == []
        assert_available_slots(0)
    finally:
        for active in sockets:active.close()
        server.release.set()
    deadline=time.monotonic()+3
    while time.monotonic()<deadline:
        if execution.inference_gate.acquire(blocking=False):execution.inference_gate.release();break
        time.sleep(.01)
    else:pytest.fail('native 종료 후 gate가 해제되지 않았습니다')
    assert server.completed[first_port].wait(3)
    assert 200 not in server.statuses[first_port]
    server.rate_clock[0]+=60
    assert post(server,{'query':'수동 복구'}).status_code==200
    assert_no_disconnect_watcher(server)


def test_tcp_short_deadline_and_manual_recovery(server):
    responses=[]
    thread=threading.Thread(target=lambda:responses.append(post(server,{'query':'대기','timeout_seconds':1})),daemon=True)
    thread.start()
    try:
        assert server.entered.wait(3)
        time.sleep(1.15)
        assert_available_slots(2)
    finally:
        server.release.set();thread.join(4)
    assert not thread.is_alive() and len(responses)==1
    assert_safe(responses[0],'request_timeout')
    assert post(server,{'query':'수동 복구'}).status_code==200
    assert_no_disconnect_watcher(server)
