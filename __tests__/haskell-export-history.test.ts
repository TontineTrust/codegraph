import { describe, expect, it } from 'vitest';
import type { Node } from '../src/types';
import type { ReExport, ResolutionContext } from '../src/resolution/types';
import { clearImportResolverMemos, extractImportMappings, resolveViaImport } from '../src/resolution/import-resolver';

const declaration = (module: string, name = 'wanted', kind: Node['kind'] = 'function'): Node => ({
  id: `${module}:${name}:${kind}`, name, qualifiedName: `${module}::${name}`,
  filePath: `${module}.hs`, kind, language: 'haskell', isExported: true,
  startLine: 2, endLine: 2, startColumn: 0, endColumn: 1, updatedAt: 0,
});
const wildcard = (source: string): ReExport => ({ kind: 'wildcard', source });

/** Immutable metadata, no parser/index/database, and a fresh context per fixture. */
function fixture(singleton: boolean) {
  const routes: Record<string, ReExport[]> = {
    Warm: [wildcard('Left'), wildcard('Right')],
    WarmOther: [wildcard('Left'), wildcard('Right')],
    Left: [wildcard('C0')], Right: [wildcard('C0')],
    Probe: [wildcard('P')], ProbeOther: [wildcard('P')], P: [wildcard('Q')], Q: [wildcard('C0')],
  };
  for (let i = 0; i <= 62; i++) routes[`C${i}`] = i < 62 ? [wildcard(`C${i + 1}`)] : [];
  for (const list of Object.values(routes)) {
    list.forEach(Object.freeze);
    Object.freeze(list);
  }
  Object.freeze(routes);
  const roots = ['Warm', 'WarmOther', 'Probe', 'ProbeOther'];
  const files = Object.keys(routes).concat(roots.map(root => `Consumer${root}`)).map(module => `${module}.hs`);
  const nodes = (singleton ? [declaration('C0')] : roots.map(root => declaration(root))).concat(files.map(file => {
    const module = file.slice(0, -3);
    return { ...declaration(module, module, 'namespace'), qualifiedName: module };
  }));
  nodes.forEach(Object.freeze); Object.freeze(nodes); Object.freeze(files);
  const byFile = new Map(files.map(file => {
    const values = nodes.filter(node => node.filePath === file);
    Object.freeze(values);
    return [file, values] as const;
  }));
  const imports = new Map(roots.map(root => {
    const file = `Consumer${root}.hs`;
    const mappings = extractImportMappings(file, `module Consumer${root} where\nimport ${root}`, 'haskell');
    mappings.forEach(Object.freeze); Object.freeze(mappings);
    return [file, mappings] as const;
  }));
  let reads = 0;
  const context: ResolutionContext = Object.freeze({
    getNodesInFile: (file: string) => byFile.get(file) ?? [],
    getNodesByName: (name: string) => nodes.filter(node => node.name === name),
    getNodesByQualifiedName: (name: string) => nodes.filter(node => node.qualifiedName === name),
    getNodesByKind: (kind: Node['kind']) => nodes.filter(node => node.kind === kind),
    getNodesByLowerName: (name: string) => nodes.filter(node => node.name.toLowerCase() === name),
    getNodeById: (id: string) => nodes.find(node => node.id === id) ?? null,
    fileExists: (file: string) => byFile.has(file),
    readFile: (file: string) => byFile.has(file) ? `module ${file.slice(0, -3)} where` : null,
    getProjectRoot: () => '/haskell-export-history-fixture', getAllFiles: () => files,
    getImportMappings: (file: string) => imports.get(file) ?? [],
    getReExports: (file: string) => {
      if (++reads > 10_000) throw new Error('Fixture exceeded bounded resolver metadata reads');
      return routes[file.slice(0, -3)] ?? [];
    },
  });
  return {
    resolve(root: string) {
      return resolveViaImport({ fromNodeId: 'caller', referenceName: 'wanted', referenceKind: 'calls',
        filePath: `Consumer${root}.hs`, language: 'haskell', line: 2, column: 0,
      }, context)?.targetNodeId;
    },
    warmTarget: (root = 'Warm') => declaration(singleton ? 'C0' : root).id,
    clear: () => clearImportResolverMemos(context),
  };
}

describe.each([
  { name: 'absent chain with local siblings', singleton: false },
  { name: 'singleton chain without local siblings', singleton: true },
])('Haskell export lookup history: $name', ({ singleton }) => {
  // C62 is depth 64 from Warm and depth 65 from Probe. Both roots are
  // immutable. A complete shallower proof must not change a later lookup's
  // conservative depth result. Warm and Probe have distinct exact-memo keys.
  it('preserves the cold Probe result after a distinct Warm lookup', () => {
    const cold = fixture(singleton), warmed = fixture(singleton);
    expect(cold.resolve('Probe')).toBeUndefined();
    expect(warmed.resolve('Warm')).toBe(warmed.warmTarget());
    expect(warmed.resolve('Probe')).toBeUndefined();
  });

  it('preserves the result in reverse order, including a previously unqueried Probe root', () => {
    const graph = fixture(singleton);
    expect(graph.resolve('Probe')).toBeUndefined();
    expect(graph.resolve('Warm')).toBe(graph.warmTarget());
    expect(graph.resolve('Probe')).toBeUndefined();
    // ProbeOther was never memoized: this cannot pass only because the first
    // conservative result survived in the existing exact-result memo.
    expect(graph.resolve('ProbeOther')).toBeUndefined();
  });

  it('keeps independent roots stable when warm and deep queries are interleaved', () => {
    const graph = fixture(singleton);
    expect(graph.resolve('Warm')).toBe(graph.warmTarget());
    expect(graph.resolve('Probe')).toBeUndefined();
    expect(graph.resolve('WarmOther')).toBe(graph.warmTarget('WarmOther'));
    expect(graph.resolve('ProbeOther')).toBeUndefined();
    expect(graph.resolve('Warm')).toBe(graph.warmTarget());
    expect(graph.resolve('Probe')).toBeUndefined();
  });

  it('preserves both authorized and conservative results after explicit cache clearing', () => {
    const graph = fixture(singleton);
    expect(graph.resolve('Warm')).toBe(graph.warmTarget());
    graph.clear();
    expect(graph.resolve('Probe')).toBeUndefined();
    expect(graph.resolve('WarmOther')).toBe(graph.warmTarget('WarmOther'));
    expect(graph.resolve('ProbeOther')).toBeUndefined();
    graph.clear();
    expect(graph.resolve('Warm')).toBe(graph.warmTarget());
    expect(graph.resolve('Probe')).toBeUndefined();
  });
});
