import { describe, expect, it } from 'vitest';
import type { Node } from '../src/types';
import { haskellNodeOwnedBy } from '../src/resolution/import-resolver';

const declaration = (owner: string, name = 'leaf', extra: Partial<Node> = {}): Node => ({
  id: 'fixture-node', name, qualifiedName: `Module::${owner}::${name}`,
  filePath: 'Module.hs', kind: 'field', language: 'haskell', isExported: true,
  startLine: 1, endLine: 1, startColumn: 0, endColumn: 1, updatedAt: 0,
  ...extra,
});

describe('Haskell owner pattern reuse', () => {
  it.each([
    { parent: 'Δέντρο', owner: 'Δέντρο α', other: 'ΔέντροExtra α' },
    { parent: '𐐀', owner: '𐐀 value', other: 'Other𐐀 value' },
    { parent: 'État', owner: 'État', other: 'Etat' },
  ])('preserves Unicode and typed ownership for $parent after warming', ({ parent, owner, other }) => {
    const matching = declaration(owner), different = declaration(other);
    for (let repeat = 0; repeat < 4; repeat++) {
      expect(haskellNodeOwnedBy(matching, parent)).toBe(true);
      expect(haskellNodeOwnedBy(different, parent)).toBe(false);
      expect(haskellNodeOwnedBy(matching, parent)).toBe(true);
    }
  });

  it.each([
    { parent: '(:+:)', other: '::' },
    { parent: 'T.*', other: 'Tanything' },
    { parent: 'A|B', other: 'A' },
    { parent: '[T]', other: 'T' },
    { parent: 'T\\U', other: 'TU' },
    { parent: 'T$', other: 'T' },
  ])('treats owner spelling $parent literally on cold and warmed checks', ({ parent, other }) => {
    const matching = declaration(parent), different = declaration(other);
    expect(haskellNodeOwnedBy(matching, parent)).toBe(true);
    expect(haskellNodeOwnedBy(different, parent)).toBe(false);
    expect(haskellNodeOwnedBy(matching, parent)).toBe(true);
  });

  it('accepts bare and parenthesized spellings of a typed symbolic owner', () => {
    const bare = declaration(':+: a b'), parenthesized = declaration('(:+:) a b');
    for (const parent of [':+:', '(:+:)', ':+:']) {
      expect(haskellNodeOwnedBy(bare, parent)).toBe(true);
      expect(haskellNodeOwnedBy(parenthesized, parent)).toBe(true);
      expect(haskellNodeOwnedBy(declaration(':++: a b'), parent)).toBe(false);
    }
  });

  it.each(['(:::)','left::right'])('removes the entire leaf spelling %s before checking its owner', name => {
    const node = declaration('Tree', name);
    expect(haskellNodeOwnedBy(node, 'Tree')).toBe(true);
    expect(haskellNodeOwnedBy(node, 'Tree')).toBe(true);
    expect(haskellNodeOwnedBy(node, 'left')).toBe(false);
    expect(haskellNodeOwnedBy(node, ':')).toBe(false);
    node.qualifiedName = `Module::Other::${name}`;
    expect(haskellNodeOwnedBy(node, 'Tree')).toBe(false);
    expect(haskellNodeOwnedBy(node, 'Other')).toBe(true);
  });

  it('observes qualified-name and leaf-name mutations immediately without invalidation', () => {
    const node = declaration('Tree');
    expect(haskellNodeOwnedBy(node, 'Tree')).toBe(true);
    node.qualifiedName = 'Module::Other::leaf';
    expect(haskellNodeOwnedBy(node, 'Tree')).toBe(false);
    expect(haskellNodeOwnedBy(node, 'Other')).toBe(true);
    node.name = 'renamed';
    expect(haskellNodeOwnedBy(node, 'Other')).toBe(false);
    node.qualifiedName = 'Module::Tree::renamed';
    expect(haskellNodeOwnedBy(node, 'Tree')).toBe(true);
    expect(haskellNodeOwnedBy(node, 'Other')).toBe(false);
  });

  it('observes decorator additions, edits and removal immediately without invalidation', () => {
    const node = declaration('Other', 'leaf', { decorators: [] });
    expect(haskellNodeOwnedBy(node, 'Tree')).toBe(false);
    node.decorators!.push('haskell-export-parent:Tree');
    expect(haskellNodeOwnedBy(node, 'Tree')).toBe(true);
    node.decorators![0] = 'haskell-export-parent:(:+:)';
    expect(haskellNodeOwnedBy(node, 'Tree')).toBe(false);
    expect(haskellNodeOwnedBy(node, ':+:')).toBe(true);
    expect(haskellNodeOwnedBy(node, '(:+:)')).toBe(true);
    node.decorators!.splice(0);
    expect(haskellNodeOwnedBy(node, ':+:')).toBe(false);
    node.decorators!.push('unrelated:haskell-export-parent:Tree');
    expect(haskellNodeOwnedBy(node, 'Tree')).toBe(false);
    node.decorators = ['haskell-export-parent:Tree'];
    expect(haskellNodeOwnedBy(node, 'Tree')).toBe(true);
    node.decorators = undefined;
    expect(haskellNodeOwnedBy(node, 'Tree')).toBe(false);
  });

  it('does not reuse a match result across independent nodes with the same ID', () => {
    const firstContextNode = declaration('Tree', 'leaf', { filePath: 'First.hs' });
    const secondContextNode = declaration('Other', 'leaf', { filePath: 'Second.hs' });
    for (let repeat = 0; repeat < 3; repeat++) {
      expect(haskellNodeOwnedBy(firstContextNode, 'Tree')).toBe(true);
      expect(haskellNodeOwnedBy(secondContextNode, 'Tree')).toBe(false);
      expect(haskellNodeOwnedBy(secondContextNode, 'Other')).toBe(true);
      expect(haskellNodeOwnedBy(firstContextNode, 'Other')).toBe(false);
    }
  });

  it('retains literal matching behavior after more than 1024 different parent patterns', () => {
    const known = declaration('Known.*');
    expect(haskellNodeOwnedBy(known, 'Known.*')).toBe(true);
    for (let index = 0; index < 1_025; index++) {
      const owner = `FreshOwner${index}`;
      expect(haskellNodeOwnedBy(declaration(owner), owner)).toBe(true);
    }
    expect(haskellNodeOwnedBy(known, 'Known.*')).toBe(true);
    expect(haskellNodeOwnedBy(declaration('KnownAnything'), 'Known.*')).toBe(false);
    expect(haskellNodeOwnedBy(known, 'Known.*')).toBe(true);
  });

  it.each([
    { label: 'identifier', parent: `T${'x'.repeat(1_024)}` },
    { label: 'operator', parent: `:${'+'.repeat(1_024)}` },
  ])('preserves exact fallback matching for a long $label owner', ({ parent }) => {
    const node = declaration(parent);
    expect(haskellNodeOwnedBy(node, parent)).toBe(true);
    expect(haskellNodeOwnedBy(node, `(${parent})`)).toBe(true);
    expect(haskellNodeOwnedBy(node, parent.slice(0, -1))).toBe(false);
    node.qualifiedName = 'Module::Other::leaf';
    expect(haskellNodeOwnedBy(node, parent)).toBe(false);
    node.decorators = [`haskell-export-parent:(${parent})`];
    expect(haskellNodeOwnedBy(node, parent)).toBe(true);
  });
});
