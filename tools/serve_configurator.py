#!/usr/bin/env python3
"""
serve_configurator.py - Serve configurator/ on http://127.0.0.1:<port> for local use.

The configurator also works straight from the file system (open configurator/index.html); a local
server is only needed by tools that cannot load a page's relative scripts from file:// (such as some
embedded browsers). Nothing is fetched from the internet; responses are marked no-store so an edited
file is always reloaded.

Usage (from the repository root):
    python tools/serve_configurator.py [port]        (default 8791)
Then open http://127.0.0.1:8791/index.html (add ?simulate=1 to try it without a DriftPad).
"""

import functools
import http.server
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "configurator"


class NoStoreHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8791
    handler = functools.partial(NoStoreHandler, directory=str(ROOT))
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"Serving {ROOT} on http://127.0.0.1:{port}/index.html")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
