// Durable invalidation is written in the same SQLite transaction as the fact.
// Heartbeats and locks are intentionally not business changes. These identifiers
// are internal schema definitions, never request input.
const identifier=value=>{if(!/^[a-z][a-z0-9_]*$/.test(value))throw Error('Invalid tracking identifier');return value;};
export function createChangeRevision(db,name,tables) {
 identifier(name);
 db.exec('CREATE TABLE IF NOT EXISTS change_revisions(name TEXT PRIMARY KEY,revision INTEGER NOT NULL)');
 db.prepare('INSERT OR IGNORE INTO change_revisions VALUES(?,0)').run(name);
 for(const table of tables){identifier(table);
  for(const action of ['INSERT','UPDATE','DELETE'])db.exec(`CREATE TRIGGER IF NOT EXISTS revision_${name}_${table}_${action} AFTER ${action}${action==='UPDATE'?' OF body':''} ON ${table} ${action==='UPDATE'?'WHEN NEW.body IS NOT OLD.body':''} BEGIN UPDATE change_revisions SET revision=revision+1 WHERE name='${name}'; END`);
 }
 return ()=>name+':'+db.prepare('SELECT revision FROM change_revisions WHERE name=?').get(name).revision;
}

export function createDirtyQueue(db,{name,table,version}) {
 identifier(name);identifier(table);identifier(version);
 const queue=name+'_queue',state=name+'_state';
 const enqueue=id=>`INSERT INTO ${queue} VALUES(${id},lower(hex(randomblob(16)))) ON CONFLICT(id) DO UPDATE SET token=excluded.token`;
 db.exec(`CREATE TABLE IF NOT EXISTS ${queue}(id TEXT PRIMARY KEY,token TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS ${state}(version TEXT PRIMARY KEY);
  CREATE TRIGGER IF NOT EXISTS ${name}_insert AFTER INSERT ON ${table} BEGIN ${enqueue('NEW.id')}; END;
  CREATE TRIGGER IF NOT EXISTS ${name}_update AFTER UPDATE OF body ON ${table} WHEN NEW.body IS NOT OLD.body BEGIN ${enqueue('NEW.id')}; END;
  CREATE TRIGGER IF NOT EXISTS ${name}_delete AFTER DELETE ON ${table} BEGIN DELETE FROM ${queue} WHERE id=OLD.id; END;`);
 db.exec(`SAVEPOINT ${name}_init`);
 try {
  if(!db.prepare(`SELECT version FROM ${state} WHERE version=?`).get(version)){
   db.exec(`INSERT INTO ${queue} SELECT id,lower(hex(randomblob(16))) FROM ${table} WHERE true ON CONFLICT(id) DO UPDATE SET token=excluded.token`);
   db.prepare(`INSERT INTO ${state} VALUES(?)`).run(version);
  }
  db.exec(`RELEASE ${name}_init`);
 }catch(error){db.exec(`ROLLBACK TO ${name}_init; RELEASE ${name}_init`);throw error;}
 return {table:queue,enqueueSql:enqueue,
  get:id=>db.prepare(`SELECT id,token FROM ${queue} WHERE id=?`).get(id),
  acknowledge:item=>{if(item)db.prepare(`DELETE FROM ${queue} WHERE id=? AND token=?`).run(item.id,item.token);},
 };
}
