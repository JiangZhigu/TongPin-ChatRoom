"""Serve only this standalone demo; no application backend or dependency install."""
import argparse
import threading
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent

class DemoHandler(SimpleHTTPRequestHandler):
    def do_HEAD(self):
        if self.path.split('?', 1)[0] not in ('/', '/index.html'):
            self.send_error(404)
            return
        super().do_HEAD()

    def do_GET(self):
        if self.path.split('?', 1)[0] not in ('/', '/index.html'):
            self.send_error(404)
            return
        super().do_GET()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=5178)
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    if not (ROOT / 'index.html').is_file():
        parser.error('Missing index.html. Build the demo first.')
    try:
        server = ThreadingHTTPServer(('127.0.0.1', args.port), partial(DemoHandler, directory=str(ROOT)))
    except OSError as error:
        parser.error(f'Cannot start demo: {error}. Choose another --port.')
    url = f'http://127.0.0.1:{server.server_port}/'
    print(f'TongPin standalone demo: {url}', flush=True)
    print('Static HTML only. No backend. Press Ctrl+C to stop.', flush=True)
    if not args.no_browser:
        threading.Timer(0.3, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

if __name__ == '__main__':
    main()
