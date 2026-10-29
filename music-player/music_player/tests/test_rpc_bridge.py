"""RPC 桥的线缆协议测试：用真实 socket 往返验证 JSON-RPC 2.0 收发。

不依赖 tkinter / VLC，dispatch 用桩函数。验证：方法分发、参数回显、错误响应、未知方法。
"""
from __future__ import annotations

import json
import socket
import time

from music_player.engine.rpc_bridge import RpcServer


class _DummyDispatch:
    def __init__(self):
        self.calls = []

    def __call__(self, method, params):
        self.calls.append((method, params))
        if method == "echo":
            return {"got": params}
        if method == "err":
            raise ValueError("boom")
        if method == "ping":
            return {"pong": True}
        raise ValueError(f"unknown {method}")


def _wait_port(srv: RpcServer, timeout: float = 5.0) -> int:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if srv.address[1] != 0:
            return srv.address[1]
        time.sleep(0.05)
    raise RuntimeError("RPC 端口未在超时内就绪")


def _rpc_call(port: int, method: str, params: dict, req_id=1) -> dict:
    req = json.dumps({"jsonrpc": "2.0", "method": method, "params": params, "id": req_id})
    with socket.create_connection(("127.0.0.1", port), timeout=5) as sock:
        sock.sendall((req + "\n").encode("utf-8"))
        line = sock.makefile("r").readline()
    return json.loads(line)


def test_rpc_roundtrip_echo_and_errors():
    disp = _DummyDispatch()
    srv = RpcServer(disp, port=0)
    srv.start()
    try:
        port = _wait_port(srv)
        # 正常方法
        resp = _rpc_call(port, "echo", {"x": 1})
        assert resp["result"] == {"got": {"x": 1}}
        assert resp["id"] == 1
        # ping
        resp = _rpc_call(port, "ping", {}, req_id=2)
        assert resp["result"] == {"pong": True}
        # 业务错误
        resp = _rpc_call(port, "err", {}, req_id=3)
        assert "error" in resp
        assert resp["error"]["code"] == -32000
        # 未知方法
        resp = _rpc_call(port, "nope", {}, req_id=4)
        assert "error" in resp
        # dispatch 收到全部 4 次调用
        assert len(disp.calls) == 4
    finally:
        srv.stop()


def test_rpc_separate_connections():
    disp = _DummyDispatch()
    srv = RpcServer(disp, port=0)
    srv.start()
    try:
        port = _wait_port(srv)
        # 两个独立连接各发一次，验证服务可并发/复用
        assert _rpc_call(port, "ping", {}, req_id=1)["result"] == {"pong": True}
        assert _rpc_call(port, "echo", {"a": 2}, req_id=2)["result"] == {"got": {"a": 2}}
    finally:
        srv.stop()
