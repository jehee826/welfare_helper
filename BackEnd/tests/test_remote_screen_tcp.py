import json
import socket
import threading
import time

import httpx

from BackEnd import desktop_guidance as guide, screen_guidance as screen
from BackEnd.core import execution
from BackEnd.tests.test_chat_http_recovery import server, assert_no_disconnect_watcher, assert_available_slots  # noqa: F401


def prepare(server, monkeypatch):
    server.settings.remote_dom_guidance_enabled=True
    monkeypatch.setattr(screen,'get_settings',lambda:server.settings)
    monkeypatch.setattr(guide,'OllamaClient',lambda *a,**k:object())
    def work(*_):
        budget=execution.current_budget();server.entered.set()
        while not server.release.wait(.01):
            if budget.cancelled.is_set():server.cancelled.set()
        execution.checkpoint()
        return guide.GuideAnswer(kind='설명',answer='공개 화면',targets=[])
    monkeypatch.setattr(guide,'generate_step',work)


def body():
    return {'source':'dom','snapshot_id':'F'*20,'question':'공개 화면 설명','candidates':[],
            'screen_context':[{'kind':'heading','text':'공개 안내'}]}


def test_remote_tcp_body_limit_exact_bytes_before_quota(server,monkeypatch):
    prepare(server,monkeypatch)
    server.settings.chat_rate_limit_per_minute=1
    data=json.dumps(body(),ensure_ascii=False).encode('utf-8')
    url=f'http://127.0.0.1:{server.port}/api/v1/screen/guide'
    headers={'Content-Type':'application/json'}
    oversized=httpx.post(url,content=b' '*(65537-len(data))+data,headers=headers,timeout=4,trust_env=False)
    assert oversized.status_code==413
    assert oversized.headers['cache-control']=='no-store'
    assert not server.entered.is_set()
    server.release.set()
    exact=httpx.post(url,content=b' '*(65536-len(data))+data,headers=headers,timeout=4,trust_env=False)
    assert exact.status_code==200
    assert server.entered.is_set()
    assert not server.forbidden
    assert_no_disconnect_watcher(server)


def test_remote_tcp_disconnect_cancels_and_preserves_gate_until_native_exit(server,monkeypatch):
    prepare(server,monkeypatch)
    encoded=json.dumps(body()).encode();sock=socket.create_connection(('127.0.0.1',server.port),timeout=2)
    first_port=sock.getsockname()[1]
    try:
        sock.sendall(b'POST /api/v1/screen/guide HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: '+str(len(encoded)).encode()+b'\r\n\r\n'+encoded)
        assert server.entered.wait(3)
        sock.close();assert server.cancelled.wait(3)
        assert_available_slots(2)
    finally:sock.close();server.release.set()
    assert server.completed[first_port].wait(3)
    assert 200 not in server.statuses[first_port]
    assert_no_disconnect_watcher(server)


def test_remote_tcp_short_deadline_returns_safe_504(server,monkeypatch):
    prepare(server,monkeypatch);results=[]
    def send():
        results.append(httpx.post(f'http://127.0.0.1:{server.port}/api/v1/screen/guide',json={**body(),'timeout_seconds':1},timeout=4,trust_env=False))
    thread=threading.Thread(target=send,daemon=True);thread.start()
    try:
        assert server.entered.wait(3)
        time.sleep(1.15)
    finally:server.release.set();thread.join(4)
    assert not thread.is_alive() and results[0].status_code==504
    assert results[0].json()=={'detail':'screen_request_timeout'}
    assert results[0].headers['cache-control']=='no-store'
    assert_no_disconnect_watcher(server)
