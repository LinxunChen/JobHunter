"""Explicit original-record download, in a separate process with bounded buffers."""
import sqlite3
import sys

path, kind, identifier = sys.argv[1:]
allowed = {'source_checks', 'source_health_checks', 'scheduled_runs', 'career_refreshes', 'matching_results', 'announcements', 'source_check_tasks', 'notification_attempts', 'notification_deliveries', 'job_transitions', 'recruitment_observations'}
if kind not in allowed:
    raise ValueError('历史类型无效')
db = sqlite3.connect('file:' + path + '?mode=ro', uri=True)
try:
    row = db.execute('SELECT rowid FROM ' + kind + ' WHERE id=?', (identifier,)).fetchone()
    if not row:
        raise ValueError('历史记录不存在')
    if hasattr(db, 'blobopen'):
        with db.blobopen(kind, 'body', row[0], readonly=True) as value:
            while True:
                chunk = value.read(1024 * 1024)
                if not chunk:
                    break
                sys.stdout.buffer.write(chunk)
    else:
        # Compatibility with existing older Python on small databases; no JSON parsing.
        size = db.execute('SELECT length(CAST(body AS BLOB)) FROM ' + kind + ' WHERE id=?', (identifier,)).fetchone()[0]
        if size > 16 * 1024 * 1024:
            raise ValueError('大历史下载需要现有Python支持blobopen')
        sys.stdout.buffer.write(db.execute('SELECT CAST(body AS BLOB) FROM ' + kind + ' WHERE id=?', (identifier,)).fetchone()[0])
except BrokenPipeError:
    pass
finally:
    db.close()
