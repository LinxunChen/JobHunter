"""Stream the existing manifest contract; never collect all historical JSON in memory."""
import hashlib
import json
import re
import sqlite3
import sys

if '--fingerprint' in sys.argv:
    digest, size = hashlib.sha256(), 0
    with open(sys.argv[1], 'rb') as source:
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            size += len(chunk)
    print(json.dumps({'bytes': size, 'sha256': digest.hexdigest()}))
    sys.exit(0)

db = sqlite3.connect(sys.argv[1])
db.row_factory = sqlite3.Row
encode = lambda value: json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
sha = lambda value: hashlib.sha256(value).hexdigest()
identifier = lambda name: '"' + name.replace('"', '""') + '"'
references = {'job_id': 'jobs', 'jobId': 'jobs', 'relatedJobId': 'jobs', 'priorJobId': 'jobs', 'announcement_id': 'announcements', 'announcementId': 'announcements', 'application_id': 'applications', 'applicationId': 'applications', 'prior_application_id': 'applications', 'priorApplicationId': 'applications', 'profileId': 'career_profiles', 'fromProfileId': 'career_profiles', 'currentVersionId': 'job_versions', 'matchId': 'matching_results'}
path_fields = re.compile(r'\.(?:"(?:\\.|[^"\\])*"|[^.\[\]"]+)')
external_fields = {'.raw', '.requestParameters', '."raw"', '."requestParameters"'}

def canonical(value):
    if isinstance(value, int):
        return {'integer': str(value)}
    if isinstance(value, bytes):
        return {'bytes': len(value), 'sha256': sha(value)}
    return value

def quote_chunk(chunk):
    chunk = chunk.replace(b'\\', b'\\\\').replace(b'"', b'\\"')
    for number in range(32):
        if bytes([number]) in chunk:
            escaped = {8: b'\\b', 9: b'\\t', 10: b'\\n', 12: b'\\f', 13: b'\\r'}.get(number, ('\\u%04x' % number).encode())
            chunk = chunk.replace(bytes([number]), escaped)
    return chunk

try:
    if any(row[0] != 'ok' for row in db.execute('PRAGMA integrity_check')) or list(db.execute('PRAGMA foreign_key_check')):
        raise ValueError('SQLite结构或外键校验失败')
    schema = [dict(row) for row in db.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")]
    table_names = [item['name'] for item in schema if item['type'] == 'table']
    columns = {name: [row['name'] for row in db.execute('PRAGMA table_info(' + identifier(name) + ')')] for name in table_names}
    present = {name: set(row[0] for row in db.execute('SELECT id FROM ' + identifier(name))) for name in table_names if 'id' in columns[name]}
    def check(key, value):
        if value is not None and key in references and value not in present.get(references[key], set()):
            raise ValueError('业务关联缺失')
    tables = {}
    for name in table_names:
        digest, count = hashlib.sha256(), 0
        digest.update(b'[')
        metadata_columns = [column for column in columns[name] if column != 'body']
        select = ','.join(identifier(column) for column in metadata_columns)
        for row in db.execute('SELECT rowid' + (',' + select if select else '') + ' FROM ' + identifier(name) + ' ORDER BY rowid'):
            ordinal = row[0]
            metadata = {column: row[index + 1] for index, column in enumerate(metadata_columns)}
            if count:
                digest.update(b',')
            digest.update(b'{')
            for index, column in enumerate(columns[name]):
                if index:
                    digest.update(b',')
                digest.update(encode(column) + b':')
                if column == 'body':
                    digest.update(b'"')
                    if hasattr(db, 'blobopen'):
                        with db.blobopen(name, column, ordinal, readonly=True) as value:
                            while True:
                                chunk = value.read(1024 * 1024)
                                if not chunk:
                                    break
                                digest.update(quote_chunk(chunk))
                    else:
                        # Older existing Python remains usable for small test/restore databases.
                        size = db.execute('SELECT length(CAST(body AS BLOB)) FROM ' + identifier(name) + ' WHERE rowid=?', (ordinal,)).fetchone()[0]
                        if size > 16 * 1024 * 1024:
                            raise ValueError('大库流式校验需要现有Python支持blobopen')
                        value = db.execute('SELECT body FROM ' + identifier(name) + ' WHERE rowid=?', (ordinal,)).fetchone()[0]
                        digest.update(quote_chunk(value.encode('utf-8')))
                    digest.update(b'"')
                else:
                    check(column, metadata[column])
                    digest.update(encode(canonical(metadata[column])))
            digest.update(b'}')
            count += 1
            if 'body' in columns[name]:
                job_arrays = set()
                keys = ','.join("'" + key + "'" for key in [*references, 'jobIds'])
                sql = 'SELECT key,atom,type,parent,id,fullkey FROM json_tree((SELECT body FROM ' + identifier(name) + ' WHERE rowid=?)) WHERE key IN (' + keys + ") OR typeof(key)='integer'"
                for item in db.execute(sql, (ordinal,)):
                    # raw/requestParameters are verbatim provider payloads. Their
                    # IDs belong to the provider, even when named job_id/jobIds.
                    # The entire payload is still included in the content hash.
                    if any(field.group(0) in external_fields for field in path_fields.finditer(item['fullkey'])):
                        continue
                    if item['key'] == 'jobIds' and item['type'] == 'array':
                        job_arrays.add(item['id'])
                    elif item['key'] in references:
                        if item['type'] in ('object', 'array'):
                            raise ValueError('业务关联缺失')
                        check(item['key'], item['atom'])
                    elif item['parent'] in job_arrays:
                        check('jobId', item['atom'])
        digest.update(b']')
        tables[name] = {'count': count, 'sha256': digest.hexdigest()}
    attachments = []
    if 'announcements' in table_names:
        for row in db.execute("SELECT a.id AS announcementId,json_extract(f.value,'$.id') AS attachmentId,json_extract(f.value,'$.sha256') AS digest FROM announcements a,json_each(a.body,'$.attachments') f WHERE json_extract(f.value,'$.sha256') IS NOT NULL"):
            stored = db.execute('SELECT content FROM announcement_attachments WHERE announcement_id=? AND id=?', (row['announcementId'], row['attachmentId'])).fetchone()
            if not stored or sha(stored[0]) != row['digest']:
                raise ValueError('已取得附件缺失或SHA不符')
            attachments.append({'announcementId': row['announcementId'], 'id': row['attachmentId'], 'bytes': len(stored[0]), 'sha256': row['digest'], 'storage': 'sqlite-blob'})
    print(json.dumps({'schemaHash': sha(encode(schema)), 'tables': tables, 'attachments': attachments, 'integrity': 'ok', 'foreignKeys': 'ok'}, ensure_ascii=False))
finally:
    db.close()
