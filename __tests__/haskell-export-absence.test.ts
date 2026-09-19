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
const named = (source: string, originalName = 'wanted', parentExport?: string): ReExport =>
  ({ kind: 'named', source, exportedName: 'wanted', originalName, ...(parentExport ? { parentExport } : {}) });

/** Pure resolver context: no parser, filesystem, SQLite or corpus indexing. */
function fixture(routes: Record<string, ReExport[]>, initial: Node[]) {
  const values = [...initial];
  const modules = new Set(['Consumer', ...Object.keys(routes), ...initial.map(node => node.filePath.slice(0, -3))]);
  for (const list of Object.values(routes)) for (const route of list) modules.add(route.source);
  const sources = new Map([...modules].map(name => [`${name}.hs`, `module ${name} where\n${name === 'Consumer' ? 'import Facade' : ''}`]));
  const moduleNodes = [...modules].map(name => ({
    ...declaration(name, name, '', 'namespace'), id: `${name}:module`, qualifiedName: name,
  }));
  const mappings = extractImportMappings('Consumer.hs', sources.get('Consumer.hs')!, 'haskell');
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
    getProjectRoot: () => '/haskell-export-absence-fixture', getAllFiles: () => [...sources.keys()],
    getImportMappings: file => file === 'Consumer.hs' ? mappings : [],
    getReExports: file => {
      reads++;
      // A deterministic fixture safety guard, not a timing assertion.
      if (reads > 25_000) throw new Error('Fixture exceeded bounded resolver work');
      visits.set(file, (visits.get(file) ?? 0) + 1);
      return routes[file.slice(0, -3)] ?? [];
    },
  };
  return {
    resolve(name = 'wanted', namespace: 'type' | 'value' = 'value') {
      return resolveViaImport({ fromNodeId: 'caller', referenceName: name,
        referenceKind: namespace === 'value' ? 'calls' : 'type_of',
        filePath: 'Consumer.hs', language: 'haskell', line: 2, column: 0,
      }, context)?.targetNodeId;
    },
    visits: (module: string) => visits.get(`${module}.hs`) ?? 0,
    reads: () => reads,
    add(node: Node) { values.push(node); refresh(); },
    clear: () => clearImportResolverMemos(context),
  };
}

function diamond(levels: number, terminal: string): Record<string, ReExport[]> {
  const routes: Record<string, ReExport[]> = { [terminal]: [] };
  for (let level = 0; level < levels; level++) for (const side of ['A', 'B']) {
    routes[`${side}${level}`] = level === levels - 1
      ? [wildcard(terminal)]
      : [wildcard(`A${level + 1}`), wildcard(`B${level + 1}`)];
  }
  return routes;
}

describe('Haskell export absence proofs', () => {
  it('prunes a candidate-free diamond without losing a valid sibling', () => {
    const target = declaration('Origin');
    const graph = fixture({ Facade: [wildcard('A0'), wildcard('Origin')], Origin: [], ...diamond(20, 'Empty') }, [target]);
    expect(graph.resolve()).toBe(target.id);
    expect(graph.reads()).toBeLessThan(1_000);
  });

  it('does not cache a cycle as absent before examining its exit', () => {
    const target = declaration('Origin', 'wanted', 'Hidden', 'field');
    const graph = fixture({
      Facade: [wildcard('A', { excludedParentExports: ['Hidden'] }), wildcard('B')],
      A: [wildcard('B'), wildcard('Origin')], B: [wildcard('A')], Origin: [],
    }, [target]);
    // The first path visits the cycle but rejects its target. B must still
    // reach the exit under the independent, unrestricted second path.
    expect(graph.resolve()).toBe(target.id);
    expect(graph.visits('A')).toBeGreaterThan(1);
    expect(graph.visits('B')).toBeGreaterThan(1);
  });

  it('closes a candidate-free cycle while preserving a separate target', () => {
    const target = declaration('Origin');
    const graph = fixture({ Facade: [wildcard('A'), wildcard('B'), wildcard('Origin')],
      A: [wildcard('B')], B: [wildcard('A')], Origin: [] }, [target]);
    expect(graph.resolve()).toBe(target.id);
    expect(graph.reads()).toBeLessThan(20);
  });

  it('keys a converging module by the name after a named rename', () => {
    const target = declaration('Origin', 'actual');
    const graph = fixture({
      Facade: [named('Shared', 'missing'), named('Shared', 'missing'), named('Shared', 'actual')],
      Shared: [wildcard('Origin')], Origin: [],
    }, [target]);
    expect(graph.resolve()).toBe(target.id);
    expect(graph.visits('Shared')).toBeGreaterThan(1);
  });

  it.each(['+++', '(+++)'])('retains the node spelling %s after a rename on a later allowed path', name => {
    const target = declaration('Origin', name, 'Allowed', 'method');
    const graph = fixture({
      Facade: [wildcard('Left'), wildcard('Right')],
      Left: [named('Shared', '+++', 'Hidden')], Right: [named('Shared', '+++', 'Allowed')],
      Shared: [wildcard('Origin')], Origin: [],
    }, [target]);
    expect(graph.resolve()).toBe(target.id);
    expect(graph.visits('Shared')).toBeGreaterThan(1);
  });

  it('separates value and type candidates with the same spelling', () => {
    const type = declaration('Origin', 'T', '', 'type_alias');
    const value = declaration('Origin', 'T', 'T', 'enum_member');
    const graph = fixture({ Facade: [wildcard('Shared'), wildcard('Shared')],
      Shared: [wildcard('Origin')], Origin: [] }, [type, value]);
    expect(graph.resolve('T', 'type')).toBe(type.id);
    expect(graph.resolve('T', 'value')).toBe(value.id);
    expect(graph.resolve('T', 'type')).toBe(type.id);
  });

  it.each([
    { label: 'a different parent', first: wildcard('Shared', { includedParentExports: ['A'] }), second: wildcard('Shared', { includedParentExports: ['B'] }), bridge: wildcard('Origin') },
    { label: 'an inherited hiding predicate', first: wildcard('Shared', { excludedParentExports: ['B'] }), second: wildcard('Shared'), bridge: wildcard('Origin') },
    { label: 'a named parent reset', first: wildcard('Shared', { excludedParentExports: ['B'] }), second: named('Shared', 'wanted', 'A'), bridge: named('Origin') },
    { label: 'a compact parent reset', first: wildcard('Shared', { excludedParentExports: ['B'] }), second: named('Shared', 'wanted', 'A'), bridge: wildcard('Origin', { includedNames: ['wanted'], haskellClearParent: true }) },
  ])('does not reuse absence under $label on a converging path', ({ first, second, bridge }) => {
    const target = declaration('Origin', 'wanted', 'B', 'field');
    const graph = fixture({ Facade: [wildcard('Left'), wildcard('Right')],
      Left: [first], Right: [second], Shared: [bridge], Origin: [] }, [target]);
    expect(graph.resolve()).toBe(target.id);
    expect(graph.visits('Shared')).toBeGreaterThan(1);
  });

  it.each([64, 65])('preserves the exact walk depth boundary at %i hops', hops => {
    const routes: Record<string, ReExport[]> = { Facade: [wildcard('M1')] };
    for (let depth = 1; depth <= hops; depth++) routes[`M${depth}`] = depth === hops ? [] : [wildcard(`M${depth + 1}`)];
    const target = declaration(`M${hops}`);
    const graph = fixture(routes, [target]);
    expect(graph.resolve()).toBe(hops === 64 ? target.id : undefined);
  });

  it('retains a late competitor in a wide converging subgraph', () => {
    const good = declaration('Facade');
    const competitor = declaration('Leaf399', 'wanted', 'B', 'field');
    const leaves = Array.from({ length: 400 }, (_, i) => `Leaf${i}`);
    const routes: Record<string, ReExport[]> = {
      Facade: [wildcard('Hidden'), wildcard('Free')],
      Hidden: [wildcard('Shared', { excludedParentExports: ['B'] })], Free: [wildcard('Shared')],
      Shared: leaves.map(name => wildcard(name)),
    };
    for (const leaf of leaves) routes[leaf] = [];
    const graph = fixture(routes, [good, competitor]);
    // Finding a candidate in the superset is not permission to accept it or
    // to skip the path-local walk. The free route must discover the competitor
    // and reject the previously found facade-local candidate as ambiguous.
    expect(graph.resolve()).toBeUndefined();
    expect(graph.visits('Shared')).toBeGreaterThanOrEqual(3);
    expect(graph.reads()).toBeLessThan(2_000);
  });

  it('falls back after more than 8192 auxiliary route checks without hiding a late target', () => {
    const target = declaration('Origin');
    const graph = fixture({
      Facade: [...Array.from({ length: 8_193 }, () => wildcard('Empty')), wildcard('Origin')],
      Empty: [], Origin: [],
    }, [target]);
    // There are only three distinct modules, but every route costs proof
    // work, including duplicates. The root proof is incomplete before it
    // reaches Origin; the exact walk still fits in its independent budget.
    expect(graph.resolve()).toBe(target.id);
    expect(graph.reads()).toBeGreaterThan(8_192);
    expect(graph.reads()).toBeLessThanOrEqual(18_192);
  });

  it.each([
    { repetitions: 3_848, exactVisits: 9_992, resolves: true },
    { repetitions: 3_858, exactVisits: 10_002, resolves: false },
  ])('keeps the exact $exactVisits-visit result independent of auxiliary proof work', ({ repetitions, exactVisits, resolves }) => {
    const target = declaration('Origin');
    const graph = fixture({
      Facade: [wildcard('A0'), ...Array.from({ length: repetitions }, () => wildcard('Origin'))],
      ...diamond(12, 'Origin'),
    }, [target]);
    // The twelve-level diamond costs 4095 internal + 2048 terminal visits.
    // Every path has the same possible target, so negative pruning cannot
    // shrink this exact walk:
    // 1 facade + 6143 diamond visits + the repeated direct-origin routes.
    // The root oracle additionally examines many routes before seeing its
    // positive witness; charging those to the exact budget loses the first
    // valid result. The second case must still exhaust the unchanged cap.
    expect(graph.resolve()).toBe(resolves ? target.id : undefined);
    expect(graph.reads()).toBeGreaterThanOrEqual(Math.min(exactVisits, 10_000));
    expect(graph.reads()).toBeLessThanOrEqual(18_192);
  });

  it('does not accept a sibling when a possible candidate still exhausts the walk', () => {
    const good = declaration('Facade');
    const hidden = declaration('Origin', 'wanted', 'Hidden', 'field');
    const graph = fixture({
      Facade: [wildcard('A0', { excludedParentExports: ['Hidden'] })],
      ...diamond(20, 'Origin'),
    }, [good, hidden]);
    // The superset contains a candidate, although the path predicate rejects
    // it. Absence must not be claimed to evade the exact walk's shared cap.
    expect(graph.resolve()).toBeUndefined();
    // The auxiliary proof has its own bound; it does not consume or reset
    // the exact walk's 10000 visits.
    expect(graph.reads()).toBeLessThanOrEqual(18_192);
  });

  it('invalidates a warm missing-competitor result when an unchanged route gains an export', () => {
    const target = declaration('Facade');
    const graph = fixture({ Facade: [wildcard('A0')], ...diamond(12, 'Origin') }, [target]);
    expect(graph.resolve()).toBe(target.id);
    expect(graph.resolve()).toBe(target.id);
    graph.add(declaration('Origin'));
    graph.clear();
    // The route arrays and module mapping did not change. A descendant node
    // update must still invalidate cached negative or unique export proofs.
    expect(graph.resolve()).toBeUndefined();
  });

  it('does not share a completed absence proof between contexts with identical paths and names', () => {
    const routes = { Facade: [wildcard('Shared')], Shared: [wildcard('Origin')], Origin: [] };
    const absent = fixture(routes, []);
    const target = declaration('Origin');
    const present = fixture(routes, [target]);
    // Even the immutable route arrays are shared. Only the context's nodes
    // differ, so a route-keyed or process-global absence memo would be wrong.
    expect(absent.resolve()).toBeUndefined();
    expect(present.resolve()).toBe(target.id);
    expect(absent.resolve()).toBeUndefined();
  });

  it.each([
    { absentNamespace: 'value', presentNamespace: 'type', kind: 'type_alias' },
    { absentNamespace: 'type', presentNamespace: 'value', kind: 'enum_member' },
  ] as const)('keeps a cached $absentNamespace absence separate from $presentNamespace exports', ({ absentNamespace, presentNamespace, kind }) => {
    const target = declaration('Origin', 'T', '', kind);
    const graph = fixture({ Facade: [wildcard('Shared')], Shared: [wildcard('Origin')], Origin: [] }, [target]);
    expect(graph.resolve('T', absentNamespace)).toBeUndefined();
    expect(graph.resolve('T', presentNamespace)).toBe(target.id);
    expect(graph.resolve('T', absentNamespace)).toBeUndefined();
  });

  it('invalidates a completed absence when only a descendant re-export route changes', () => {
    const target = declaration('Facade');
    const competitor = declaration('Origin');
    const parents = [wildcard('Shared'), wildcard('Shared')];
    const routes: Record<string, ReExport[]> = {
      Facade: parents, Shared: [wildcard('Bridge')], Bridge: [], Origin: [],
    };
    const graph = fixture(routes, [target, competitor]);
    expect(graph.resolve()).toBe(target.id);
    expect(graph.resolve()).toBe(target.id);
    // Replace the changed descendant's immutable route list, as reparsing
    // does. Ancestor route arrays and every node/module remain unchanged.
    routes.Bridge = [wildcard('Origin')];
    graph.clear();
    expect(graph.resolve()).toBeUndefined();
  });
});
