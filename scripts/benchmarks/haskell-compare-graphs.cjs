#!/usr/bin/env node
// Exact semantic row comparison of two completed or explicitly partial indexes.
// node haskell-compare-graphs.cjs BASE_DB CANDIDATE_DB NEW_OUTPUT.json
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const [before, after, output] = process.argv.slice(2);
if (!before || !after || !output) throw new Error('Expected BASE_DB CANDIDATE_DB NEW_OUTPUT.json');
const db = new DatabaseSync(before, { readOnly: true });
try {
  db.prepare('ATTACH DATABASE ? AS candidate').run(after);
  db.exec('PRAGMA query_only=ON');
  const columns = db.prepare('PRAGMA table_info(nodes)').all().map(row => row.name)
    .filter(name => name !== 'updated_at');
  const quote = name => '"' + name.replaceAll('"', '""') + '"';
  const report = { before, after, projections: {}, databases: {} };
  for (const schema of ['main', 'candidate']) {
    report.databases[schema] = {
      integrity: db.prepare(`PRAGMA ${schema}.integrity_check`).all(),
      foreignKeys: db.prepare(`PRAGMA ${schema}.foreign_key_check`).all(),
      pageCount: db.prepare(`PRAGMA ${schema}.page_count`).get(),
      freePages: db.prepare(`PRAGMA ${schema}.freelist_count`).get(),
      state: db.prepare(`SELECT value FROM ${schema}.project_metadata WHERE key='index_state'`).get(),
    };
  }
  for (const [table, names] of [['nodes', columns], ['edges', ['source','target','kind','line','col','metadata','provenance']]]) {
    const projection = names.map(quote).join(',');
    const query = schema => `SELECT ${projection} FROM ${schema}.${table}`;
    const removed = `${query('main')} EXCEPT ${query('candidate')}`;
    const added = `${query('candidate')} EXCEPT ${query('main')}`;
    report.projections[table] = {
      before: db.prepare(`SELECT count(*) n FROM main.${table}`).get().n,
      after: db.prepare(`SELECT count(*) n FROM candidate.${table}`).get().n,
      removed: db.prepare(`SELECT count(*) n FROM (${removed})`).get().n,
      added: db.prepare(`SELECT count(*) n FROM (${added})`).get().n,
      removedExamples: db.prepare(`${removed} LIMIT 40`).all(),
      addedExamples: db.prepare(`${added} LIMIT 40`).all(),
    };
  }
  fs.writeFileSync(output, JSON.stringify(report, null, 2)+'\n', { flag:'wx' });
  console.log(JSON.stringify(Object.fromEntries(Object.entries(report.projections).map(([k,v])=>[k,{
    before:v.before,after:v.after,removed:v.removed,added:v.added,
  }]))));
} finally { db.close(); }
