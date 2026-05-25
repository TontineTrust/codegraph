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
        if (!nameOnCtor) {
          const inner = ctor.childForFieldName('constructor');
          if (inner) nameOnCtor = inner.childForFieldName('name');
        }
        if (nameOnCtor) {
          ctx.createNode('enum_member', getNodeText(nameOnCtor, ctx.source), ctor);
        }
      }
      ctx.popScope();
      return true;
    }

    return false;
  },
};
