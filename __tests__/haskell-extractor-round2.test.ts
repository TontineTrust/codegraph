import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function refsFrom(source: string, ownerName: string) {
  const result = extractFromSource('Round2.hs', source);
  const owner = result.nodes.find((node) => node.name === ownerName);
  expect(owner, `missing owner ${ownerName}`).toBeDefined();
  return {
    result,
    refs: result.unresolvedReferences.filter((ref) => ref.fromNodeId === owner!.id),
  };
}

describe('Haskell extractor round 2', () => {
  it('normalizes qualified and left-spine class references', () => {
    const source = `
module Round2 where
import qualified A
class (Parent a b, A.Eq a) => Child a where
  child :: a -> a
instance A.Show Thing where
  show = A.render
data Thing = Thing deriving (A.Read)
`;
    const result = extractFromSource('Round2.hs', source);
    const child = result.nodes.find((node) => node.kind === 'trait' && node.name === 'Child')!;
    const instance = result.nodes.find((node) => node.kind === 'class' && node.name === 'A.Show Thing')!;
    const thing = result.nodes.find((node) => node.kind === 'enum' && node.name === 'Thing')!;

    expect(result.unresolvedReferences.filter((ref) => ref.fromNodeId === child.id)
      .map((ref) => [ref.referenceKind, ref.referenceName]))
      .toEqual(expect.arrayContaining([['extends', 'Parent'], ['extends', 'A::Eq']]));
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
      fromNodeId: instance.id, referenceKind: 'implements', referenceName: 'A::Show',
    }));
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
      fromNodeId: thing.id, referenceKind: 'implements', referenceName: 'A::Read',
    }));
  });

  it('extracts infix type, data, class, instance, and constructor declarations from their LHS', () => {
    const source = `
{-# LANGUAGE FlexibleInstances, MultiParamTypeClasses, TypeFamilies, TypeOperators #-}
module Round2 where
type a :+: b = Either a b
type family a + b
type instance Int + b = b
data family a :*: b
data instance Int :*: b = D b
class a :=: b where
  convert :: a -> b
instance Int :=: Bool where
  convert = check
data Pair a b = a :**: b
`;
    const result = extractFromSource('Round2.hs', source);
    const names = result.nodes.map((node) => [node.kind, node.name]);

    expect(names).toEqual(expect.arrayContaining([
      ['type_alias', '(:+:)'],
      ['type_alias', '(+)'],
      ['type_alias', 'Int + b'],
      ['enum', '(:*:)'],
      ['enum', 'Int :*: b'],
      ['trait', '(:=:)'],
      ['class', 'Int :=: Bool'],
      ['method', 'convert'],
      ['enum_member', '(:**:)'],
    ]));
    expect(result.nodes.some((node) => node.kind === 'type_alias' && node.name === 'Either')).toBe(false);
    const operatorInstance = result.nodes.find((node) => node.kind === 'class' && node.name === 'Int :=: Bool')!;
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
      fromNodeId: operatorInstance.id, referenceKind: 'implements', referenceName: ':=:',
    }));
  });

  it('keeps infix operands lexical and executes view-pattern expressions', () => {
    const source = `
{-# LANGUAGE ViewPatterns #-}
module Round2 where
handler value = value
handler .@. x = handler x
view value = Just value
use value = value
f (view -> Just x) = use x
g (view config -> Nothing) = config
qualifiedView (Views.view -> Just x) = use x
h value = case value of
  Nothing -> use value
  Just y -> use y
`;
    const result = extractFromSource('Round2.hs', source);
    const operator = result.nodes.find((node) => node.name === '(.@.)')!;
    expect(result.unresolvedReferences.some((ref) => ref.fromNodeId === operator.id
      && ['handler', 'x'].includes(ref.referenceName))).toBe(false);

    const f = result.nodes.find((node) => node.name === 'f')!;
    expect(result.unresolvedReferences.filter((ref) => ref.fromNodeId === f.id)
      .map((ref) => [ref.referenceKind, ref.referenceName]))
      .toEqual(expect.arrayContaining([
        ['calls', 'view'], ['references', 'Just'], ['calls', 'use'],
      ]));
    const g = result.nodes.find((node) => node.name === 'g')!;
    expect(result.unresolvedReferences.filter((ref) => ref.fromNodeId === g.id)
      .map((ref) => [ref.referenceKind, ref.referenceName]))
      .toEqual(expect.arrayContaining([['calls', 'view'], ['references', 'Nothing']]));
    const qualifiedView = result.nodes.find((node) => node.name === 'qualifiedView')!;
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
      fromNodeId: qualifiedView.id, referenceKind: 'calls', referenceName: 'Views::view',
    }));
    const h = result.nodes.find((node) => node.name === 'h')!;
    expect(result.unresolvedReferences.filter((ref) => ref.fromNodeId === h.id
      && ref.referenceKind === 'references').map((ref) => ref.referenceName))
      .toEqual(expect.arrayContaining(['Nothing', 'Just']));
  });

  it('distinguishes record labels, explicit binders, and field puns', () => {
    const source = `
{-# LANGUAGE NamedFieldPuns #-}
module Round2 where
data Record = Record { field :: Int -> Int }
explicit (Record { field = local }) = field (local 1)
punned Record { field } = field 1
`;
    const result = extractFromSource('Round2.hs', source);
    const explicit = result.nodes.find((node) => node.name === 'explicit')!;
    const punned = result.nodes.find((node) => node.name === 'punned')!;
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
      fromNodeId: explicit.id, referenceKind: 'calls', referenceName: 'field',
    }));
    expect(result.unresolvedReferences.some((ref) => ref.fromNodeId === explicit.id
      && ref.referenceName === 'local')).toBe(false);
    expect(result.unresolvedReferences.some((ref) => ref.fromNodeId === punned.id
      && ref.referenceName === 'field' && ref.referenceKind === 'calls')).toBe(false);
  });

  it('extracts symbolic and record pattern synonyms and their constructor dependencies', () => {
    const source = `
{-# LANGUAGE PatternSynonyms #-}
module Round2 where
pattern x :++: xs = x : xs
pattern Present { presentValue } = Just presentValue
`;
    const result = extractFromSource('Round2.hs', source);
    const symbolic = result.nodes.find((node) => node.kind === 'enum_member' && node.name === '(:++:)')!;
    const record = result.nodes.find((node) => node.kind === 'enum_member' && node.name === 'Present')!;
    expect(symbolic).toBeDefined();
    expect(record).toBeDefined();
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
      fromNodeId: symbolic.id, referenceKind: 'references', referenceName: ':',
    }));
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
      fromNodeId: record.id, referenceKind: 'references', referenceName: 'Just',
    }));
  });

  it('keeps signatures across pragmas and captures sections and qualified prefix operators', () => {
    const source = `
module Round2 where
f :: Int -> Int
{-# INLINE f #-}
f = id
increment = (+ 1)
mapped xs = map (\`op\` 2) xs
qualified = (L.<+>)
qualifiedSection = (1 L.<+>)
`;
    const result = extractFromSource('Round2.hs', source);
    expect(result.nodes.find((node) => node.name === 'f')).toEqual(expect.objectContaining({
      kind: 'function', signature: 'f :: Int -> Int',
    }));
    expect(result.nodes.find((node) => node.name === 'increment')?.kind).toBe('function');
    expect(result.unresolvedReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ referenceKind: 'function_ref', referenceName: '+' }),
      expect.objectContaining({ referenceKind: 'function_ref', referenceName: 'op' }),
      expect.objectContaining({ referenceKind: 'function_ref', referenceName: 'L::<+>' }),
    ]));
    const qualifiedSection = result.nodes.find((node) => node.name === 'qualifiedSection')!;
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
      fromNodeId: qualifiedSection.id, referenceKind: 'function_ref', referenceName: 'L::<+>',
    }));
  });

  it('applies class-child export semantics to associated data families only', () => {
    const source = `
{-# LANGUAGE TypeFamilies #-}
module Round2 (C(..), FamilyInt) where
class C a where
  data Family a
instance C Int where
  data Family Int = FamilyInt
`;
    const result = extractFromSource('Round2.hs', source);
    expect(result.nodes.find((node) => node.kind === 'enum' && node.name === 'Family'))
      .toEqual(expect.objectContaining({ isExported: true }));
    expect(result.nodes.find((node) => node.kind === 'enum' && node.name === 'Family'
      && node.qualifiedName.includes('C Int')))
      .toEqual(expect.objectContaining({ isExported: false }));
    expect(result.nodes.find((node) => node.kind === 'enum_member' && node.name === 'FamilyInt'))
      .toEqual(expect.objectContaining({ isExported: true }));
  });

  it('indexes pragma-separated signatures in linear time', () => {
    const declarations = Array.from({ length: 400 }, (_, index) => [
      `f${index} :: Int -> Int`,
      `{-# INLINE f${index} #-}`,
      `f${index} = id`,
    ].join('\n')).join('\n');
    const started = performance.now();
    const result = extractFromSource('ManySignatures.hs', `module ManySignatures where\n${declarations}\n`);
    const durationMs = performance.now() - started;
    expect(result.nodes.filter((node) => node.kind === 'function' && /^f\d+$/.test(node.name)))
      .toHaveLength(400);
    expect(durationMs).toBeLessThan(4_000);
  });

  it('extracts foreign imports and links foreign exports without duplicating bindings', () => {
    const source = `
{-# LANGUAGE ForeignFunctionInterface #-}
module Round2 (c_sin, run) where
foreign import ccall unsafe "sin" c_sin :: Double -> IO Double
foreign export ccall "hs_run" run :: Int -> IO ()
run _ = pure ()
`;
    const result = extractFromSource('Round2.hs', source);
    expect(result.nodes.find((node) => node.name === 'c_sin')).toEqual(expect.objectContaining({
      kind: 'function',
      isExported: true,
      decorators: expect.arrayContaining(['haskell-foreign-import']),
    }));
    expect(result.nodes.filter((node) => node.name === 'run')).toHaveLength(1);
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
      referenceKind: 'function_ref', referenceName: 'run',
    }));
  });

  it('records the explicit owner of bundled pattern-synonym exports', () => {
    const source = `
{-# LANGUAGE PatternSynonyms #-}
module Round2 (T(P)) where
data T = MkT
pattern P = MkT
`;
    const result = extractFromSource('Round2.hs', source);
    expect(result.nodes.find((node) => node.name === 'P')).toEqual(expect.objectContaining({
      kind: 'enum_member',
      isExported: true,
      decorators: expect.arrayContaining([
        'haskell-pattern-synonym', 'haskell-export-parent:T',
      ]),
    }));
  });

  it('records bare unqualified and qualified actions on the RHS of monadic binds', () => {
    const source = `
module Round2 where
run = do
  first <- action
  second <- Actions.next
  pure (first, second)
`;
    const { refs } = refsFrom(source, 'run');
    expect(refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ referenceKind: 'calls', referenceName: 'action' }),
      expect.objectContaining({ referenceKind: 'calls', referenceName: 'Actions::next' }),
    ]));
  });

  it('attaches standalone prefix and symbolic pattern-synonym signatures', () => {
    const source = `
{-# LANGUAGE PatternSynonyms, TypeOperators #-}
module Round2 where
-- | Present documentation.
pattern Present :: a -> Maybe a
pattern Present x = Just x
pattern (:++:) :: a -> [a] -> [a]
pattern x :++: xs = x : xs
`;
    const result = extractFromSource('Round2.hs', source);
    expect(result.nodes.find((node) => node.name === 'Present')).toEqual(expect.objectContaining({
      signature: 'pattern Present :: a -> Maybe a',
      docstring: expect.stringContaining('Present documentation'),
      startLine: 5,
    }));
    expect(result.nodes.find((node) => node.name === '(:++:)')).toEqual(expect.objectContaining({
      signature: 'pattern (:++:) :: a -> [a] -> [a]',
      startLine: 7,
    }));
  });

  it('treats future mdo binders as recursive without changing ordinary do scope', () => {
    const source = `
{-# LANGUAGE RecursiveDo #-}
module Round2 where
f x = x
value = 0
getFunction = pure id
getValue = pure 1
recursive = mdo
  result <- f value
  f <- getFunction
  value <- getValue
  pure result
sequential = do
  result <- f value
  f <- getFunction
  pure result
recursiveBlock = do
  rec
    result <- f value
    f <- getFunction
    value <- getValue
  pure result
qualifiedRecursive = M.mdo
  result <- use result
  M.return result
`;
    const recursive = refsFrom(source, 'recursive').refs;
    expect(recursive.some((ref) => ['f', 'value'].includes(ref.referenceName))).toBe(false);
    const sequential = refsFrom(source, 'sequential').refs;
    expect(sequential).toEqual(expect.arrayContaining([
      expect.objectContaining({ referenceKind: 'calls', referenceName: 'f' }),
      expect.objectContaining({ referenceName: 'value' }),
    ]));
    const recursiveBlock = refsFrom(source, 'recursiveBlock').refs;
    expect(recursiveBlock.some((ref) => ['f', 'value'].includes(ref.referenceName))).toBe(false);
    const qualifiedRecursive = refsFrom(source, 'qualifiedRecursive').refs;
    expect(qualifiedRecursive.some((ref) => ref.referenceName === 'result')).toBe(false);
  });

  it('links statically named actions executed by monadic and applicative sequence operators', () => {
    const source = `
module Round2 where
load = pure 1
next x = pure x
finish = pure ()
bind = load >>= next
flipped = next =<< load
sequenceBoth = load >> finish
applicativeBoth = load *> finish
applied = wrapped <*> load
mapped = next <$> load
flippedMap = load <&> next
replacedRight = load $> 1
replacedLeft = 1 <$ load
prefixApplied = (<*>) wrapped load
prefixSequence = (>>) load finish
prefixBind = (>>=) load next
prefixFlipped = (=<<) next load
qualifiedPrefix = (Custom.<*>) wrapped load
alternative = load <|> finish
reverseApply = load <**> wrapped
prefixAlternative = (<|>) load finish
prefixReverseApply = (<**>) load wrapped
parameter load finish = load >> finish
`;
    for (const [owner, names] of [
      ['bind', ['load']],
      ['flipped', ['load']],
      ['sequenceBoth', ['load', 'finish']],
      ['applicativeBoth', ['load', 'finish']],
      ['applied', ['wrapped', 'load']],
      ['mapped', ['load']],
      ['flippedMap', ['load']],
      ['replacedRight', ['load']],
      ['replacedLeft', ['load']],
      ['prefixApplied', ['wrapped', 'load']],
      ['prefixSequence', ['load', 'finish']],
      ['prefixBind', ['load']],
      ['prefixFlipped', ['load']],
      ['qualifiedPrefix', ['wrapped', 'load']],
      ['alternative', ['load', 'finish']],
      ['reverseApply', ['load', 'wrapped']],
      ['prefixAlternative', ['load', 'finish']],
      ['prefixReverseApply', ['load', 'wrapped']],
    ] as const) {
      const refs = refsFrom(source, owner).refs;
      for (const name of names) {
        expect(refs).toContainEqual(expect.objectContaining({
          referenceKind: 'calls', referenceName: name,
        }));
      }
    }
    const parameter = refsFrom(source, 'parameter').refs;
    expect(parameter.some((ref) => ['load', 'finish'].includes(ref.referenceName))).toBe(false);
  });

  it('captures every nested constructor used by bidirectional pattern synonyms', () => {
    const source = `
{-# LANGUAGE PatternSynonyms #-}
module Round2 where
pattern Nested x = Outer (Inner x)
pattern Match x <- Outer (Inner x) where
  Match x = Build (Wrap x)
`;
    const result = extractFromSource('Round2.hs', source);
    const nested = result.nodes.find((node) => node.name === 'Nested')!;
    const match = result.nodes.find((node) => node.name === 'Match')!;
    expect(result.unresolvedReferences.filter((ref) => ref.fromNodeId === nested.id)
      .map((ref) => ref.referenceName)).toEqual(expect.arrayContaining(['Outer', 'Inner']));
    expect(result.unresolvedReferences.filter((ref) => ref.fromNodeId === match.id)
      .map((ref) => ref.referenceName))
      .toEqual(expect.arrayContaining(['Outer', 'Inner', 'Build', 'Wrap']));
  });

  it('attaches grouped standalone pattern-synonym signatures to every binding', () => {
    const source = `
{-# LANGUAGE PatternSynonyms, TypeOperators #-}
module Round2 where
-- | Group docs.
pattern P, Q :: a -> Maybe a
pattern P x = Just x
pattern Q x = Just x
pattern (:++:), (:--:) :: a -> a -> (a, a)
pattern x :++: y = (x, y)
pattern x :--: y = (x, y)
`;
    const result = extractFromSource('Round2.hs', source);
    for (const name of ['P', 'Q']) {
      expect(result.nodes.find((node) => node.name === name)).toEqual(expect.objectContaining({
        signature: 'pattern P, Q :: a -> Maybe a',
        startLine: 5,
      }));
    }
    expect(result.nodes.find((node) => node.name === 'P')?.docstring).toContain('Group docs');
    for (const name of ['(:++:)', '(:--:)']) {
      expect(result.nodes.find((node) => node.name === name)?.signature)
        .toBe('pattern (:++:), (:--:) :: a -> a -> (a, a)');
    }
  });

  it('emits one semantic edge for constructor expressions', () => {
    const source = `
{-# LANGUAGE TypeOperators #-}
module Round2 where
data Zero = Zero
data Pair a b = a :*: b
a = Zero
b = Round2.Zero
c = 1 :*: 2
d = consume Nothing
e = (:*:) 1 True
mapped = map Just [1]
leftSection = (1 :*:)
rightSection = (:*: 2)
`;
    const result = extractFromSource('Round2.hs', source);
    for (const [owner, reference] of [['a', 'Zero'], ['b', 'Round2::Zero']] as const) {
      const refs = refsFrom(source, owner).refs.filter((ref) => ref.referenceName === reference);
      expect(refs).toEqual([expect.objectContaining({ referenceKind: 'references' })]);
    }
    const infixRefs = result.unresolvedReferences.filter((ref) => {
      const owner = result.nodes.find((node) => node.id === ref.fromNodeId);
      return owner?.name === 'c' && ref.referenceName === ':*:';
    });
    expect(infixRefs).toEqual([expect.objectContaining({ referenceKind: 'calls' })]);
    expect(refsFrom(source, 'd').refs.filter((ref) => ref.referenceName === 'Nothing'))
      .toEqual([expect.objectContaining({ referenceKind: 'references' })]);
    expect(refsFrom(source, 'e').refs.filter((ref) => ref.referenceName === 'True'))
      .toEqual([expect.objectContaining({ referenceKind: 'references' })]);
    expect(refsFrom(source, 'mapped').refs.filter((ref) => ref.referenceName === 'Just'))
      .toEqual([expect.objectContaining({ referenceKind: 'calls' })]);
    for (const owner of ['leftSection', 'rightSection']) {
      expect(refsFrom(source, owner).refs.filter((ref) => ref.referenceName === ':*:'))
        .toEqual([expect.objectContaining({ referenceKind: 'function_ref' })]);
    }
  });

  it('extracts every constructor in grouped GADT signatures', () => {
    const source = `
{-# LANGUAGE GADTs, TypeOperators #-}
module Round2 where
data U a where
  U1, U2 :: U Int
data T a where
  (:++:), (:--:) :: a -> a -> T a
`;
    const result = extractFromSource('Round2.hs', source);
    expect(result.nodes.filter((node) => node.kind === 'enum_member').map((node) => node.name))
      .toEqual(expect.arrayContaining(['U1', 'U2', '(:++:)', '(:--:)']));
  });

  it('keeps positional newtype payloads out of fields and expands grouped selectors', () => {
    const source = `
module Round2 where
newtype Wrap a = Wrap a
newtype Pair a = Pair (a, a)
data Record = Record { x, y :: Int }
newtype NewRecord = NewRecord { left, right :: Int }
`;
    const fields = extractFromSource('Round2.hs', source).nodes
      .filter((node) => node.kind === 'field').map((node) => node.name);
    expect(fields).toEqual(expect.arrayContaining(['x', 'y', 'left', 'right']));
    expect(fields).not.toEqual(expect.arrayContaining(['a']));
  });

  it('materializes record pattern-synonym selectors as module bindings', () => {
    const source = `
{-# LANGUAGE PatternSynonyms #-}
module Round2 (pattern Present, presentValue, use) where
pattern Present { presentValue } = Just presentValue
use x = presentValue x
`;
    const result = extractFromSource('Round2.hs', source);
    expect(result.nodes.find((node) => node.name === 'presentValue')).toEqual(expect.objectContaining({
      kind: 'field',
      qualifiedName: 'Round2::presentValue',
      isExported: true,
      decorators: expect.arrayContaining(['haskell-pattern-selector']),
    }));
  });

  it('extracts and deduplicates quantified superclass dependencies', () => {
    const source = `
{-# LANGUAGE ConstraintKinds, QuantifiedConstraints #-}
module Round2 where
class (Table t, forall f. SimpleKey' t f) => SimpleKey t where
class (forall x. A.Eq x => A.Eq (f x)) => Qualified f where
class c a => ParamSuper c a where
class (forall x. c x => d x) => QuantifiedVars c d where
class (F a ~ b) => Equality a b where
class (forall x. F x ~ G x) => QuantifiedEquality f where
`;
    const result = extractFromSource('Round2.hs', source);
    const refsFor = (owner: string) => {
      const node = result.nodes.find((candidate) => candidate.name === owner)!;
      return result.unresolvedReferences.filter((ref) => ref.fromNodeId === node.id
        && ref.referenceKind === 'extends').map((ref) => ref.referenceName);
    };
    expect(refsFor('SimpleKey')).toEqual(expect.arrayContaining(['Table', "SimpleKey'"]));
    expect(refsFor('Qualified')).toEqual(['A::Eq']);
    expect(refsFor('ParamSuper')).toEqual([]);
    expect(refsFor('QuantifiedVars')).toEqual([]);
    expect(refsFor('Equality')).toEqual([]);
    expect(refsFor('QuantifiedEquality')).toEqual([]);
  });

  it('captures infix patterns and bare constructors in ordinary expressions', () => {
    const source = `
{-# LANGUAGE PatternSynonyms #-}
module Round2 where
pattern x :++: xs = x : xs
match (x :++: xs) = NothingX
listed = [NothingX]
chosen flag = if flag then NothingX else OtherX
guarded x | x == NothingX = OtherX | otherwise = NothingX
multi x = if | x == NothingX -> OtherX
caseGuard x = case x of y | y == NothingX -> OtherX
`;
    const result = extractFromSource('Round2.hs', source);
    const refsFor = (owner: string) => {
      const node = result.nodes.find((candidate) => candidate.name === owner)!;
      return result.unresolvedReferences.filter((ref) => ref.fromNodeId === node.id)
        .map((ref) => ref.referenceName);
    };
    expect(refsFor('match')).toEqual(expect.arrayContaining([':++:', 'NothingX']));
    expect(refsFor('listed')).toContain('NothingX');
    expect(refsFor('chosen')).toEqual(expect.arrayContaining(['NothingX', 'OtherX']));
    for (const owner of ['guarded', 'multi', 'caseGuard']) {
      expect(refsFor(owner)).toEqual(expect.arrayContaining(['NothingX', 'OtherX']));
    }
  });

  it('captures each selector in OverloadedRecordDot projections', () => {
    const source = `
{-# LANGUAGE OverloadedRecordDot #-}
module Round2 where
run payload = payload.event
nested value = value.userInfo.email
selector = (.event)
nestedSelector = (.userInfo.email)
`;
    expect(refsFrom(source, 'run').refs).toContainEqual(expect.objectContaining({
      referenceKind: 'references', referenceName: 'event',
    }));
    expect(refsFrom(source, 'nested').refs.filter((ref) => ref.referenceKind === 'references')
      .map((ref) => ref.referenceName)).toEqual(expect.arrayContaining(['userInfo', 'email']));
    expect(refsFrom(source, 'selector').refs.map((ref) => ref.referenceName)).toEqual(['event']);
    expect(refsFrom(source, 'nestedSelector').refs.map((ref) => ref.referenceName))
      .toEqual(['userInfo', 'email']);
  });

  it('captures ordinary and overloaded record-update field paths', () => {
    const source = `
{-# LANGUAGE OverloadedRecordUpdate #-}
module Round2 where
plain r = r { field = 1 }
nested r = r { user.name = "x" }
`;
    expect(refsFrom(source, 'plain').refs.map((ref) => ref.referenceName)).toContain('field');
    expect(refsFrom(source, 'nested').refs.map((ref) => ref.referenceName))
      .toEqual(expect.arrayContaining(['user', 'name']));
  });

  it('walks matcher and builder expressions owned by pattern synonyms', () => {
    const source = `
{-# LANGUAGE PatternSynonyms, ViewPatterns #-}
module Round2 where
pattern P x <- (view -> Just x)
pattern Q x <- (Views.view config -> Outer (Inner x)) where
  Q x = Build (make x)
`;
    expect(refsFrom(source, 'P').refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ referenceKind: 'calls', referenceName: 'view' }),
      expect.objectContaining({ referenceKind: 'references', referenceName: 'Just' }),
    ]));
    const qRefs = refsFrom(source, 'Q').refs;
    expect(qRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ referenceKind: 'calls', referenceName: 'Views::view' }),
      expect.objectContaining({ referenceKind: 'references', referenceName: 'Outer' }),
      expect.objectContaining({ referenceKind: 'references', referenceName: 'Inner' }),
      expect.objectContaining({ referenceKind: 'calls', referenceName: 'Build' }),
      expect.objectContaining({ referenceKind: 'calls', referenceName: 'make' }),
    ]));
    expect(qRefs.some((ref) => ref.referenceName === 'x')).toBe(false);
  });

  it('preserves dots that belong to symbolic operator names', () => {
    const source = `
{-# LANGUAGE TypeOperators #-}
module Round2 where
(<.>) x y = x
(.+.) x y = y
f x y = x <.> y
g = (<.>)
h = (1 .+.)
i = (L.<.>)
`;
    expect(refsFrom(source, 'f').refs).toContainEqual(expect.objectContaining({
      referenceKind: 'calls', referenceName: '<.>',
    }));
    expect(refsFrom(source, 'g').refs).toContainEqual(expect.objectContaining({
      referenceKind: 'function_ref', referenceName: '(<.>)',
    }));
    expect(refsFrom(source, 'h').refs).toContainEqual(expect.objectContaining({
      referenceKind: 'function_ref', referenceName: '.+.',
    }));
    expect(refsFrom(source, 'i').refs).toContainEqual(expect.objectContaining({
      referenceKind: 'function_ref', referenceName: 'L::<.>',
    }));
  });

  it('materializes every variable from top-level pattern bindings', () => {
    const source = `
module Round2 where
(x, y) = pair
Just z = maybeZ
Record { field = selected } = record
[a, b] = items
clientA :: Int -> Int
clientB :: Int -> Int
(clientA, clientB) = clients
use = consume x y z selected a b
`;
    const result = extractFromSource('Round2.hs', source);
    for (const name of ['x', 'y', 'z', 'selected', 'a', 'b']) {
      expect(result.nodes).toContainEqual(expect.objectContaining({ kind: 'constant', name }));
    }
    for (const name of ['clientA', 'clientB']) {
      expect(result.nodes).toContainEqual(expect.objectContaining({
        kind: 'function', name, signature: `${name} :: Int -> Int`,
      }));
    }
    const z = result.nodes.find((node) => node.name === 'z')!;
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
      fromNodeId: z.id, referenceKind: 'references', referenceName: 'Just',
    }));
  });

  it('keeps where-bound constants lexical under point bindings', () => {
    const source = `
module Round2 where
f = consume x where x = Zero
g = consume x where (x, y) = pair
`;
    for (const owner of ['f', 'g']) {
      expect(refsFrom(source, owner).refs.some((ref) => ref.referenceName === 'x')).toBe(false);
    }
  });
});
