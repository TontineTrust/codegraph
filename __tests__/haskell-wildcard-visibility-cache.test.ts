import { describe, expect, it } from 'vitest';
import type { Node } from '../src/types';
import type { ReExport, ResolutionContext } from '../src/resolution/types';
import {
  clearImportResolverMemos, extractImportMappings, resolveViaImport,
} from '../src/resolution/import-resolver';

type Wildcard = Extract<ReExport, { kind: 'wildcard' }>;
type Restrictions = Omit<Wildcard, 'kind' | 'source'>;

function fixture(restrictions: Restrictions) {
  const sources: Record<string, string> = {
    'Consumer.hs': 'module Consumer where\nimport Facade',
    'Facade.hs': 'module Facade (module Origin) where\nimport Origin',
    'Origin.hs': 'module Origin where',
  };
  const declaration = (name: string, filePath: string, kind: Node['kind'], owner = ''): Node => ({
    id: `${filePath}:${owner}:${name}`, name, qualifiedName: owner ? `${owner}::${name}` : name,
    kind, filePath, language: 'haskell', isExported: true,
    startLine: 1, endLine: 1, startColumn: 0, endColumn: 1, updatedAt: 0,
  });
  const value = declaration('Thing', 'Origin.hs', 'enum_member', 'Origin::ValueParent');
  const type = declaration('Thing', 'Origin.hs', 'type_alias', 'Origin::TypeParent');
  const nodes = [value, type, ...Object.keys(sources).map((file) =>
    declaration(file.slice(0, -3), file, 'namespace'))];
  const imports = new Map(Object.entries(sources).map(([file, source]) =>
    [file, extractImportMappings(file, source, 'haskell')]));
  let routes: ReExport[] = [{ kind: 'wildcard', source: 'Origin', ...restrictions }];
  let originVisits = 0;
  const context: ResolutionContext = {
    getNodesInFile: (file) => nodes.filter((node) => node.filePath === file),
    getNodesByName: (name) => nodes.filter((node) => node.name === name),
    getNodesByQualifiedName: (name) => nodes.filter((node) => node.qualifiedName === name),
    getNodesByKind: (kind) => nodes.filter((node) => node.kind === kind),
    getNodesByLowerName: (name) => nodes.filter((node) => node.name.toLowerCase() === name),
    fileExists: (file) => file in sources,
    readFile: (file) => sources[file] ?? null,
    getProjectRoot: () => '/haskell-wildcard-visibility-fixture',
    getAllFiles: () => Object.keys(sources),
    getImportMappings: (file) => imports.get(file) ?? [],
    getReExports: (file) => {
      if (file === 'Origin.hs') originVisits++;
      return file === 'Facade.hs' ? routes : [];
    },
  };
  return {
    valueId: value.id,
    typeId: type.id,
    originVisits: () => originVisits,
    replace: (next: Restrictions) => {
      // Sync replaces cached route objects before clearing resolver memos.
      routes = [{ kind: 'wildcard', source: 'Origin', ...next }];
      clearImportResolverMemos(context);
    },
    resolve: (namespace: 'type' | 'value') => resolveViaImport({
      fromNodeId: 'caller', referenceName: 'Thing',
      referenceKind: namespace === 'value' ? 'calls' : 'type_of',
      filePath: 'Consumer.hs', language: 'haskell', line: 2, column: 0,
    }, context)?.targetNodeId,
  };
}

describe('Haskell cached wildcard visibility', () => {
  it.each<{ label: string; restrictions: Restrictions; value: boolean; type: boolean }>([
    { label: 'absent lists', restrictions: {}, value: true, type: true },
    { label: 'empty names', restrictions: { includedNames: [] }, value: false, type: false },
    { label: 'empty parents', restrictions: { includedParentExports: [] }, value: false, type: false },
    { label: 'empty children', restrictions: { includedParentChildren: [] }, value: false, type: false },
    { label: 'named type', restrictions: {
      includedNames: ['Thing'], haskellTypeOnlyNames: ['Thing'],
    }, value: false, type: true },
    { label: 'named pattern', restrictions: {
      includedNames: ['Thing'], haskellValueOnlyNames: ['Thing'],
    }, value: true, type: false },
    { label: 'hidden type', restrictions: {
      excludedNames: ['Thing'], haskellTypeOnlyNames: ['Thing'],
    }, value: true, type: false },
    { label: 'hidden pattern', restrictions: {
      excludedNames: ['Thing'], haskellValueOnlyNames: ['Thing'],
    }, value: false, type: true },
    { label: 'wide parent', restrictions: {
      includedParentExports: ['ValueParent'],
    }, value: true, type: false },
    { label: 'selected children in both namespaces', restrictions: {
      includedParentChildren: [
        { parent: 'ValueParent', child: 'Thing', haskellValueOnly: true },
        { parent: 'TypeParent', child: 'Thing', haskellTypeOnly: true },
      ],
    }, value: true, type: true },
    { label: 'child restricted to the other namespace', restrictions: {
      includedParentChildren: [{ parent: 'ValueParent', child: 'Thing', haskellTypeOnly: true }],
    }, value: false, type: false },
  ])('preserves $label', ({ restrictions, value, type }) => {
    const graph = fixture(restrictions);
    expect(graph.resolve('value')).toBe(value ? graph.valueId : undefined);
    expect(graph.resolve('type')).toBe(type ? graph.typeId : undefined);
  });

  it.each([false, true])('preserves duplicate-parent visit counts (collapsed=%s)', (collapsed) => {
    const graph = fixture({
      includedParentExports: ['Empty', 'Empty'],
      includedParentChildren: [
        { parent: 'ValueParent', child: 'Thing', haskellValueOnly: true },
        { parent: 'ValueParent', child: 'Thing', haskellValueOnly: true },
        { parent: 'TypeParent', child: 'Thing', haskellTypeOnly: true },
        { parent: 'Empty', child: 'Thing' },
      ],
      ...(collapsed ? { haskellCollapsedParents: true as const } : {}),
    });
    expect(graph.resolve('value')).toBe(graph.valueId);
    expect(graph.originVisits()).toBe(collapsed ? 1 : 2);
    expect(graph.resolve('type')).toBe(graph.typeId);
    expect(graph.originVisits()).toBe(collapsed ? 2 : 4);
  });

  it('replaces cached visibility when a facade changes and restores its exports', () => {
    const graph = fixture({ includedParentExports: ['ValueParent'] });
    expect(graph.resolve('value')).toBe(graph.valueId);
    expect(graph.resolve('type')).toBeUndefined();
    graph.replace({ includedParentChildren: [
      { parent: 'TypeParent', child: 'Thing', haskellTypeOnly: true },
    ] });
    expect(graph.resolve('value')).toBeUndefined();
    expect(graph.resolve('type')).toBe(graph.typeId);
    graph.replace({ includedNames: [] });
    expect(graph.resolve('value')).toBeUndefined();
    expect(graph.resolve('type')).toBeUndefined();
    graph.replace({ includedParentExports: ['ValueParent'] });
    expect(graph.resolve('value')).toBe(graph.valueId);
    expect(graph.resolve('type')).toBeUndefined();
  });
});
