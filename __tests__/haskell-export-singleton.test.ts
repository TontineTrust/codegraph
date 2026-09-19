import { describe, expect, it } from 'vitest';
import type { Node } from '../src/types';
import type { ReExport, ResolutionContext } from '../src/resolution/types';
import { clearImportResolverMemos, extractImportMappings, resolveViaImport } from '../src/resolution/import-resolver';

const declaration = (module: string, name = 'wanted', owner = 'B', kind: Node['kind'] = 'field'): Node => ({
  id: `${module}:${owner}:${name}:${kind}`, name,
  qualifiedName: [module, owner, name].filter(Boolean).join('::'),
  filePath: `${module}.hs`, kind, language: 'haskell', isExported: true,
  startLine: 2, endLine: 2, startColumn: 0, endColumn: 1, updatedAt: 0,
});
const wildcard = (source: string, extra: Partial<Extract<ReExport, { kind: 'wildcard' }>> = {}): ReExport =>
  ({ kind: 'wildcard', source, ...extra });
const named = (source: string, exportedName = 'wanted', originalName = exportedName, parentExport?: string): ReExport =>
  ({ kind: 'named', source, exportedName, originalName, ...(parentExport ? { parentExport } : {}) });
const hidden = (source: string): ReExport => wildcard(source, { excludedParentExports: ['B'] });
const selected = (source: string, parent = 'B'): ReExport => wildcard(source, { includedParentExports: [parent] });

/** Public resolver entry points over an in-memory graph; never indexes a corpus. */
function fixture(routes: Record<string, ReExport[]>, initial: Node[], options: { nodeLookup?: 'exact' | 'missing' | 'mismatched' } = {}) {
  let values = [...initial];
  const modules = new Set([...Object.keys(routes), ...initial.map(node => node.filePath.slice(0, -3))]);
  for (const list of Object.values(routes)) for (const route of list) modules.add(route.source);
  const sources = new Map([...modules].map(name => [`${name}.hs`, `module ${name} where`]));
  const mappings = new Map([...modules].map(name => {
    const file = `Consumer${name}.hs`, source = `module Consumer${name} where\nimport ${name}`;
    sources.set(file, source);
    return [file, extractImportMappings(file, source, 'haskell')] as const;
  }));
  const moduleNodes = [...sources.keys()].map(file => {
    const name = file.slice(0, -3);
    return { ...declaration(name, name, '', 'namespace'), id: `${name}:module`, qualifiedName: name };
  });
  let allNodes: Node[] = [];
  let byFile = new Map<string, Node[]>(), byName = new Map<string, Node[]>(), byId = new Map<string, Node>();
  const refresh = () => {
    allNodes = [...values, ...moduleNodes];
    byFile = new Map(); byName = new Map(); byId = new Map();
    for (const node of allNodes) {
      byId.set(node.id, node);
      const file = byFile.get(node.filePath) ?? []; file.push(node); byFile.set(node.filePath, file);
      const name = byName.get(node.name) ?? []; name.push(node); byName.set(node.name, name);
    }
  };
  refresh();
  let reads = 0;
  const visits = new Map<string, number>(), nodeReads = new Map<string, number>();
  const context: ResolutionContext = {
    getNodesInFile: file => byFile.get(file) ?? [],
    getNodesByName: name => byName.get(name) ?? [],
    getNodesByQualifiedName: name => allNodes.filter(node => node.qualifiedName === name),
    getNodesByKind: kind => allNodes.filter(node => node.kind === kind),
    getNodesByLowerName: name => allNodes.filter(node => node.name.toLowerCase() === name),
    fileExists: file => sources.has(file), readFile: file => sources.get(file) ?? null,
    getProjectRoot: () => '/haskell-export-singleton-fixture', getAllFiles: () => [...sources.keys()],
    getImportMappings: file => mappings.get(file) ?? [],
    getReExports: file => {
      if (++reads > 25_000) throw new Error('Fixture exceeded bounded resolver work');
      visits.set(file, (visits.get(file) ?? 0) + 1);
      return routes[file.slice(0, -3)] ?? [];
    },
  };
  if (options.nodeLookup) context.getNodeById = id => {
    nodeReads.set(id, (nodeReads.get(id) ?? 0) + 1);
    const node = byId.get(id);
    if (!node || options.nodeLookup === 'missing') return null;
    return options.nodeLookup === 'mismatched'
      ? { ...node, id: `wrong:${id}`, qualifiedName: 'Other::A::wanted' }
      : node;
  };
  return {
    resolve(module: string, name = 'wanted', namespace: 'type' | 'value' = 'value') {
      return resolveViaImport({ fromNodeId: 'caller', referenceName: name,
        referenceKind: namespace === 'value' ? 'calls' : 'type_of',
        filePath: `Consumer${module}.hs`, language: 'haskell', line: 2, column: 0,
      }, context)?.targetNodeId;
    },
    replaceNodes(nodes: Node[]) { values = [...nodes]; refresh(); },
    clear: () => clearImportResolverMemos(context),
    visits: (module: string) => visits.get(`${module}.hs`) ?? 0,
    nodeReads: (id: string) => nodeReads.get(id) ?? 0,
  };
}

describe('Haskell singleton export upper bounds', () => {
  it('requires an authorized exact witness even after a singleton root is cached', () => {
    const target = declaration('Origin');
    const graph = fixture({
      Warm: [hidden('Shared'), hidden('Shared')],
      Probe: [hidden('Shared'), selected('Shared')], HiddenAgain: [hidden('Shared')],
      Shared: [wildcard('Origin')], Origin: [],
    }, [target]);
    // Warming converges but both exact paths reject B. A complete superset
    // may contain only target; that alone must never supply an exact result.
    expect(graph.resolve('Warm')).toBeUndefined();
    expect(graph.resolve('Probe')).toBe(target.id);
    expect(graph.resolve('HiddenAgain')).toBeUndefined();
  });

  it('includes a cached singleton child ID before skipping that child in a parent proof', () => {
    const child = declaration('Origin'), first = declaration('Rival');
    const graph = fixture({
      PrimeChild: [hidden('Child'), hidden('Child')],
      WarmParent: [hidden('Parent'), hidden('Parent')], Probe: [wildcard('Parent')],
      Parent: [wildcard('Rival'), wildcard('Child')], Child: [wildcard('Origin')],
      Origin: [], Rival: [],
    }, [child, first]);
    expect(graph.resolve('PrimeChild')).toBeUndefined();
    expect(graph.resolve('WarmParent')).toBeUndefined();
    // Ignoring Child's cached ID would incorrectly certify Parent as {first}.
    // Its first exact hop accepts first, so premature singleton return would
    // then conceal the later, distinct child candidate.
    expect(graph.resolve('Probe')).toBeUndefined();
  });

  it('retains a late second candidate instead of publishing the first observed ID', () => {
    const first = declaration('Origin'), late = declaration('Rival');
    const empty = Array.from({ length: 192 }, (_, i) => `Empty${i}`);
    const routes: Record<string, ReExport[]> = {
      Warm: [hidden('Shared'), hidden('Shared')], Probe: [wildcard('Shared')],
      Shared: [wildcard('Origin'), ...empty.map(name => wildcard(name)), wildcard('Rival')], Origin: [], Rival: [],
    };
    for (const name of empty) routes[name] = [];
    const graph = fixture(routes, [first, late]);
    expect(graph.resolve('Warm')).toBeUndefined();
    expect(graph.resolve('Probe')).toBeUndefined();
  });

  it.each([false, true])('examines every cycle exit before caching a bound (competitor=%s)', competitor => {
    const target = declaration('Origin'), rival = declaration('Rival');
    const graph = fixture({
      Warm: [hidden('Shared'), hidden('Shared')], Probe: [wildcard('Cycle')],
      Shared: [wildcard('Cycle'), wildcard('Origin')],
      Cycle: [wildcard('Shared'), wildcard('Rival')], Origin: [], Rival: [],
    }, competitor ? [target, rival] : [target]);
    expect(graph.resolve('Warm')).toBeUndefined();
    expect(graph.resolve('Probe')).toBe(competitor ? undefined : target.id);
  });

  it.each([
    { label: 'named reset', bridge: named('Origin'), denies: false },
    { label: 'named reset with inherited hiding', bridge: named('Origin'), denies: true },
    { label: 'compact reset', bridge: wildcard('Origin', { includedNames: ['wanted'], haskellClearParent: true }), denies: false },
    { label: 'compact reset with inherited hiding', bridge: wildcard('Origin', { includedNames: ['wanted'], haskellClearParent: true }), denies: true },
  ])('reapplies exact constraints through a warmed $label', ({ bridge, denies }) => {
    const target = declaration('Origin');
    const graph = fixture({
      Warm: [hidden('Shared'), hidden('Shared')],
      Probe: [denies ? hidden('Reset') : wildcard('Reset')],
      Reset: [named('Shared', 'wanted', 'wanted', 'A')], Shared: [bridge], Origin: [],
    }, [target]);
    expect(graph.resolve('Warm')).toBeUndefined();
    // The bridge resets the scalar A owner, but never an inherited denial.
    expect(graph.resolve('Probe')).toBe(denies ? undefined : target.id);
  });

  it.each([
    { warmNamespace: 'value', otherNamespace: 'type', warmKind: 'enum_member', otherKind: 'type_alias' },
    { warmNamespace: 'type', otherNamespace: 'value', warmKind: 'type_alias', otherKind: 'enum_member' },
  ] as const)('preserves rename and $otherNamespace ambiguity after a $warmNamespace singleton', ({ warmNamespace, otherNamespace, warmKind, otherKind }) => {
    const unique = declaration('Origin', 'Actual', 'B', warmKind);
    const first = declaration('Origin', 'Actual', 'B', otherKind);
    const second = declaration('Rival', 'Different', 'B', otherKind);
    const graph = fixture({
      Warm: [hidden('Shared'), hidden('Shared')], Probe: [wildcard('Shared')],
      Shared: [named('Origin', 'T', 'Actual'), named('Rival', 'T', 'Different')], Origin: [], Rival: [],
    }, [unique, first, second]);
    expect(graph.resolve('Warm', 'T', warmNamespace)).toBeUndefined();
    expect(graph.resolve('Probe', 'T', warmNamespace)).toBe(unique.id);
    expect(graph.resolve('Probe', 'T', otherNamespace)).toBeUndefined();
    expect(graph.resolve('Probe', 'Actual', warmNamespace)).toBeUndefined();
  });

  it.each(['declaration', 'route'])('invalidates a singleton after only a descendant %s changes', change => {
    const original = declaration('Origin'), added = declaration(change === 'route' ? 'NewOrigin' : 'Rival');
    const routes: Record<string, ReExport[]> = {
      Warm: [hidden('Shared'), hidden('Shared')], Probe: [wildcard('Shared')],
      Shared: [wildcard('Origin'), wildcard('Rival')], Origin: [], Rival: [], NewOrigin: [],
    };
    const graph = fixture(routes, change === 'route' ? [original, added] : [original]);
    expect(graph.resolve('Warm')).toBeUndefined();
    if (change === 'route') routes.Rival = [wildcard('NewOrigin')];
    else graph.replaceNodes([original, added]);
    graph.clear();
    // Every ancestor route array is unchanged. A stale {original} bound would
    // wrongly accept the first hop before visiting the new competitor.
    expect(graph.resolve('Probe')).toBeUndefined();
  });

  it('does not publish a singleton when closure crosses the depth-64 boundary', () => {
    const first = declaration('Origin'), late = declaration('M64');
    const routes: Record<string, ReExport[]> = {
      Probe: [selected('Shared', 'A'), selected('Shared')],
      Shared: [selected('Origin'), selected('M1')], Origin: [],
    };
    for (let depth = 1; depth <= 64; depth++) routes[`M${depth}`] = depth === 64 ? [] : [wildcard(`M${depth + 1}`)];
    const graph = fixture(routes, [first, late]);
    // First Shared:A has no recursive parent intersection. Shared:B then
    // converges: it can see Origin, but M64 requires exact depth 65. An
    // incomplete upper-bound proof cannot authorize an early Origin return.
    expect(graph.resolve('Probe')).toBeUndefined();
  });

  it('does not publish a singleton after seeing one ID and exhausting auxiliary work', () => {
    const first = declaration('Origin'), late = declaration('Rival');
    const graph = fixture({
      Probe: [selected('Shared', 'A'), selected('Shared')],
      Shared: [selected('Origin'), selected('Wide')],
      Wide: [...Array.from({ length: 8_193 }, () => wildcard('Empty')), wildcard('Rival')],
      Origin: [], Rival: [], Empty: [],
    }, [first, late]);
    // BFS sees Origin before processing Wide's duplicate routes. Its 8192
    // allowance expires before closure, while the independent exact walk
    // still has enough visits to reach Rival and discover true ambiguity.
    expect(graph.resolve('Probe')).toBeUndefined();
  });

  describe('path-local rejection of a complete singleton', () => {
    it('refuses a complete bound across a named default transition', () => {
      const ordinary = declaration('Shared');
      const defaultTarget = declaration('DefaultOrigin', 'implementation', 'B', 'function');
      const graph = fixture({
        Warm: [hidden('Shared'), hidden('Shared')], Probe: [wildcard('Shared')],
        Shared: [named('DefaultOrigin', 'wanted', 'default')], DefaultOrigin: [],
      }, [ordinary, defaultTarget], { nodeLookup: 'exact' });
      // The generic default branch does not apply the ordinary inherited
      // callback. The proof must refuse that transition, even after seeing
      // Shared's direct candidate. Otherwise a cached {ordinary} could both
      // prune hidden paths and conceal the later default-export competitor.
      expect(graph.resolve('Warm')).toBeUndefined();
      expect(graph.resolve('Probe')).toBeUndefined();
    });

    it('does not publish a path-local rejection as a global absence', () => {
      const target = declaration('Origin');
      const graph = fixture({
        Warm: [hidden('Shared'), hidden('Shared')], Blocked: [hidden('Shared')],
        Allowed: [selected('Shared')], Shared: [wildcard('Origin')], Origin: [],
      }, [target], { nodeLookup: 'exact' });
      expect(graph.resolve('Warm')).toBeUndefined();
      const before = graph.visits('Shared');
      expect(graph.resolve('Blocked')).toBeUndefined();
      expect(graph.visits('Shared')).toBe(before);
      // The same context and singleton key remain valid on a later path.
      expect(graph.resolve('Allowed')).toBe(target.id);
    });

    it('preserves an authorized local sibling when the only imported candidate is hidden', () => {
      const hiddenTarget = declaration('Origin'), local = declaration('Probe', 'wanted', 'A');
      const graph = fixture({
        Warm: [hidden('Shared'), hidden('Shared')], Probe: [hidden('Shared')],
        Allowed: [wildcard('Shared')], Shared: [wildcard('Origin')], Origin: [],
      }, [hiddenTarget, local], { nodeLookup: 'exact' });
      expect(graph.resolve('Warm')).toBeUndefined();
      const before = graph.visits('Shared');
      expect(graph.resolve('Probe')).toBe(local.id);
      expect(graph.visits('Shared')).toBe(before);
      expect(graph.resolve('Allowed')).toBe(hiddenTarget.id);
    });

    it.each([
      { label: 'named', bridge: named('Origin') },
      { label: 'compact', bridge: wildcard('Origin', { includedNames: ['wanted'], haskellClearParent: true }) },
    ])('preserves inherited hiding and permits alternative-owner resets through $label hops', ({ bridge }) => {
      const target = declaration('Origin');
      const graph = fixture({
        Warm: [hidden('Shared'), hidden('Shared')],
        Blocked: [hidden('Reset')], Allowed: [wildcard('Reset')],
        // Equivalent named routes produce the owner OR {A,C}. It excludes
        // B here, but Shared's next hop resets it and permits the B member.
        Reset: [named('Shared', 'wanted', 'wanted', 'A'), named('Shared', 'wanted', 'wanted', 'C')],
        Shared: [bridge], Origin: [],
      }, [target], { nodeLookup: 'exact' });
      expect(graph.resolve('Warm')).toBeUndefined();
      const before = graph.visits('Shared');
      expect(graph.resolve('Blocked')).toBeUndefined();
      expect(graph.visits('Shared')).toBe(before);
      // Parent alternatives cannot be used by the rejection shortcut:
      // unlike the inherited callback, a named/compact hop can clear them.
      expect(graph.resolve('Allowed')).toBe(target.id);
    });

    it.each(['absent', 'missing', 'mismatched'] as const)('falls back to the exact walk when the ID getter is %s', mode => {
      const target = declaration('Origin');
      const graph = fixture({
        Warm: [hidden('Shared'), hidden('Shared')], Allowed: [selected('Shared')],
        Shared: [wildcard('Origin')], Origin: [],
      }, [target], mode === 'absent' ? {} : { nodeLookup: mode });
      expect(graph.resolve('Warm')).toBeUndefined();
      const before = graph.visits('Shared');
      // The mismatched getter supplies an A-owned node with the wrong ID.
      // Testing the B-only callback on it would wrongly reject the real B.
      expect(graph.resolve('Allowed')).toBe(target.id);
      expect(graph.visits('Shared')).toBeGreaterThan(before);
      expect(graph.nodeReads(target.id)).toBe(mode === 'absent' ? 0 : 2);
    });

    it('reuses an ID lookup within one traversal and releases it before the next lookup', () => {
      const target = declaration('Origin');
      const graph = fixture({
        Warm: [hidden('Shared'), hidden('Shared')],
        Probe: [hidden('Shared'), hidden('Shared'), hidden('Shared')], Later: [hidden('Shared')],
        Shared: [wildcard('Origin')], Origin: [],
      }, [target], { nodeLookup: 'exact' });
      expect(graph.resolve('Warm')).toBeUndefined();
      const before = graph.nodeReads(target.id);
      expect(graph.resolve('Probe')).toBeUndefined();
      expect(graph.nodeReads(target.id) - before).toBe(1);
      expect(graph.resolve('Later')).toBeUndefined();
      expect(graph.nodeReads(target.id) - before).toBe(2);
    });
  });
});
