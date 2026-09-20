#!/usr/bin/env node
// READ ONLY. Run only after the complete timed matrix has stopped.
// Pass disposable coherent DB+WAL copies: readOnly SQLite may create sidecars.
// node scripts/benchmarks/haskell-classify-graph-deltas.cjs CORPUS BEFORE_DB AFTER_DB NEW_PUBLIC.json
// This supplements, rather than replaces, haskell-compare-graphs.cjs integrity
// and page/freelist checks. It never reads corpus source or invokes CodeGraph.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const crypto = require('node:crypto');
const [corpus, beforePath, afterPath, output] = process.argv.slice(2);
if (!['xmonad', 'pandoc', 'hls', 'express', 'ghc-core', 'ghc'].includes(corpus)
    || !beforePath || !afterPath || !output) {
  throw new Error('Usage: node scripts/benchmarks/haskell-classify-graph-deltas.cjs CORPUS BEFORE_DB AFTER_DB NEW_PUBLIC.json');
}
if (fs.existsSync(output)) throw new Error('Refusing to replace an existing report');
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const stable = value => JSON.stringify(canonical(value));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical(value[key])]),
  );
  return value;
}
function parse(value) {
  if (value === null || value === undefined) return null;
  try { return JSON.parse(value); } catch { return { invalidJsonSha256: hash(value) }; }
}
function textHash(value) {
  return value === null || value === undefined ? null : { sha256: hash(value), chars: String(value).length };
}
function safeRelative(value) {
  if (typeof value !== 'string' || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
      || value.includes('://') || value.split(/[\\/]/).includes('..')) return null;
  return value;
}
function safeName(value) {
  // Names and relative qualified names are public corpus identity, not bodies.
  return typeof value === 'string' && value.length <= 500 && !/[\r\n]/.test(value)
    && !/(?:\/Users\/|\/home\/|\/tmp\/|file:\/\/|[A-Za-z]:\\)/.test(value)
    && !/^\/[A-Za-z0-9_.-]+\//.test(value)
    ? value : textHash(value);
}
const visibleMetadata = new Set([
  'confidence', 'resolvedBy', 'synthesizedBy', 'haskellImportDependent',
  'via', 'refName', 'refKind', 'registeredAt', 'valueRef',
]);
function metadata(value) {
  const parsed = parse(value);
  if (parsed === null) return null;
  const fields = {};
  for (const [key, item] of Object.entries(parsed)) {
    // Keep exact comparison hashes for every field, but don't publish source
    // conditions, signatures, arbitrary nested objects or refCandidates text.
    const safeKey = safeName(key);
    const publicKey = typeof safeKey === 'string' ? safeKey : `redacted-${hash(key)}`;
    fields[publicKey] = visibleMetadata.has(key)
      && (item === null || ['number', 'boolean'].includes(typeof item))
      ? item
      : visibleMetadata.has(key) && typeof item === 'string'
        ? (key === 'registeredAt' ? safeRelative(item) ?? textHash(item) : safeName(item))
        : { sha256: hash(stable(item)), serializedChars: stable(item).length };
  }
  return { rawSha256: hash(value), semanticSha256: hash(stable(parsed)), fields };
}
function fieldDiff(before, after, keys, project = value => value) {
  return Object.fromEntries(keys.filter(key => before[key] !== after[key]).map(key =>
    [key, { before: project(before[key], key), after: project(after[key], key) }],
  ));
}
function nodeIdentity(node) {
  if (!node) return null;
  return { id: safeName(node.id), name: safeName(node.name),
    qualifiedName: safeName(node.qualified_name), file: safeRelative(node.file_path),
    kind: safeName(node.kind), language: safeName(node.language),
    startLine: node.start_line, endLine: node.end_line,
    startColumn: node.start_column, endColumn: node.end_column };
}
function nodeField(value, key) {
  if (key === 'docstring' || key === 'signature' || key === 'type_parameters' || key === 'return_type') return textHash(value);
  if (key === 'file_path') return safeRelative(value) ?? textHash(value);
  if (key === 'decorators') {
    const entries = parse(value);
    return Array.isArray(entries) ? entries.map(entry =>
      typeof entry === 'string' && /^haskell-[\w-]+(?::[\w.:'-]+)*$/.test(entry)
        ? entry : textHash(stable(entry))) : textHash(value);
  }
  return typeof value === 'string' ? safeName(value) : value;
}
function countBy(entries, keyOf) {
  const result = {};
  for (const entry of entries) {
    const key = keyOf(entry);
    result[key] = (result[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}
const edgeColumns = ['source', 'target', 'kind', 'line', 'col', 'metadata', 'provenance'];
const edgeKey = edge => JSON.stringify([edge.source, edge.target, edge.kind, edge.line ?? -1, edge.col ?? -1]);
const siteKey = edge => JSON.stringify([edge.source, edge.line ?? -1, edge.col ?? -1]);
const db = new DatabaseSync(beforePath, { readOnly: true });
try {
  db.exec('PRAGMA query_only=ON');
  db.prepare('ATTACH DATABASE ? AS candidate').run(afterPath);
  const columnsFor = schema => db.prepare(`PRAGMA ${schema}.table_info(nodes)`).all()
    .map(row => row.name).filter(name => name !== 'updated_at');
  const columns = columnsFor('main');
  if (stable(columns) !== stable(columnsFor('candidate'))) throw new Error('Node schema mismatch; compare schemas explicitly first');
  const readNodes = schema => new Map(db.prepare(`SELECT ${columns.map(quote).join(',')} FROM ${schema}.nodes`).all()
    .map(node => [node.id, node]));
  const beforeNodes = readNodes('main'), afterNodes = readNodes('candidate');
  const fullNodeView = node => ({ identity: nodeIdentity(node),
    fields: Object.fromEntries(columns.map(key => [key, nodeField(node[key], key)])) });
  const readEdges = schema => {
    const result = new Map();
    for (const edge of db.prepare(`SELECT ${edgeColumns.map(quote).join(',')} FROM ${schema}.edges`).iterate()) {
      const key = edgeKey(edge);
      if (result.has(key)) throw new Error('Duplicate edge identity; compare database integrity first');
      result.set(key, edge);
    }
    return result;
  };
  const beforeEdges = readEdges('main'), afterEdges = readEdges('candidate');
  const edgeView = (edge, nodes) => ({ source: nodeIdentity(nodes.get(edge.source)), target: nodeIdentity(nodes.get(edge.target)),
    kind: safeName(edge.kind), line: edge.line, column: edge.col,
    provenance: safeName(edge.provenance), metadata: metadata(edge.metadata) });
  const mechanism = edge => {
    const data = parse(edge.metadata) || {};
    return `${edge.kind}|${edge.provenance ?? 'unspecified'}|${safeName(data.synthesizedBy ?? 'none')}|${safeName(data.resolvedBy ?? 'none')}`;
  };
  const removedEdges = [], addedEdges = [], changedEdges = [];
  for (const [key, edge] of beforeEdges) {
    const next = afterEdges.get(key);
    if (!next) removedEdges.push(edge);
    else if (edgeColumns.some(column => edge[column] !== next[column])) changedEdges.push({ before: edge, after: next });
  }
  for (const [key, edge] of afterEdges) if (!beforeEdges.has(key)) addedEdges.push(edge);
  const removedNodes = [], addedNodes = [], changedNodes = [];
  for (const [id, node] of beforeNodes) {
    const next = afterNodes.get(id);
    if (!next) removedNodes.push(fullNodeView(node));
    else {
      const changes = fieldDiff(node, next, columns, nodeField);
      if (Object.keys(changes).length) changedNodes.push({ before: nodeIdentity(node), after: nodeIdentity(next), changes });
    }
  }
  for (const [id, node] of afterNodes) if (!beforeNodes.has(id)) addedNodes.push(fullNodeView(node));
  const sites = new Map();
  for (const [direction, edges] of [['removed', removedEdges], ['added', addedEdges]]) {
    for (const edge of edges) {
      const key = siteKey(edge);
      if (!sites.has(key)) sites.set(key, { removed: [], added: [] });
      sites.get(key)[direction].push(edge);
    }
  }
  const siteGroups = [...sites.values()].map(group => ({
    classification: group.added.length && group.removed.length ? 'both-directions-at-source-location'
      : group.added.length ? 'addition-only-at-source-location' : 'removal-only-at-source-location',
    removed: group.removed.map(edge => edgeView(edge, beforeNodes)),
    added: group.added.map(edge => edgeView(edge, afterNodes)),
  }));
  const state = schema => db.prepare(`SELECT value FROM ${schema}.project_metadata WHERE key='index_state'`).get()?.value ?? null;
  const report = {
    schemaVersion: 1, corpus,
    methodology: 'Exact full semantic projections: all node columns except updated_at; edges exclude surrogate id. Every added/removed identity and every modified same-identity row is listed. Edge identity is source,target,kind,IFNULL(line,-1),IFNULL(col,-1). Source-location groups do not assert one-to-one retargeting or correctness. Metadata fields outside a small public identity whitelist and source-bearing node fields retain comparison hashes only. No corpus source was read. No integrity/page scan is run here.',
    indexState: { baseline: safeName(state('main')), candidate: safeName(state('candidate')) },
    counts: {
      nodes: { before: beforeNodes.size, after: afterNodes.size, identitiesRemoved: removedNodes.length,
        identitiesAdded: addedNodes.length, identitiesModified: changedNodes.length,
        semanticRowsRemoved: removedNodes.length + changedNodes.length, semanticRowsAdded: addedNodes.length + changedNodes.length },
      edges: { before: beforeEdges.size, after: afterEdges.size, identitiesRemoved: removedEdges.length,
        identitiesAdded: addedEdges.length, identitiesModified: changedEdges.length,
        semanticRowsRemoved: removedEdges.length + changedEdges.length, semanticRowsAdded: addedEdges.length + changedEdges.length },
    },
    classification: {
      addedEdges: countBy(addedEdges, mechanism), removedEdges: countBy(removedEdges, mechanism),
      modifiedEdgeFieldSets: countBy(changedEdges, pair => edgeColumns.filter(key => pair.before[key] !== pair.after[key]).join(',')),
      modifiedNodeFieldSets: countBy(changedNodes, entry => Object.keys(entry.changes).sort().join(',')),
      sourceLocationGroups: countBy(siteGroups, entry => entry.classification),
    },
    nodes: { removed: removedNodes, added: addedNodes, modified: changedNodes },
    edges: {
      removed: removedEdges.map(edge => edgeView(edge, beforeNodes)),
      added: addedEdges.map(edge => edgeView(edge, afterNodes)),
      modified: changedEdges.map(pair => ({
        before: edgeView(pair.before, beforeNodes), after: edgeView(pair.after, afterNodes),
        changedFields: edgeColumns.filter(key => pair.before[key] !== pair.after[key]),
        changedMetadataKeys: [...new Set([...Object.keys(parse(pair.before.metadata) || {}), ...Object.keys(parse(pair.after.metadata) || {})])]
          .filter(key => stable((parse(pair.before.metadata) || {})[key]) !== stable((parse(pair.after.metadata) || {})[key]))
          .map(safeName),
        metadataSerializationOnly: pair.before.metadata !== pair.after.metadata
          && stable(parse(pair.before.metadata)) === stable(parse(pair.after.metadata)),
      })),
      sourceLocationGroups: siteGroups,
    },
  };
  const encoded = JSON.stringify(report, null, 2) + '\n';
  if (/(?:\/Users\/|\/home\/|\/tmp\/|file:\/\/|[A-Za-z]:\\\\)/.test(encoded)) throw new Error('Refusing public output containing a local absolute path');
  fs.writeFileSync(output, encoded, { flag: 'wx' });
  console.log(JSON.stringify({ corpus, counts: report.counts, classification: report.classification }));
} finally { db.close(); }
