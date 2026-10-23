"""Regression coverage for Chrome discovery, sandbox opt-in and process errors."""

import base64
import hashlib
import socket
import struct
import threading
import unittest
import sys
from pathlib import Path
from unittest.mock import patch

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

import chrome_host


class TestBrowserDiscovery(unittest.TestCase):
    SCOPE = "host tooling with fakes"

    def test_environment_overrides_include_chrome_bin_and_edge_install(self):
        existing = {"C:/custom/chrome": True, "C:/PF/Microsoft/Edge/Application/msedge.exe": True}
        env = {"CHROME_BIN": "C:/custom/chrome", "ProgramFiles": "C:/PF"}
        exists = lambda path: existing.get(path.replace("\\", "/"), False)
        self.assertEqual(chrome_host.find_browser(env=env, which=lambda _: None, exists=exists),
                         "C:/custom/chrome")
        edge = chrome_host.find_browser(env={"ProgramFiles": "C:/PF"},
                                        which=lambda _: None, exists=exists)
        self.assertEqual(edge.replace("\\", "/"), "C:/PF/Microsoft/Edge/Application/msedge.exe")

    def test_no_sandbox_requires_explicit_truthy_opt_in(self):
        for value, expected in (("", False), ("0", False), ("false", False), ("yes", True),
                                ("ON", True)):
            with self.subTest(value=value), patch.dict("os.environ", {"DRIFTPAD_CHROME_NO_SANDBOX": value}):
                self.assertEqual(chrome_host.no_sandbox_requested(), expected)

    def test_page_runner_passes_only_explicit_sandbox_override(self):
        fake = type("CompletedProcess", (), {"returncode": 0, "stdout": '<pre id="results">{}</pre>',
                                              "stderr": ""})()
        for value, has_no_sandbox in (("0", False), ("1", True)):
            with self.subTest(value=value), \
                    patch.dict("os.environ", {"DRIFTPAD_CHROME_NO_SANDBOX": value}), \
                    patch.object(chrome_host, "require_browser", return_value="chrome"), \
                    patch.object(chrome_host.subprocess, "run", return_value=fake) as run:
                chrome_host.run_page("file:///test.html")
                self.assertEqual("--no-sandbox" in run.call_args.args[0], has_no_sandbox)

    def test_nonzero_browser_exit_fails_even_when_results_dom_exists(self):
        fake = type("CompletedProcess", (), {"returncode": 1, "stdout": '<pre id="results">{}</pre>',
                                              "stderr": "zygote fatal"})()
        with (patch.object(chrome_host, "require_browser", return_value="chrome"),
              patch.object(chrome_host.subprocess, "run", return_value=fake) as run):
            with self.assertRaisesRegex(AssertionError, "(?s)browser exited 1.*zygote fatal"):
                chrome_host.run_page("file:///test.html")


class TestDevToolsWebSocket(unittest.TestCase):
    """The minimal WebSocket client run_page_realtime() uses, against a local test server."""
    SCOPE = "host tooling with fakes"

    def _serve(self, script):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        port = listener.getsockname()[1]

        def run():
            conn, _ = listener.accept()
            with conn:
                head = b""
                while b"\r\n\r\n" not in head:
                    head += conn.recv(4096)
                key = [l.split(b": ", 1)[1] for l in head.split(b"\r\n") if l.lower().startswith(b"sec-websocket-key")][0]
                accept = base64.b64encode(hashlib.sha1(key + b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest())
                conn.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                             b"Sec-WebSocket-Accept: " + accept + b"\r\n\r\n")
                script(conn)
            listener.close()

        t = threading.Thread(target=run, daemon=True)
        t.start()
        return port, t

    @staticmethod
    def _read_client_frame(conn):
        b0, b1 = conn.recv(2)
        n = b1 & 0x7F
        if n == 126:
            n = struct.unpack(">H", conn.recv(2))[0]
        mask = conn.recv(4)
        data = b""
        while len(data) < n:
            data += conn.recv(n - len(data))
        return b0, bytes(b ^ mask[i % 4] for i, b in enumerate(data))

    def test_sends_masked_text_and_reads_short_long_and_fragmented_replies(self):
        got = []
        long_text = "x" * 300

        def script(conn):
            got.append(self._read_client_frame(conn))
            conn.sendall(bytes([0x81, 5]) + b"hello")
            conn.sendall(bytes([0x81, 126]) + struct.pack(">H", 300) + long_text.encode())
            conn.sendall(bytes([0x89, 0]))                         # ping: answered, not returned
            conn.sendall(bytes([0x01, 3]) + b"par" + bytes([0x80, 2]) + b"ts")
            got.append(self._read_client_frame(conn))               # the pong

        port, t = self._serve(script)
        ws = chrome_host._WebSocket("127.0.0.1", port, "/devtools/page/1", timeout=5)
        ws.send('{"id":1}')
        self.assertEqual(ws.recv(), "hello")
        self.assertEqual(ws.recv(), long_text)
        self.assertEqual(ws.recv(), "parts")
        ws.close()
        t.join(5)
        self.assertEqual(got[0], (0x81, b'{"id":1}'), "a final, masked text frame")
        self.assertEqual(got[1], (0x8A, b""), "ping answered with pong")

    def test_refused_upgrade_is_an_error(self):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        port = listener.getsockname()[1]

        def run():
            conn, _ = listener.accept()
            with conn:
                conn.recv(4096)
                conn.sendall(b"HTTP/1.1 403 Forbidden\r\n\r\n")
            listener.close()

        threading.Thread(target=run, daemon=True).start()
        with self.assertRaisesRegex(AssertionError, "refused"):
            chrome_host._WebSocket("127.0.0.1", port, "/", timeout=5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
