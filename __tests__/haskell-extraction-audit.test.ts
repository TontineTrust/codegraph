import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { getParser, initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['haskell']);
});

function extract(source: string) {
  const tree = getParser('haskell')!.parse(source)!;
  try {
    expect(tree.rootNode.hasError, tree.rootNode.toString()).toBe(false);
  } finally {
    tree.delete();
  }
  return extractFromSource('Audit.hs', source);
}

describe('Haskell extraction audit regressions', () => {
  it('keeps ordinary calls through SCC annotations', () => {
    const result = extract(`module Audit where
plain x = target x
annotated x = ({-# SCC "target" #-} target x)
actionPlain x = do
  target x
actionAnnotated x = {-# SCC "target" #-} do
  target x
annotatedDoStatement x = do
  {-# SCC "target" #-}
    liftIO $ target x
annotatedFinally x = do
  wrap $ ({-# SCC "target" #-} target x) \`finally\` cleanup
`);
    for (const ownerName of [
      'plain', 'annotated', 'actionPlain', 'actionAnnotated',
      'annotatedDoStatement', 'annotatedFinally',
    ]) {
      const owner = result.nodes.find((node) => node.name === ownerName)!;
      expect(result.unresolvedReferences.filter((ref) =>
        ref.fromNodeId === owner.id && ref.referenceName === 'target',
      ), ownerName).toEqual([expect.objectContaining({ referenceKind: 'calls' })]);
    }
  });

  it('suppresses case-alternative where values in the RHS and guards only', () => {
    const result = extract(`{-# LANGUAGE ViewPatterns #-}
module Audit where
import Library (action)
run value = case value of
  (action -> Just item) | action True -> action False
    where action = item
  Nothing -> action True
`);
    const owner = result.nodes.find((node) => node.name === 'run')!;
    expect(result.unresolvedReferences.filter((ref) =>
      ref.fromNodeId === owner.id && ref.referenceName === 'action',
    ).map((ref) => [ref.line, ref.column])).toEqual([[5, 3], [7, 13]]);
  });

  it('lets a case-alternative where function shadow an outer parameter', () => {
    const result = extract(`module Audit where
run action value = case value of
  Just item -> action item
    where action x = helper x
  Nothing -> action value
`);
    const owner = result.nodes.find((node) => node.name === 'run')!;
    expect(result.unresolvedReferences.filter((ref) =>
      ref.fromNodeId === owner.id && ref.referenceName === 'action',
    )).toEqual([expect.objectContaining({ referenceKind: 'calls', line: 3 })]);
  });

  it('unions repeated grouped exports without losing earlier children', () => {
    const result = extract(`module Audit (Choice(First), Choice(Second)) where
data Choice = First | Second | Hidden
`);
    expect(result.nodes.filter((node) => node.kind === 'enum_member')
      .map((node) => [node.name, node.isExported])).toEqual([
      ['First', true], ['Second', true], ['Hidden', false],
    ]);
  });

  it('limits a guard-let function to its own guard suffix and RHS', () => {
    const result = extract(`module Audit where
guarded value
  | helper value, let helper x = x, helper value = helper value
  | otherwise = helper value
`);
    const helper = result.nodes.find((node) => node.name === 'helper')!;
    // Earlier guards and later guarded RHSs are outside this let binding.
    // The range begins at `let`, and ends with this one guarded match.
    expect(helper.decorators).toContain('haskell-lexical-range:3:18:3:63');
  });
});
