"""Browser-test harness only: disposable DB and clock control over stdin, no test HTTP endpoints."""
import json
import sys
import tempfile
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server as app

with tempfile.TemporaryDirectory(dir='test/scratch') as folder:
    app.DB_PATH = Path(folder) / 'test.db'
    app.STATIC = Path('dist').resolve()
    clock = {'offset': 0}
    app.now = lambda: datetime.now(timezone.utc) + timedelta(seconds=clock['offset'])
    app.App.log_message = lambda *args: None
    app.fetch_chain = lambda: (None, None)
    app.init_db()
    http = app.ThreadingHTTPServer(('127.0.0.1', 0), app.App)
    worker = threading.Thread(target=http.serve_forever, daemon=True)
    worker.start()
    print(json.dumps({'port': http.server_port}), flush=True)
    try:
        for line in sys.stdin:
            command = json.loads(line)
            if command.get('quit'):
                break
            clock['offset'] += command.get('advance', 0)
            print(json.dumps({'advanced': clock['offset']}), flush=True)
    finally:
        http.shutdown(); http.server_close(); worker.join()
