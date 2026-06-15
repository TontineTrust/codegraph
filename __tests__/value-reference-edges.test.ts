/**
 * Value-reference edges (TS/JS): same-file `references` edges from a reader
 * symbol to the file-scope const/var it reads, so impact analysis catches
 * "change this constant, affect its readers". Default on; CODEGRAPH_VALUE_REFS=0
 * disables. See TreeSitterExtractor.flushValueRefs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src';

function valueRefReaders(cg: CodeGraph, constName: string): string[] {
  // Aggregate across ALL nodes of this name — a conditionally-defined module
  // const (`try: X=…; except: X=…`) has more than one, and the edge targets
  // whichever one ended up in the target map.
  const targets = cg.searchNodes(constName).map((r) => r.node).filter((n) => n.name === constName);
  const readers = new Set<string>();
  for (const t of targets) {
    for (const e of cg.getIncomingEdges(t.id)) {
      if (e.kind === 'references' && (e.metadata as { valueRef?: boolean } | undefined)?.valueRef) {
        const r = cg.getNode(e.source)?.name;
        if (r) readers.add(r);
      }
    }
  }
  return [...readers];
}

describe('value-reference edges', () => {
  let dir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-valueref-'));
  });
  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function index(): CodeGraph {
    const g = CodeGraph.initSync(dir, { config: { include: ['**/*.ts', '**/*.tsx'], exclude: [] } });
    return g;
  }

  it('edges same-file readers to the file-scope const they read (default on)', async () => {
    fs.writeFileSync(
      path.join(dir, 'config.ts'),
      [
        'export const TABLE_CONFIG = { rows: 10, cols: 4 };',
        'export function rowCount() { return TABLE_CONFIG.rows; }',
        'export function describeTable() { return `${TABLE_CONFIG.rows}x${TABLE_CONFIG.cols}`; }',
        'export const HEADER = TABLE_CONFIG.cols;',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    const readers = valueRefReaders(cg, 'TABLE_CONFIG');
    // rowCount, describeTable, and the HEADER const all read TABLE_CONFIG.
    expect(readers).toEqual(expect.arrayContaining(['rowCount', 'describeTable', 'HEADER']));
  });

  it('surfaces those readers in the impact radius of the const', async () => {
    fs.writeFileSync(
      path.join(dir, 'palette.ts'),
      [
        'export const COLOR_PALETTE = { red: "#f00", blue: "#00f" };',
        'export function pickRed() { return COLOR_PALETTE.red; }',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    const target = cg.searchNodes('COLOR_PALETTE').map((r) => r.node).find((n) => n.name === 'COLOR_PALETTE')!;
    const impacted = [...cg.getImpactRadius(target.id).nodes.values()].map((n) => n.name);
    expect(impacted).toContain('pickRed');
  });

  it('does NOT edge a shadowed const — inner re-declaration makes the name ambiguous', async () => {
    // The Emscripten/bundled pattern: a file-scope `const Module` re-declared as
    // an inner `var Module` / param. Nested readers resolve to the INNER binding,
    // so a file-scope edge would be a false positive. The shadow guard drops it.
    fs.writeFileSync(
      path.join(dir, 'bundled.ts'),
      [
        'const Module = (function () {',
        '  return function (Module) {',
        '    var Module = typeof Module !== "undefined" ? Module : {};',
        '    function locate() { return Module.path; }',
        '    function getFunc() { return Module.lookup; }',
        '    return { locate, getFunc };',
        '  };',
        '})();',
        'export default Module;',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    // No reader should be edged to the outer `const Module`.
    expect(valueRefReaders(cg, 'Module')).toEqual([]);
  });

  it('edges readers that use the const only inside JSX (.tsx)', async () => {
    // The tsx-specific path: the const is read ONLY inside JSX expressions, so
    // the reader-scan must descend into the JSX subtree to find it.
    fs.writeFileSync(
      path.join(dir, 'widget.tsx'),
      [
        'export const THEME_TOKENS = { color: "red", size: 12 };',
        'export function Label() {',
        '  return <span style={{ color: THEME_TOKENS.color }}>hi</span>;',
        '}',
        'export const Box = () => <div data-size={THEME_TOKENS.size} />;',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    expect(valueRefReaders(cg, 'THEME_TOKENS')).toEqual(expect.arrayContaining(['Label', 'Box']));
  });

  it('edges same-file readers to a package-level const/var (Go)', async () => {
    fs.writeFileSync(
      path.join(dir, 'main.go'),
      [
        'package main',
        '',
        'const MaxRetries = 3',
        'var DefaultLabels = map[string]string{"env": "prod"}',
        '',
        'func retry() int { return MaxRetries }',
        'func labels() map[string]string { return DefaultLabels }',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    expect(valueRefReaders(cg, 'MaxRetries')).toEqual(expect.arrayContaining(['retry']));
    expect(valueRefReaders(cg, 'DefaultLabels')).toEqual(expect.arrayContaining(['labels']));
  });

  it('does NOT edge a Go package const shadowed by a local := of the same name', async () => {
    // `Timeout` is a package const AND a local `:=` (short_var_declaration) in
    // shadows(). The local read resolves to the inner binding, so a file-scope
    // edge would be a false positive — the shadow prune drops the whole target.
    fs.writeFileSync(
      path.join(dir, 'shadow.go'),
      [
        'package main',
        '',
        'const Timeout = 30',
        '',
        'func usesConst() int { return Timeout }',
        'func shadows() int {',
        '\tTimeout := 5',
        '\treturn Timeout',
        '}',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    expect(valueRefReaders(cg, 'Timeout')).toEqual([]);
  });

  it('keeps a conditionally-defined module const (try/except), not a shadow (Python)', async () => {
    // `HAS_SSL` is defined twice but BOTH at module scope (a conditional def, a
    // very common Python idiom). It is one logical const, not a shadow, so its
    // reader must stay edged — and the two halves must not edge each other.
    fs.writeFileSync(
      path.join(dir, 'cond.py'),
      [
        'try:',
        '\tHAS_SSL = True',
        'except ImportError:',
        '\tHAS_SSL = False',
        '',
        'def uses_ssl():',
        '\treturn HAS_SSL',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    expect(valueRefReaders(cg, 'HAS_SSL')).toEqual(['uses_ssl']);
  });

  it('emits nothing when CODEGRAPH_VALUE_REFS=0', async () => {
    const prev = process.env.CODEGRAPH_VALUE_REFS;
    process.env.CODEGRAPH_VALUE_REFS = '0';
    try {
      fs.writeFileSync(
        path.join(dir, 'config.ts'),
        ['export const TABLE_CONFIG = { rows: 10 };', 'export function rowCount() { return TABLE_CONFIG.rows; }'].join('\n'),
      );
      cg = index();
      await cg.indexAll();
      expect(valueRefReaders(cg, 'TABLE_CONFIG')).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.CODEGRAPH_VALUE_REFS;
      else process.env.CODEGRAPH_VALUE_REFS = prev;
    }
  });
});
