/**
 * Haskell extractor — basic-but-real coverage on top of the upstream
 * `tree-sitter-haskell` grammar (vendored at `../wasm/tree-sitter-haskell.wasm`,
 * ABI 14, sha256 d82f63a8…; see `../wasm/README.md` for the build recipe).
 *
 * What it extracts
 * ----------------
 *   function       — top-level `f x = …` (one node per clause; same-named clauses
 *                    dedupe at query time). Also parameterless top-level
 *                    bindings (`main = do …`, `pi = 3.14`, `constVal = 42`)
 *                    which the grammar parses as `bind` nodes — extracted as
 *                    function-kind because they're callable in Haskell.
 *                    Also operator definitions (`x === y = …` and `(===) x y = …`)
 *                    — extracted with the operator wrapped in parens
 *                    (`function:(===)`).
 *   method         — class method bodies + signatures, instance method bodies
 *                    (qualified as `T.method` via getReceiverType)
 *   interface      — type class declarations (`class C a where …`)
 *   enum           — data types and newtypes
 *   enum_member    — data / newtype constructors; GADT constructors
 *                    (`data Term a where IntT :: Int -> Term Int`) too
 *   field          — record-syntax fields (`data Foo = Foo { x :: Int }`),
 *                    scoped to the parent enum (Haskell record selectors live
 *                    at the type level: `x :: Foo -> Int`)
 *   type_alias     — `type T = U` (grammar mis-spells the node `type_synomym`)
 *   import         — `import Data.List (sort)` → moduleName "Data.List"
 *
 * Edges
 * -----
 *   calls          — direct `apply` chains, leaf-only to avoid spurious
 *                    "f x"-text callees on nested/curried apply, PLUS
 *                    higher-order synthesis (see "Higher-order calls" below).
 *   contains       — standard scope nesting
 *   imports        — module-name based
 *   implements     — emitted from `instance C T where …` (T → C) when T is
 *                    defined in the same file; also from `data T … deriving (C1, C2)`
 *                    (and the `newtype` analogue) → one per derived class
 *   extends        — emitted by core `extractInheritance` from class superclass
 *                    constraints `class (Eq a, Show a) => Ord a where …`
 *                    (Haskell `context:` AST field; see tree-sitter.ts)
 *
 * Higher-order calls
 * ------------------
 * Haskell pervasively passes functions as data: `totalArea xs = sum (map area xs)`
 * calls `area` once per list element, but tree-sitter sees `area` only as the
 * first argument of `map`. Without synthesis the call graph is broken at every
 * idiomatic combinator. We bridge this by emitting an additional `calls` edge
 * from the caller to the FIRST positional argument of a known higher-order
 * function (see HOF_NAMES). Scope is deliberately narrow:
 *   - Only the FIRST positional arg of a curried application is treated as the
 *     "function" arg. In `mapM_ putStrLn shapes`, `putStrLn` is bridged;
 *     `shapes` (the data) is NOT (it's the argument of the outer apply, whose
 *     function field is itself an apply, not a leaf HOF variable).
 *   - Only when the argument is a bare `variable` or `constructor` name —
 *     lambdas, sections, and composed expressions (`(f . g)`, `(\\x -> …)`) are
 *     skipped.
 *   - The HOF must be a known function-first combinator. The list is the
 *     Foldable/Traversable / list-utility combinators that take their function
 *     argument FIRST: `map`, `fmap`, `mapM_`, `filter`, `foldr`, `traverse`,
 *     `concatMap`, `find`, `takeWhile`, `sortBy`, `zipWith`, … (see HOF_NAMES
 *     for the full list and rationale). Data-first variants like `forM_`,
 *     `for_`, `forM`, `for` are *deliberately excluded* — their signature is
 *     `t a -> (a -> f b) -> …` so including them would bridge the data list
 *     to the call graph, not the function.
 *   - Operators (`(>>=)`, `(<$>)`, `(.)`) are parsed as `infix` not `apply`
 *     and are NOT bridged — that's the monadic-bind frontier and needs a
 *     separate, scoped pass.
 *
 * What it does NOT extract yet (known gaps)
 * -----------------------------------------
 *   - Monadic-bind / operator-as-call flows: `xs >>= f`, `f <$> xs`. These
 *     parse as `infix` nodes; the higher-order bridge above only covers
 *     `apply`-shaped combinators.
 *   - Orphan instances: `instance C T` where `T` is defined in another file
 *     produces no `implements` edge. The receiver-type lookup is local-only;
 *     fixing this needs a resolver pass that matches by receiver-name across
 *     files.
 *   - Operator sections / infix as calls: `x + y` does not emit a call to `(+)`,
 *     `xs >>= f` does not emit a call to `(>>=)`. The operator DEFINITIONS are
 *     extracted (see above), but operator-as-call (infix usage) needs a
 *     separate pass over `infix` AST nodes that we haven't done.
 *   - `.lhs` (literate Haskell), `.cabal`, `package.yaml`: not parsed.
 *   - No build-graph awareness: imports resolve module-name → module-name; the
 *     extractor doesn't know which Cabal/Stack package a module belongs to.
 *
 * How it's tested
 * ---------------
 *   1. Unit tests — `__tests__/extraction.test.ts` "Haskell Extraction" block.
 *      27 cases cover function extraction, type class, ADT/newtype as enum,
 *      GADT constructors, type synonym, dotted-module imports, call
 *      attribution (including the regression guards that the file is NOT the
 *      attribution scope for operator/instance-method bodies), instance
 *      method receivers, instance/deriving → implements, superclass → extends,
 *      record fields, higher-order calls (positive: `map` / `filter` /
 *      `mapM_` / `traverse` / `zipWith`; negative: data-arg / data-first
 *      `forM_`/`for_` / non-HOF caller — none of those bridge), where-clause
 *      call resolution (both top-level and inside instance methods),
 *      operator function definitions, and top-level `bind` extraction
 *      (`main = do …`, `constVal = 42`). All green via
 *      `npx vitest run __tests__/extraction.test.ts -t "Haskell"`.
 *
 *   2. Real-repo extraction integrity — `scripts/add-lang/verify-extraction.mjs`
 *      on 4 pinned repos: xmonad (v0.18.1, commit 1a875b34, 39 files / 799
 *      nodes / 1630 edges / 12 implements / 57 fields), shellcheck (v0.11.0,
 *      aac0823e, 33 / 2034 / 4137 / 143 fields), pandoc (3.9.0.2, f1e06147,
 *      557 / 16220 / 35985 / 67 implements + 3 extends / 1119 fields),
 *      purescript (c4a35b34, 270 / 8185 / 15757 / 277 implements / 578 fields).
 *      All PASS.
 *
 *   3. Agent A/B benchmark — `scripts/add-lang/bench.sh haskell <name> <url> "<Q>"`
 *      runs Claude Opus headlessly twice per repo (WITH codegraph MCP /
 *      WITHOUT), parses tool calls + cost + duration. Across the 4 repos,
 *      WITH-arm uses 0 Read + 0 Grep + 0 Bash for the canonical flow question
 *      per repo (windows-arrangement for xmonad, parse-analyze for shellcheck,
 *      reader-pipeline for pandoc, compile-pipeline for purescript) where the
 *      WITHOUT-arm runs ~17 Read + ~14 Bash + 1 sub-agent per repo. The
 *      ab-matrix doc has the per-cell numbers.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

function joinModuleIds(moduleNode: SyntaxNode, source: string): string {
  const parts: string[] = [];
  for (let i = 0; i < moduleNode.namedChildCount; i++) {
    const c = moduleNode.namedChild(i);
    if (c?.type === 'module_id') parts.push(getNodeText(c, source));
  }
  return parts.join('.');
}

function getInstanceReceiverFromAncestor(node: SyntaxNode, source: string): string | undefined {
  let p: SyntaxNode | null = node.parent;
  while (p) {
    if (p.type === 'instance') {
      const patterns = p.childForFieldName('patterns');
      if (patterns) {
        for (let i = 0; i < patterns.namedChildCount; i++) {
          const c = patterns.namedChild(i);
          if (c?.type === 'name') return getNodeText(c, source);
        }
      }
      return undefined;
    }
    p = p.parent;
  }
  return undefined;
}

/**
 * Pull the class names out of a `deriving:` field — accepts the three shapes
 * the grammar emits: `deriving (Show, Eq)` → `classes: tuple`,
 * `deriving (Show)` → `classes: parens`, and `deriving Show` → `classes: name`.
 */
function derivedClassNames(derivingNode: SyntaxNode, source: string): Array<{ name: string; node: SyntaxNode }> {
  const out: Array<{ name: string; node: SyntaxNode }> = [];
  const classes = derivingNode.childForFieldName('classes');
  if (!classes) return out;
  const collect = (n: SyntaxNode) => {
    if (n.type === 'name') out.push({ name: getNodeText(n, source), node: n });
    else for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (c) collect(c);
    }
  };
  collect(classes);
  return out;
}

/**
 * Higher-order-function allowlist for call-edge synthesis. When one of these
 * names appears as the function of an `apply` whose first argument is a bare
 * variable / constructor name, that name is also emitted as a callee from the
 * enclosing function. This bridges idiomatic Haskell patterns like
 * `totalArea xs = sum (map area xs)` — without it, `area` is invisible to the
 * call graph because tree-sitter sees it as data passed to `map`, not a call.
 *
 * The set is deliberately conservative — only "applies its first argument as
 * a function" combinators. Operators like `(>>=)`, `(<$>)`, `(<*>)`, `(.)` are
 * NOT in here because the grammar parses them as `infix` not `apply`, and
 * monadic-bind-style flows are a wider frontier that needs deliberate scoping
 * (CLAUDE.md "partial coverage is worse than none").
 */
// Allowlist of combinators whose FIRST positional argument is the function
// (so an identifier passed there is a callable). The strict rule keeps the
// bridge deterministic: `mapM_ action xs` emits `action` (function-first);
// `forM_ xs action` and `for xs action` do NOT — they are list-first /
// function-second and would emit the list as a bogus callee. Same for
// `flip f x y`, `zipWith f xs ys` only emits f, etc. Stdlib signatures
// confirmed against `base-4` Prelude / Data.List / Data.Foldable /
// Data.Traversable. If you add a name here, verify the signature.
const HOF_NAMES = new Set<string>([
  // Functor / Foldable / Traversable basics (function-first)
  'map', 'fmap', 'filter', 'foldr', 'foldl', "foldl'", 'foldr1', 'foldl1',
  'concatMap', 'find', 'any', 'all',
  // Monadic action runners (function-first ONLY — NOT `forM`/`for`, those are
  // `flip mapM` / `flip traverse` and put the data list first)
  'mapM', 'mapM_', 'foldM', 'foldM_',
  // Traversable (function-first)
  'traverse', 'traverse_', 'mapAccumL', 'mapAccumR',
  // List utilities that take a predicate / comparator as the FIRST arg
  'takeWhile', 'dropWhile', 'span', 'break', 'partition',
  'groupBy', 'sortBy', 'nubBy', 'deleteBy', 'insertBy', 'unionBy', 'intersectBy',
  // Two-list / multi-arg HOFs (function-first)
  'zipWith', 'zipWith3', 'zipWithM', 'zipWithM_',
  // Misc function-first combinators
  'iterate', 'unfoldr', 'until',
]);

/**
 * For an `apply` node, return the callee name when its `function:` field is
 * a leaf (variable / constructor / qualified path). Skip when the function is
 * itself another `apply` — the inner curried call carries the leaf name and
 * gets its own bareCall pass. This avoids emitting bogus "f x"-text callee
 * names for nested applications like `f x y`.
 *
 * Additionally synthesizes a call edge for higher-order patterns: when a bare
 * `variable` / `constructor` node is the direct `argument:` of an `apply`
 * whose `function:` is a known HOF (see `HOF_NAMES`), the argument's name is
 * also emitted as a callee. This catches `map area xs` → `caller → area`. The
 * regular `caller → map` call edge is still emitted by the apply-node pass.
 */
function bareCallFromApply(node: SyntaxNode, source: string): string | undefined {
  if (node.type === 'apply') {
    const fn = node.childForFieldName('function');
    if (!fn) return undefined;
    if (fn.type === 'variable' || fn.type === 'constructor') {
      return getNodeText(fn, source);
    }
    if (fn.type === 'qualified' || fn.type === 'qualified_variable') {
      return getNodeText(fn, source).replace(/\s+/g, '');
    }
    return undefined;
  }

  // Higher-order synthesis: only when this node is the direct `argument:` of
  // an `apply` whose `function:` is a leaf variable/constructor in HOF_NAMES.
  // The "direct argument of a leaf-HOF apply" check intentionally rules out
  // the second-or-later positional arg of curried HOFs (e.g. in
  // `mapM_ putStrLn shapes`, `shapes` is the argument of the OUTER apply whose
  // function is itself an apply — so it never matches and we don't emit a
  // bogus call to the data list).
  if (node.type === 'variable' || node.type === 'constructor') {
    const parent = node.parent;
    if (!parent) return undefined;

    // Do-block bare statement: `main = do { hi; bye }`. The `do` contains
    // `statement: exp` children, each wrapping a single expression. When that
    // expression is just a bare variable, the variable IS the monadic action
    // being run — emit a call edge from the caller to it. Without this,
    // every monadic helper invoked statement-style in a do-block is missed.
    if (parent.type === 'exp' && parent.namedChildCount === 1) {
      return getNodeText(node, source);
    }

    if (parent.type !== 'apply') return undefined;
    // Identity comparison would seem natural here, but web-tree-sitter creates
    // fresh JS wrappers for the same underlying AST node on each access — so
    // `parent.childForFieldName('argument') !== node` is always true even when
    // they refer to the same syntax node. Compare by the tree-sitter numeric
    // node id instead.
    const arg = parent.childForFieldName('argument');
    if (!arg || arg.id !== node.id) return undefined;
    const fn = parent.childForFieldName('function');
    if (!fn) return undefined;
    if (fn.type !== 'variable' && fn.type !== 'constructor') return undefined;
    if (!HOF_NAMES.has(getNodeText(fn, source))) return undefined;
    return getNodeText(node, source);
  }

  return undefined;
}

export const haskellExtractor: LanguageExtractor = {
  functionTypes: ['function'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: ['class'],
  structTypes: [],
  // data_type / newtype handled in visitNode — the grammar's body field is
  // `constructors`, not the function-shaped `match`, and constructor names
  // are nested inside `record` children, so the generic enum walker can't
  // pick them up.
  enumTypes: [],
  enumMemberTypes: [],
  typeAliasTypes: ['type_synomym'],
  importTypes: ['import'],
  callTypes: [],
  variableTypes: [],

  nameField: 'name',
  bodyField: 'match',
  paramsField: 'patterns',
  interfaceKind: 'class',
  // `where`-clause bindings live in a `binds:` sibling field on the function
  // node (NOT inside `match:`), so the core needs to walk it explicitly or
  // calls inside `where` are lost. See LanguageExtractor.extraBodyFields.
  extraBodyFields: ['binds'],

  getSignature: (node, source) => {
    const patterns = node.childForFieldName('patterns');
    if (!patterns) return undefined;
    return getNodeText(patterns, source);
  },

  getVisibility: () => 'public',
  isExported: () => true,

  getReceiverType: (node, source) => getInstanceReceiverFromAncestor(node, source),

  // visitFunctionBody calls extractBareCall on every body node, so this is
  // how we pick up `apply` calls inside function/method bodies (visitNode is
  // not invoked there).
  extractBareCall: (node, source) => bareCallFromApply(node, source),

  extractImport: (node, source) => {
    const importText = getNodeText(node, source).trim();
    const moduleNode = node.childForFieldName('module');
    if (!moduleNode) return { moduleName: importText, signature: importText };
    const moduleName = joinModuleIds(moduleNode, source);
    return { moduleName: moduleName || importText, signature: importText };
  },

  visitNode: (node, ctx) => {
    const t = node.type;

    if (t === 'signature') {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) return true;
      const name = getNodeText(nameNode, ctx.source);

      let p: SyntaxNode | null = node.parent;
      while (p && p.type !== 'class_declarations' && p.type !== 'instance_declarations') {
        p = p.parent;
      }
      if (!p) return true;

      let hasMatchingFunction = false;
      for (let i = 0; i < p.namedChildCount; i++) {
        const sib = p.namedChild(i);
        if (!sib || sib === node) continue;
        if (sib.type === 'function') {
          const sibName = sib.childForFieldName('name');
          if (sibName && getNodeText(sibName, ctx.source) === name) {
            hasMatchingFunction = true;
            break;
          }
        }
      }
      if (hasMatchingFunction) return true;

      ctx.createNode('method', name, node, {
        signature: getNodeText(node, ctx.source).trim(),
        visibility: 'public',
      });
      return true;
    }

    if (t === 'function') {
      // Operator definition: `x === y = …` has no `name:` field — instead
      // the grammar puts an `infix` child holding the left operand, operator,
      // and right operand. Detect this and create a function node named
      // `(<op>)`. Without this, operator definitions are silently dropped.
      const hasName = node.childForFieldName('name') != null;
      if (!hasName) {
        let infix: SyntaxNode | null = null;
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i);
          if (c?.type === 'infix') { infix = c; break; }
        }
        if (infix) {
          const opNode = infix.childForFieldName('operator');
          if (opNode) {
            const opText = getNodeText(opNode, ctx.source).trim();
            const opName = `(${opText})`;
            const left = infix.childForFieldName('left_operand');
            const right = infix.childForFieldName('right_operand');
            const sig = left && right
              ? `${getNodeText(left, ctx.source)} ${opText} ${getNodeText(right, ctx.source)}`
              : undefined;
            const created = ctx.createNode('function', opName, node, {
              signature: sig,
              visibility: 'public',
            });
            if (created) {
              // Push the operator node onto the scope stack so calls inside
              // its body attribute to it, not to the enclosing file. The
              // framework's extractFunction does this around its
              // visitFunctionBody call; since we bypass extractFunction here,
              // we must do it manually.
              ctx.pushScope(created.id);
              const body = node.childForFieldName('match');
              if (body) ctx.visitFunctionBody(body, created.id);
              const binds = node.childForFieldName('binds');
              if (binds) ctx.visitFunctionBody(binds, created.id);
              ctx.popScope();
            }
            return true;
          }
        }
        // Unnamed function with no infix child — skip (let framework decide).
        return false;
      }

      const parent = node.parent;
      if (parent && (parent.type === 'instance_declarations' || parent.type === 'class_declarations')) {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return true;
        const name = getNodeText(nameNode, ctx.source);
        const receiver = getInstanceReceiverFromAncestor(node, ctx.source);
        const qualifiedName = receiver ? `${receiver}.${name}` : name;
        const patterns = node.childForFieldName('patterns');
        const sig = patterns ? getNodeText(patterns, ctx.source) : undefined;
        const created = ctx.createNode('method', qualifiedName, node, {
          signature: sig,
          visibility: 'public',
        });
        if (created) {
          // Push for call attribution (see operator-handler comment above).
          ctx.pushScope(created.id);
          const body = node.childForFieldName('match');
          if (body) ctx.visitFunctionBody(body, created.id);
          // Method bodies can also have `where` clauses.
          const binds = node.childForFieldName('binds');
          if (binds) ctx.visitFunctionBody(binds, created.id);
          ctx.popScope();
        }
        return true;
      }
      return false;
    }

    // Top-level value bindings like `main = do …`, `pi = 3.14`, `constVal = 42`
    // are parsed as `bind` nodes (no `patterns:` field), NOT `function`. Without
    // this case `main` would not exist in the graph — a huge miss for any
    // Haskell program. Nested binds inside `where`/`let` are skipped (the call
    // walker still descends into their bodies and attributes to the outer
    // function — the desired behavior for "describe's effective calls").
    if (t === 'bind') {
      const parent = node.parent;
      if (!parent || parent.type !== 'declarations') return false;
      const nameNode = node.childForFieldName('name');
      if (!nameNode) return false;
      const name = getNodeText(nameNode, ctx.source);
      if (!name) return false;
      const created = ctx.createNode('function', name, node, {
        visibility: 'public',
      });
      if (created) {
        ctx.pushScope(created.id);
        const body = node.childForFieldName('match');
        if (body) ctx.visitFunctionBody(body, created.id);
        const binds = node.childForFieldName('binds');
        if (binds) ctx.visitFunctionBody(binds, created.id);
        ctx.popScope();
      }
      return true;
    }

    if (t === 'data_type' || t === 'newtype') {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) return true;
      const typeName = getNodeText(nameNode, ctx.source);
      const firstLine = getNodeText(node, ctx.source).split('\n')[0] ?? '';
      const enumNode = ctx.createNode('enum', typeName, node, {
        signature: firstLine.trim(),
        visibility: 'public',
      });
      if (!enumNode) return true;

      ctx.pushScope(enumNode.id);
      // data_type wraps constructors under field `constructors` → either
      // `data_constructors` (Haskell 98 syntax: `data T = A | B`) OR
      // `gadt_constructors` (GADT syntax: `data T where A :: T; B :: T`).
      // newtype has a direct `constructor:` field whose child is
      // `newtype_constructor`.
      const ctorsWrapper = node.childForFieldName('constructors');
      const ctors: SyntaxNode[] = [];
      const gadtCtors: SyntaxNode[] = [];
      if (ctorsWrapper) {
        for (let i = 0; i < ctorsWrapper.namedChildCount; i++) {
          const c = ctorsWrapper.namedChild(i);
          if (!c) continue;
          if (c.type === 'data_constructor') ctors.push(c);
          else if (c.type === 'gadt_constructor') gadtCtors.push(c);
        }
      }
      const single = node.childForFieldName('constructor');
      if (single) ctors.push(single);

      // GADT constructors have their name directly as a `name:` field (a
      // `constructor` typed child), no nested `record`. Emit them upfront.
      for (const g of gadtCtors) {
        const nameOnG = g.childForFieldName('name');
        if (nameOnG) {
          const ctorName = getNodeText(nameOnG, ctx.source);
          ctx.createNode('enum_member', ctorName, g, {
            signature: getNodeText(g, ctx.source).trim(),
          });
        }
      }

      for (const ctor of ctors) {
        // newtype_constructor: name is a direct `name:` field of type `constructor`.
        // data_constructor: holds a `constructor:` child which is a `record` (or
        // `prefix`) carrying the `name:` field.
        let nameOnCtor = ctor.childForFieldName('name');
        let inner: SyntaxNode | null = null;
        if (!nameOnCtor) {
          inner = ctor.childForFieldName('constructor');
          if (inner) nameOnCtor = inner.childForFieldName('name');
        }
        if (nameOnCtor) {
          ctx.createNode('enum_member', getNodeText(nameOnCtor, ctx.source), ctor);
        }

        // Record-syntax fields: data Foo = Foo { a :: Int, b :: String }.
        // The constructor's inner node is a `record` with a `fields:` child wrapping
        // one `field` per declared field; each `field` has `name: field_name`. Emit
        // a `field` node per field so accessor functions become navigable. Field is
        // scoped to the enum (the data type), not the constructor — Haskell record
        // selectors live at the type level (`a :: Foo -> Int`).
        const recordNode = inner?.type === 'record' ? inner : (ctor.childForFieldName('constructor')?.type === 'record' ? ctor.childForFieldName('constructor') : null);
        if (recordNode) {
          const fieldsWrap = recordNode.childForFieldName('fields');
          if (fieldsWrap) {
            for (let i = 0; i < fieldsWrap.namedChildCount; i++) {
              const f = fieldsWrap.namedChild(i);
              if (f?.type !== 'field') continue;
              const fnameNode = f.childForFieldName('name');
              if (!fnameNode) continue;
              const fname = getNodeText(fnameNode, ctx.source);
              if (!fname) continue;
              const typeNode = f.childForFieldName('type');
              const sig = typeNode
                ? `${fname} :: ${getNodeText(typeNode, ctx.source)}`
                : undefined;
              ctx.createNode('field', fname, f, { signature: sig, visibility: 'public' });
            }
          }
        }
      }
      ctx.popScope();

      // `deriving (Show, Eq)` → emit one `implements` reference per derived class
      // from the data type to the class. Mirrors how an explicit `instance` does
      // it; deriving is just an auto-generated instance.
      const deriving = node.childForFieldName('deriving');
      if (deriving) {
        for (const dc of derivedClassNames(deriving, ctx.source)) {
          ctx.addUnresolvedReference({
            fromNodeId: enumNode.id,
            referenceName: dc.name,
            referenceKind: 'implements',
            line: dc.node.startPosition.row + 1,
            column: dc.node.startPosition.column,
          });
        }
      }
      return true;
    }

    // Top-level `instance C T where …` declarations. The grammar's `instance`
    // node has `name:` = the class and `patterns: type_patterns` containing the
    // receiver type. Emit an `implements` reference from the receiver type's
    // node (if defined in this file) to the class. Method bodies inside the
    // instance are extracted by the `function` case above with the correct
    // receiver via getReceiverType. We return false so the framework still
    // descends into instance_declarations and visits those method bodies.
    if (t === 'instance') {
      const classNameNode = node.childForFieldName('name');
      const patterns = node.childForFieldName('patterns');
      if (classNameNode && patterns) {
        const className = getNodeText(classNameNode, ctx.source);
        for (let i = 0; i < patterns.namedChildCount; i++) {
          const c = patterns.namedChild(i);
          if (c?.type !== 'name') continue;
          const typeName = getNodeText(c, ctx.source);
          // Local lookup only — Haskell orphan instances (type defined in
          // another file) won't resolve through this path. The receiver type
          // must be one of the type-shaped node kinds we emit: enum (data /
          // newtype) or, in principle, struct/class — keep the set wide so
          // future extractor changes don't silently break this.
          const typeNode = ctx.nodes.find((n) =>
            n.name === typeName && (n.kind === 'enum' || n.kind === 'struct' || n.kind === 'class' || n.kind === 'interface')
          );
          if (typeNode) {
            ctx.addUnresolvedReference({
              fromNodeId: typeNode.id,
              referenceName: className,
              referenceKind: 'implements',
              line: classNameNode.startPosition.row + 1,
              column: classNameNode.startPosition.column,
            });
          }
        }
      }
      return false;
    }

    return false;
  },
};
