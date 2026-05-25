/**
 * Haskell extractor — basic-but-real coverage on top of the upstream
 * `tree-sitter-haskell` grammar (vendored at `../wasm/tree-sitter-haskell.wasm`,
 * ABI 14, sha256 d82f63a8…; see `../wasm/README.md` for the build recipe).
 *
 * What it extracts
 * ----------------
 *   function       — top-level `f x = …` (one node per clause; same-named clauses
 *                    dedupe at query time)
 *   method         — class method bodies + signatures, instance method bodies
 *                    (qualified as `T.method` via getReceiverType)
 *   interface      — type class declarations (`class C a where …`)
 *   enum           — data types and newtypes
 *   enum_member    — data / newtype constructors
 *   field          — record-syntax fields (`data Foo = Foo { x :: Int }`),
 *                    scoped to the parent enum (Haskell record selectors live
 *                    at the type level: `x :: Foo -> Int`)
 *   type_alias     — `type T = U` (grammar mis-spells the node `type_synomym`)
 *   import         — `import Data.List (sort)` → moduleName "Data.List"
 *
 * Edges
 * -----
 *   calls          — direct `apply` chains, leaf-only to avoid spurious
 *                    "f x"-text callees on nested/curried apply
 *   contains       — standard scope nesting
 *   imports        — module-name based
 *   implements     — emitted from `instance C T where …` (T → C) when T is
 *                    defined in the same file; also from `data T … deriving (C1, C2)`
 *                    (and the `newtype` analogue) → one per derived class
 *   extends        — emitted by core `extractInheritance` from class superclass
 *                    constraints `class (Eq a, Show a) => Ord a where …`
 *                    (Haskell `context:` AST field; see tree-sitter.ts)
 *
 * What it does NOT extract yet (known gaps)
 * -----------------------------------------
 *   - Higher-order calls: `map area xs` does not emit `caller → area`, because
 *     `area` is *passed* not invoked. Bridging this needs an allowlist of
 *     combinators; deferred per CLAUDE.md "partial coverage is worse than none".
 *   - Orphan instances: `instance C T` where `T` is defined in another file
 *     produces no `implements` edge. The receiver-type lookup is local-only;
 *     fixing this needs a resolver pass that matches by receiver-name across
 *     files.
 *   - Local where/let bindings: skipped (matches every other language's
 *     treatment of closures). Calls *inside* the where-clause still resolve.
 *   - Operator sections / infix as calls: `x + y` does not emit a call to `(+)`.
 *   - `.lhs` (literate Haskell), `.cabal`, `package.yaml`: not parsed.
 *   - No build-graph awareness: imports resolve module-name → module-name; the
 *     extractor doesn't know which Cabal/Stack package a module belongs to.
 *
 * How it's tested
 * ---------------
 *   1. Unit tests — `__tests__/extraction.test.ts` "Haskell Extraction" block.
 *      13 cases cover function extraction, type class, ADT/newtype as enum,
 *      type synonym, dotted-module imports, call attribution to the enclosing
 *      function, instance method receivers, instance/deriving → implements,
 *      superclass → extends, and record fields. All green via
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
 * For an `apply` node, return the callee name when its `function:` field is
 * a leaf (variable / constructor / qualified path). Skip when the function is
 * itself another `apply` — the inner curried call carries the leaf name and
 * gets its own bareCall pass. This avoids emitting bogus "f x"-text callee
 * names for nested applications like `f x y`.
 */
function bareCallFromApply(node: SyntaxNode, source: string): string | undefined {
  if (node.type !== 'apply') return undefined;
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
        const body = node.childForFieldName('match');
        if (body && created) ctx.visitFunctionBody(body, created.id);
        return true;
      }
      return false;
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
      // data_type wraps constructors under field `constructors` → `data_constructors`.
      // newtype has a direct `constructor:` field whose child is `newtype_constructor`.
      const ctorsWrapper = node.childForFieldName('constructors');
      const ctors: SyntaxNode[] = [];
      if (ctorsWrapper) {
        for (let i = 0; i < ctorsWrapper.namedChildCount; i++) {
          const c = ctorsWrapper.namedChild(i);
          if (c && c.type === 'data_constructor') ctors.push(c);
        }
      }
      const single = node.childForFieldName('constructor');
      if (single) ctors.push(single);

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
