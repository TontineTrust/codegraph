import { describe, expect, it } from 'vitest';
import type { Node } from '../src/types';
import type { ReExport, ResolutionContext } from '../src/resolution/types';
import { clearImportResolverMemos, extractImportMappings, resolveViaImport } from '../src/resolution/import-resolver';

const declaration = (module: string, name = 'wanted', owner = '', kind: Node['kind'] = 'function'): Node => ({
  id: `${module}:${owner}:${name}:${kind}`, name,
  qualifiedName: [module, owner, name].filter(Boolean).join('::'),
  filePath: `${module}.hs`, kind, language: 'haskell', isExported: true,
  startLine: 2, endLine: 2, startColumn: 0, endColumn: 1, updatedAt: 0,
});
const wildcard = (source: string, extra: Partial<Extract<ReExport, { kind: 'wildcard' }>> = {}): ReExport =>
  ({ kind: 'wildcard', source, ...extra });
const named = (source: string, exportedName = 'wanted', originalName = exportedName, parentExport?: string): ReExport =>
  ({ kind: 'named', source, exportedName, originalName, ...(parentExport ? { parentExport } : {}) });

/** Public resolver calls over a bounded in-memory graph; no private cache access. */
function fixture(routes: Record<string, ReExport[]>, initial: Node[]) {
  let values = [...initial];
  const modules = new Set([...Object.keys(routes), ...initial.map(node => node.filePath.slice(0, -3))]);
  for (const list of Object.values(routes)) for (const route of list) modules.add(route.source);
  const sources = new Map([...modules].map(name => [`${name}.hs`, `module ${name} where`]));
  const mappings = new Map([...modules].map(name => {
    const file = `Consumer${name}.hs`;
    const source = `module Consumer${name} where\nimport ${name}`;
    sources.set(file, source);
    return [file, extractImportMappings(file, source, 'haskell')] as const;
  }));
  const moduleNodes = [...sources.keys()].map(file => {
    const name = file.slice(0, -3);
    return { ...declaration(name, name, '', 'namespace'), id: `${name}:module`, qualifiedName: name };
  });
  let allNodes: Node[] = [];
  let byFile = new Map<string, Node[]>(), byName = new Map<string, Node[]>();
  const refresh = () => {
    allNodes = [...values, ...moduleNodes];
    byFile = new Map(); byName = new Map();
    for (const node of allNodes) {
      const file = byFile.get(node.filePath) ?? []; file.push(node); byFile.set(node.filePath, file);
      const name = byName.get(node.name) ?? []; name.push(node); byName.set(node.name, name);
    }
  };
  refresh();
  const visits = new Map<string, number>();
  let reads = 0;
  const context: ResolutionContext = {
    getNodesInFile: file => byFile.get(file) ?? [],
    getNodesByName: name => byName.get(name) ?? [],
    getNodesByQualifiedName: name => allNodes.filter(node => node.qualifiedName === name),
    getNodesByKind: kind => allNodes.filter(node => node.kind === kind),
    getNodesByLowerName: name => allNodes.filter(node => node.name.toLowerCase() === name),
    fileExists: file => sources.has(file), readFile: file => sources.get(file) ?? null,
    getProjectRoot: () => '/haskell-export-possible-fixture', getAllFiles: () => [...sources.keys()],
    getImportMappings: file => mappings.get(file) ?? [],
    getReExports: file => {
      if (++reads > 25_000) throw new Error('Fixture exceeded bounded resolver work');
      visits.set(file, (visits.get(file) ?? 0) + 1);
      return routes[file.slice(0, -3)] ?? [];
    },
  };
  return {
    resolve(module: string, name = 'wanted', namespace: 'type' | 'value' = 'value') {
      return resolveViaImport({ fromNodeId: 'caller', referenceName: name,
        referenceKind: namespace === 'value' ? 'calls' : 'type_of',
        filePath: `Consumer${module}.hs`, language: 'haskell', line: 2, column: 0,
      }, context)?.targetNodeId;
    },
    visits: (module: string) => visits.get(`${module}.hs`) ?? 0,
    reads: () => reads,
    replaceNodes(nodes: Node[]) { values = [...nodes]; refresh(); },
    clear: () => clearImportResolverMemos(context),
  };
}

describe('Haskell export proof isolation', () => {
  it('rechecks owners and ambiguity after queries for different owners', () => {
    const a = declaration('Shared', 'wanted', 'A', 'field');
    const b = declaration('Shared', 'wanted', 'B', 'field');
    const graph = fixture({
      WarmA: [named('Shared', 'wanted', 'wanted', 'A')],
      WarmB: [named('Shared', 'wanted', 'wanted', 'B')],
      Probe: [wildcard('Shared')], Shared: [],
    }, [a, b]);
    expect(graph.resolve('WarmA')).toBe(a.id);
    expect(graph.resolve('WarmB')).toBe(b.id);
    expect(graph.resolve('Probe')).toBeUndefined();
  });

  it('reproves a possible witness within each lookup while preserving path predicates', () => {
    const target = declaration('Origin', 'wanted', 'B', 'field');
    const local = declaration('Ambiguous');
    const hidden = () => wildcard('Shared', { excludedParentExports: ['B'] });
    const graph = fixture({
      Warm: [hidden(), hidden()], Probe: [hidden(), wildcard('Shared')],
      Ambiguous: [wildcard('Shared')], Shared: [wildcard('Origin')], Origin: [],
    }, [target, local]);
    // Both exact warming paths reject B. Only the unconstrained proof at
    // their convergence observes the possible witness in Origin.
    expect(graph.resolve('Warm')).toBeUndefined();
    expect(graph.visits('Shared')).toBe(3);
    const before = graph.visits('Shared');
    expect(graph.resolve('Probe')).toBe(target.id);
    // The prior lookup's proof is gone: Probe performs its own convergence
    // proof plus both exact paths. Reusing a rejected path would lose target;
    // reusing a global witness would suppress the fresh third metadata read.
    expect(graph.visits('Shared') - before).toBe(3);
    expect(graph.resolve('Ambiguous')).toBeUndefined();
  });

  it('keeps renamed witnesses separate from other exported names and targets', () => {
    const actual = declaration('Origin', 'actual');
    const other = declaration('Probe', 'other');
    const competingAlias = declaration('Ambiguous', 'alias');
    const graph = fixture({
      Warm: [wildcard('Shared')], Probe: [wildcard('Shared'), wildcard('Shared'), wildcard('Shared')],
      Ambiguous: [wildcard('Shared')], Shared: [named('Origin', 'alias', 'actual')], Origin: [],
    }, [actual, other, competingAlias]);
    expect(graph.resolve('Warm', 'alias')).toBe(actual.id);
    const before = graph.visits('Shared');
    expect(graph.resolve('Probe', 'other')).toBe(other.id);
    // First exact visit plus second-visit absence proof; the third route
    // must be pruned. A possible alias incorrectly reused for another name
    // would suppress that proof and require three exact Shared reads.
    expect(graph.visits('Shared') - before).toBe(2);
    expect(graph.resolve('Ambiguous', 'alias')).toBeUndefined();
  });

  it.each([
    { warmNamespace: 'value', probeNamespace: 'type', warmKind: 'enum_member', probeKind: 'type_alias' },
    { warmNamespace: 'type', probeNamespace: 'value', warmKind: 'type_alias', probeKind: 'enum_member' },
  ] as const)('does not let a $warmNamespace witness suppress $probeNamespace absence', ({ warmNamespace, probeNamespace, warmKind, probeKind }) => {
    const warm = declaration('Origin', 'T', '', warmKind);
    const local = declaration('Probe', 'T', '', probeKind);
    const graph = fixture({
      Warm: [wildcard('Shared')], Probe: [wildcard('Shared'), wildcard('Shared'), wildcard('Shared')],
      Shared: [wildcard('Origin')], Origin: [],
    }, [warm, local]);
    expect(graph.resolve('Warm', 'T', warmNamespace)).toBe(warm.id);
    const before = graph.visits('Shared');
    expect(graph.resolve('Probe', 'T', probeNamespace)).toBe(local.id);
    expect(graph.visits('Shared') - before).toBe(2);
  });

  it('isolates warmed witnesses between contexts with identical paths and route objects', () => {
    const routes = {
      Warm: [wildcard('Shared')], Probe: [wildcard('Shared'), wildcard('Shared'), wildcard('Shared')],
      Shared: [wildcard('Origin')], Origin: [],
    };
    const origin = declaration('Origin');
    const local = declaration('Probe');
    const present = fixture(routes, [origin]);
    const absent = fixture(routes, [local]);
    expect(present.resolve('Warm')).toBe(origin.id);
    expect(absent.resolve('Probe')).toBe(local.id);
    expect(absent.visits('Shared')).toBe(2);
  });

  it('clears stale file and exact-result indexes after a descendant declaration is removed', () => {
    const origin = declaration('Origin');
    const local = declaration('Probe');
    const routes: Record<string, ReExport[]> = {
      Warm: [wildcard('A0')], Probe: [wildcard('A0'), wildcard('A0')], Origin: [],
    };
    for (let level = 0; level < 12; level++) for (const side of ['A', 'B']) {
      routes[`${side}${level}`] = level === 11
        ? [wildcard('Origin')]
        : [wildcard(`A${level + 1}`), wildcard(`B${level + 1}`)];
    }
    const graph = fixture(routes, [origin, local]);
    expect(graph.resolve('Warm')).toBe(origin.id);
    graph.replaceNodes([local]);
    graph.clear();
    const before = graph.reads();
    // The earlier lookup found an authorized export. Clearing the ordinary
    // node/result indexes must let this lookup prove absence locally in the
    // diamond and retain its valid sibling within the exact visit cap.
    expect(graph.resolve('Probe')).toBe(local.id);
    expect(graph.reads() - before).toBeLessThan(1_000);
  });
});
