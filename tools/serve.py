# -*- coding: utf-8 -*-
"""
Petit serveur de developpement pour le configurateur.

    python tools/serve.py [port]

Identique a `python -m http.server`, avec deux differences utiles :
  * en-tetes anti-cache : les modules JS modifies sont repris
    immediatement, sans rechargement force du navigateur ;
  * type MIME correct pour .json et .js.

Pour la mise en ligne, n'importe quel hebergeur statique convient.
"""

import os
import sys
from functools import partial

try:
    from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
except ImportError:                       # Python 2
    print("Python 3 requis.")
    sys.exit(1)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(SimpleHTTPRequestHandler):
    extensions_map = dict(SimpleHTTPRequestHandler.extensions_map)
    extensions_map.update({
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
        ".css": "text/css",
    })

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        SimpleHTTPRequestHandler.end_headers(self)

    def send_response(self, *args, **kw):
        SimpleHTTPRequestHandler.send_response(self, *args, **kw)

    def log_message(self, fmt, *args):
        if "404" in (fmt % args):
            sys.stderr.write("%s\n" % (fmt % args))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5180
    server = ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, directory=ROOT))
    print("Configurateur 3D  ->  http://localhost:%d" % port)
    print("Dossier servi : %s" % ROOT)
    print("Ctrl+C pour arreter.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nArret.")


if __name__ == "__main__":
    main()
