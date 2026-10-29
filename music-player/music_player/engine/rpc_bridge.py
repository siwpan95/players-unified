"""无头 JSON-RPC 控制桥（标准库 asyncio，无第三方依赖）。

允许外部进程通过本地 TCP 发送 JSON-RPC 2.0 请求来控制播放器，与 UI 完全解耦：
调用方只提供一个 `dispatch(method, params) -> result` 回调，真正的命令在 UI 主线程执行
（避免跨线程操作 VLC / tkinter）。

协议（每行一个 JSON 请求，响应同样每行一个 JSON）：
  --> {"jsonrpc":"2.0","method":"play","params":{},"id":1}
  <-- {"jsonrpc":"2.0","result":{...},"id":1}
  <-- {"jsonrpc":"2.0","error":{"code":-32000,"message":"..."},"id":1}

可用方法见 ui/app_window.py 的 `_rpc_execute`（play/pause/resume/stop/next/prev/
play_index/seek/volume/mute/set_mode/equalizer/add_files/status/playlist/ping）。
"""
from __future__ import annotations

import asyncio
import json
import logging
import threading
from typing import Callable, Optional

logger = logging.getLogger("music_player.rpc")

DispatchFn = Callable[[str, dict], object]


class RpcServer:
    def __init__(self, dispatch: DispatchFn, host: str = "127.0.0.1", port: int = 7700) -> None:
        self._dispatch = dispatch
        self._host = host
        self._port = port
        self._server: Optional[asyncio.AbstractServer] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                try:
                    req = json.loads(line.decode("utf-8"))
                    if not isinstance(req, dict):
                        raise ValueError("请求不是 JSON 对象")
                except Exception as e:  # noqa: BLE001
                    resp = {"jsonrpc": "2.0", "error": {"code": -32700, "message": f"parse error: {e}"}}
                    writer.write((json.dumps(resp) + "\n").encode("utf-8"))
                    await writer.drain()
                    continue

                method = req.get("method")
                params = req.get("params") or {}
                req_id = req.get("id")
                if not isinstance(params, dict):
                    params = {}

                try:
                    result = self._dispatch(method, params)
                    resp = {"jsonrpc": "2.0", "result": result, "id": req_id}
                except Exception as e:  # noqa: BLE001
                    resp = {"jsonrpc": "2.0",
                            "error": {"code": -32000, "message": str(e)},
                            "id": req_id}
                writer.write((json.dumps(resp) + "\n").encode("utf-8"))
                await writer.drain()
        except asyncio.CancelledError:
            pass
        finally:
            try:
                writer.close()
            except Exception:
                pass

    async def _serve(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._server = await asyncio.start_server(self._handle, self._host, self._port)
        # port=0 时记录系统分配的实际端口
        if self._port == 0:
            self._port = self._server.sockets[0].getsockname()[1]
        logger.info("RPC 控制监听于 %s:%d", self._host, self._port)
        async with self._server:
            await self._server.serve_forever()

    def start(self) -> None:
        """在独立 daemon 线程中启动事件循环。"""
        if self._thread is not None and self._thread.is_alive():
            return

        def _run() -> None:
            try:
                asyncio.run(self._serve())
            except asyncio.CancelledError:
                # 正常关闭：serve_forever 被 stop() 取消
                pass
            except Exception:  # noqa: BLE001
                logger.exception("RPC 服务异常退出")

        self._thread = threading.Thread(target=_run, daemon=True, name="rpc-bridge")
        self._thread.start()

    def stop(self) -> None:
        """关闭监听（不阻塞，daemon 线程随之退出）。"""
        if self._server is not None and self._loop is not None:
            try:
                self._loop.call_soon_threadsafe(self._server.close)
            except Exception:
                pass
        self._server = None
        self._loop = None

    @property
    def address(self) -> tuple[str, int]:
        return (self._host, self._port)


__all__ = ["RpcServer", "DispatchFn"]
