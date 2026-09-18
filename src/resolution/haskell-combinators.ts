import type { ResolutionContext } from './types';
import { haskellNameHasCanonicalOrigin, parseHaskellReferenceName } from './import-resolver';

// Only the existing extractor combinators participate. A matching member name
// in an arbitrary qualified module is not evidence of these execution semantics.
const MODULE_COMBINATORS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['Prelude', [
    'map', 'fmap', 'filter', 'foldr', 'foldl', 'foldr1', 'foldl1', 'concatMap',
    'any', 'all', 'mapM', 'mapM_', 'traverse', 'takeWhile', 'dropWhile', 'span',
    'break', 'zipWith', 'zipWith3', 'iterate', 'until',
    '$', '$!', '>>', '>>=', '=<<', '*>', '<*', '<*>', '<$>', '<$',
  ]],
  ['Data.List', [
    'map', 'filter', 'foldr', 'foldl', "foldl'", 'foldr1', 'foldl1', 'concatMap',
    'find', 'any', 'all', 'mapAccumL', 'mapAccumR', 'takeWhile', 'dropWhile',
    'span', 'break', 'partition', 'groupBy', 'sortBy', 'nubBy', 'deleteBy',
    'insertBy', 'unionBy', 'intersectBy', 'zipWith', 'zipWith3', 'iterate', 'unfoldr',
  ]],
  ['Data.Foldable', [
    'foldr', 'foldl', "foldl'", 'foldr1', 'foldl1', 'concatMap', 'find', 'any',
    'all', 'mapM_', 'traverse_',
  ]],
  ['Data.Traversable', ['mapM', 'traverse', 'mapAccumL', 'mapAccumR']],
  ['Control.Monad', [
    'mapM', 'mapM_', 'foldM', 'foldM_', 'zipWithM', 'zipWithM_',
    '>>', '>>=', '=<<', '*>', '<*', '<*>', '<$>', '<$',
  ]],
  ['Control.Applicative', ['<*>', '<**>', '<|>', '*>', '<*', '<$>', '<$']],
  ['Data.Functor', ['fmap', '<$>', '<$', '<&>', '$>']],
  ['Data.Function', ['$', '&']],
];
const MODULES_BY_NAME = new Map<string, Set<string>>();
for (const [moduleName, names] of MODULE_COMBINATORS) {
  for (const name of names) {
    const modules = MODULES_BY_NAME.get(name) ?? new Set<string>();
    modules.add(moduleName);
    MODULES_BY_NAME.set(name, modules);
  }
}
const PACKAGES = new Map(MODULE_COMBINATORS.map(([moduleName]) => [moduleName, new Set(['base'])]));
// Parent-scoped import/export lists require the defining class, not just the
// module spelling. Data.List's folds are list functions, whereas the same
// names from Prelude/Data.Foldable are Foldable methods.
const CLASS_METHODS: ReadonlyArray<readonly [string, readonly string[], readonly string[]]> = [
  ['Functor', ['fmap', '<$'], ['Prelude', 'Data.Functor', 'Control.Applicative', 'Control.Monad']],
  ['Applicative', ['<*>', '*>', '<*'], ['Prelude', 'Control.Applicative', 'Control.Monad']],
  ['Monad', ['>>', '>>='], ['Prelude', 'Control.Monad']],
  ['Alternative', ['<|>'], ['Control.Applicative']],
  ['Foldable', ['foldr', 'foldl', "foldl'", 'foldr1', 'foldl1'], ['Prelude', 'Data.Foldable']],
  ['Traversable', ['mapM', 'traverse'], ['Prelude', 'Data.Traversable', 'Control.Monad']],
];
const PARENTS_BY_NAME = new Map<string, Map<string, string>>();
for (const [parent, names, modules] of CLASS_METHODS) {
  for (const name of names) {
    const parents = PARENTS_BY_NAME.get(name) ?? new Map<string, string>();
    for (const moduleName of modules) parents.set(moduleName, parent);
    PARENTS_BY_NAME.set(name, parents);
  }
}

export function haskellCombinatorHasCanonicalOrigin(
  filePath: string,
  name: string,
  context: ResolutionContext,
): boolean {
  const member = parseHaskellReferenceName(name).member;
  const modules = MODULES_BY_NAME.get(member);
  return modules !== undefined && haskellNameHasCanonicalOrigin(filePath, name, context, {
    canonicalModules: modules,
    canonicalPackages: PACKAGES,
    namespace: 'value',
    implicitPrelude: modules.has('Prelude'),
    canonicalParents: PARENTS_BY_NAME.get(member),
  });
}
