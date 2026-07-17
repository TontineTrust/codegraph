import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText, getPrecedingDocstring } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

// tree-sitter-haskell emits signatures, default signatures, and equations as
// separate syntax nodes. Keep them under one graph node per lexical declaration.
// The syntax-parent span distinguishes same-named locals in separate let blocks;
// methods are already uniquely scoped by their typeclass/instance owner.
// The core creates a lightweight ExtractorContext wrapper for every visited
// syntax node, so key the per-extraction state by the stable nodes array rather
// than by the ephemeral context object. Once an extraction result is released,
// the WeakMap entry can be collected; daemon re-indexing cannot accumulate old
// source coordinates indefinitely.
const declarationGroups = new WeakMap<object, Map<string, string>>();

function declarationGroupMap(ctx: ExtractorContext): Map<string, string> {
  const owner = ctx.nodes as object;
  let groups = declarationGroups.get(owner);
  if (!groups) {
    groups = new Map();
    declarationGroups.set(owner, groups);
  }
  return groups;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function firstDescendant(node: SyntaxNode, types: ReadonlySet<string>): SyntaxNode | null {
  if (types.has(node.type)) return node;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    const hit = firstDescendant(child, types);
    if (hit) return hit;
  }
  return null;
}

interface HaskellModuleExports {
  direct: Set<string>;
  allChildren: Set<string>;
  children: Map<string, Set<string>>;
  exportsSelf: boolean;
}

function syntaxRoot(node: SyntaxNode): SyntaxNode {
  let root = node;
  while (root.parent) root = root.parent;
  return root;
}

function normalizedExportName(node: SyntaxNode, source: string): string {
  const text = getNodeText(node, source).replace(/\s+/g, '').trim();
  return text.startsWith('(') && text.endsWith(')') ? text.slice(1, -1) : text;
}

/** Parse the module header's explicit export list from the existing AST. */
function moduleExports(node: SyntaxNode, source: string): HaskellModuleExports | null {
  const root = syntaxRoot(node);
  const header = root.namedChildren.find((child) => child.type === 'header');
  if (!header) return null;
  const exportsNode = getChildByField(header, 'exports');
  if (!exportsNode) return null; // No list means Haskell's normal "export all".

  const result: HaskellModuleExports = {
    direct: new Set(),
    allChildren: new Set(),
    children: new Map(),
    exportsSelf: false,
  };
  const ownModule = getChildByField(header, 'module');
  const ownModuleName = ownModule ? getNodeText(ownModule, source).replace(/\s+/g, '') : '';

  for (const entry of exportsNode.namedChildren) {
    if (entry.type === 'module_export') {
      const reexported = getChildByField(entry, 'module');
      if (reexported && getNodeText(reexported, source).replace(/\s+/g, '') === ownModuleName) {
        result.exportsSelf = true;
      }
      continue;
    }
    if (entry.type !== 'export') continue;
    const value = getChildByField(entry, 'variable')
      ?? getChildByField(entry, 'type')
      ?? firstDescendant(entry, new Set(['variable', 'constructor', 'name', 'prefix_id']));
    if (!value) continue;
    const name = normalizedExportName(value, source);
    if (!name) continue;
    result.direct.add(name);

    const children = getChildByField(entry, 'children');
    if (!children) continue;
    if (children.namedChildren.some((child) => child.type === 'all_names')) {
      result.allChildren.add(name);
      continue;
    }
    const names = new Set<string>();
    const stack = [...children.namedChildren];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (['variable', 'constructor', 'name', 'prefix_id'].includes(current.type)) {
        const childName = normalizedExportName(current, source);
        if (childName) names.add(childName);
      } else {
        stack.push(...current.namedChildren);
      }
    }
    result.children.set(name, names);
  }
  return result;
}

function isNameExported(
  node: SyntaxNode,
  source: string,
  name: string,
  parentName?: string,
): boolean {
  const exports = moduleExports(node, source);
  if (!exports || exports.exportsSelf) return true;
  const canonical = name.startsWith('(') && name.endsWith(')') ? name.slice(1, -1) : name;
  const canonicalParent = parentName?.startsWith('(') && parentName.endsWith(')')
    ? parentName.slice(1, -1)
    : parentName;
  if (!canonicalParent) return exports.direct.has(canonical);
  return exports.direct.has(canonical)
    || exports.allChildren.has(canonicalParent)
    || exports.children.get(canonicalParent)?.has(canonical)
    || false;
}

function precedingSignature(node: SyntaxNode, name: string, source: string): SyntaxNode | null {
  let previous = node.previousNamedSibling;
  while (previous) {
    if (previous.type === 'comment' || previous.type === 'function' || previous.type === 'bind') {
      previous = previous.previousNamedSibling;
      continue;
    }
    if (previous.type !== 'signature') return null;
    const beforeType = getNodeText(previous, source).split('::', 1)[0] ?? '';
    const names = beforeType.split(',').map((part) => part.trim());
    return names.includes(name) ? previous : null;
  }
  return null;
}

function declarationGroupKey(
  node: SyntaxNode,
  name: string,
  kind: 'function' | 'method' | 'constant',
  ctx: ExtractorContext,
): string {
  const scopeId = ctx.nodeStack[ctx.nodeStack.length - 1] ?? '';
  if (kind === 'method') return `${ctx.filePath}:method:${scopeId}:${name}`;
  const container = node.parent;
  const containerSpan = container ? `${container.startIndex}:${container.endIndex}` : 'root';
  return `${ctx.filePath}:${kind}:${scopeId}:${containerSpan}:${name}`;
}

function groupedNode(key: string, ctx: ExtractorContext) {
  const id = declarationGroupMap(ctx).get(key);
  return id ? ctx.nodes.find((candidate) => candidate.id === id) : undefined;
}

function extendGroupedNode(node: SyntaxNode, existing: NonNullable<ReturnType<typeof groupedNode>>): void {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;
  if (startLine < existing.startLine) {
    existing.startLine = startLine;
    existing.startColumn = node.startPosition.column;
  } else if (startLine === existing.startLine) {
    existing.startColumn = Math.min(existing.startColumn, node.startPosition.column);
  }
  if (endLine > existing.endLine) {
    existing.endLine = endLine;
    existing.endColumn = node.endPosition.column;
  } else if (endLine === existing.endLine) {
    existing.endColumn = Math.max(existing.endColumn, node.endPosition.column);
  }
}

function visitFunctionPayload(node: SyntaxNode, functionId: string, ctx: ExtractorContext): void {
  ctx.pushScope(functionId);
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'match' || child.type === 'local_binds' || child.type === 'where') {
      // Route through the full visitor, not the calls-only body walker: Haskell
      // permits named local functions in let/where blocks and those need the
      // language hook for clause grouping and signature attachment.
      ctx.visitNode(child);
    }
  }
  ctx.popScope();
}

function isFunctionBinding(node: SyntaxNode, signatureNode: SyntaxNode | null, source: string): boolean {
  if (signatureNode && getNodeText(signatureNode, source).includes('->')) return true;
  const match = getChildByField(node, 'match');
  let expression = match ? getChildByField(match, 'expression') : null;
  while (expression?.type === 'parens' && expression.namedChildCount === 1) {
    expression = expression.namedChild(0);
  }
  if (expression?.type === 'lambda' || expression?.type === 'lambda_case') return true;
  if (expression?.type === 'infix') {
    const operator = getChildByField(expression, 'operator');
    const operatorName = operator ? getNodeText(operator, source).trim() : '';
    return operatorName === '.' || operatorName === '>=>' || operatorName === '<=<';
  }
  return false;
}

// Function-first combinators for which a bare first argument is genuinely
// invoked by the combinator. Data-first variants (`forM_`, `for_`, …) are
// intentionally excluded.
const HOF_NAMES = new Set([
  'map', 'fmap', 'filter', 'foldr', 'foldl', "foldl'", 'foldr1', 'foldl1',
  'concatMap', 'find', 'any', 'all', 'mapM', 'mapM_', 'foldM', 'foldM_',
  'traverse', 'traverse_', 'mapAccumL', 'mapAccumR', 'takeWhile', 'dropWhile',
  'span', 'break', 'partition', 'groupBy', 'sortBy', 'nubBy', 'deleteBy',
  'insertBy', 'unionBy', 'intersectBy', 'zipWith', 'zipWith3', 'zipWithM',
  'zipWithM_', 'iterate', 'unfoldr', 'until',
]);

function patternContainsName(pattern: SyntaxNode | null, name: string, source: string): boolean {
  if (!pattern) return false;
  const stack = [pattern];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.type === 'variable' && getNodeText(current, source).trim() === name) return true;
    stack.push(...current.namedChildren);
  }
  return false;
}

function declarationBindsName(node: SyntaxNode, name: string, source: string): boolean {
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.type === 'bind' || current.type === 'function') {
      if (
        patternContainsName(getChildByField(current, 'pattern'), name, source)
        || patternContainsName(getChildByField(current, 'patterns'), name, source)
        || patternContainsName(getChildByField(current, 'name'), name, source)
      ) return true;
      continue; // Never inspect a declaration RHS as if it introduced names.
    }
    stack.push(...current.namedChildren);
  }
  return false;
}

/** Haskell lexical bindings that must not become global/imported callees. */
function isLexicallyBound(name: string, node: SyntaxNode, source: string): boolean {
  if (!name || name.includes('::')) return false;
  let branch = node;
  let ancestor = node.parent;
  while (ancestor) {
    if (ancestor.type === 'function' || ancestor.type === 'lambda') {
      if (patternContainsName(getChildByField(ancestor, 'patterns'), name, source)) return true;
    }
    if (ancestor.type === 'alternative') {
      if (patternContainsName(getChildByField(ancestor, 'pattern'), name, source)) return true;
    }
    if (ancestor.type === 'let') {
      const binds = getChildByField(ancestor, 'binds');
      if (binds && !(
        branch.startIndex >= binds.startIndex && branch.endIndex <= binds.endIndex
      ) && declarationBindsName(binds, name, source)) return true;
    }
    if (ancestor.type === 'do') {
      for (const statement of ancestor.namedChildren) {
        if (statement.startIndex >= branch.startIndex) break;
        if (declarationBindsName(statement, name, source)) return true;
      }
    }
    if (ancestor.type === 'function') break;
    branch = ancestor;
    ancestor = ancestor.parent;
  }
  return false;
}

function extractHaskellBareCall(node: SyntaxNode, source: string): string | undefined {
  if (node.type !== 'variable' && node.type !== 'constructor') return undefined;
  const name = getNodeText(node, source).trim();
  if (!name || isLexicallyBound(name, node, source)) return undefined;
  const parent = node.parent;
  if (!parent) return undefined;

  // `do { initialise; serve }`: a bare expression statement executes the
  // action even though there is no `apply` node.
  if (parent.type === 'exp' && parent.namedChildCount === 1) return name;

  // `map handler xs`: bridge the function-first argument, but never data args
  // or parameters bound by the enclosing function.
  if (parent.type !== 'apply') return undefined;
  const argument = getChildByField(parent, 'argument');
  if (!argument || argument.startIndex !== node.startIndex || argument.endIndex !== node.endIndex) return undefined;
  const fn = getChildByField(parent, 'function');
  if (!fn || (fn.type !== 'variable' && fn.type !== 'constructor')) return undefined;
  return HOF_NAMES.has(getNodeText(fn, source).trim()) ? name : undefined;
}

function derivedClassNames(node: SyntaxNode, source: string): Array<{ name: string; node: SyntaxNode }> {
  const deriving = getChildByField(node, 'deriving')
    ?? node.namedChildren.find((child) => child.type === 'deriving');
  if (!deriving) return [];
  const classes = getChildByField(deriving, 'classes') ?? deriving;
  const result: Array<{ name: string; node: SyntaxNode }> = [];
  const stack = [classes];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.type === 'name') {
      const name = getNodeText(current, source).trim();
      if (name) result.push({ name, node: current });
    } else {
      stack.push(...current.namedChildren);
    }
  }
  return result;
}

function handleBind(node: SyntaxNode, ctx: ExtractorContext): boolean {
  // A `bind` under `do` is a monadic pattern bind (`x <- action`), not a named
  // declaration. Local value binds stay attributed to their enclosing symbol;
  // only function-valued local binds become their own graph nodes.
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return false;
  const name = getNodeText(nameNode, ctx.source).trim();
  if (!name) return false;

  const scopeId = ctx.nodeStack[ctx.nodeStack.length - 1] ?? '';
  const owner = ctx.nodes.find((candidate) => candidate.id === scopeId);
  const isMethod = !!owner && (owner.kind === 'trait' || owner.decorators?.includes('haskell-instance'));
  const isTopLevel = !owner || owner.kind === 'file' || owner.kind === 'namespace';
  const signatureNode = precedingSignature(node, name, ctx.source);
  const functionBinding = isMethod || isFunctionBinding(node, signatureNode, ctx.source);
  if (!isTopLevel && !functionBinding) return false;

  const kind = isMethod ? 'method' : functionBinding ? 'function' : 'constant';
  const groupKey = declarationGroupKey(node, name, kind, ctx);
  const existing = groupedNode(groupKey, ctx);
  if (existing) {
    extendGroupedNode(node, existing);
    visitFunctionPayload(node, existing.id, ctx);
    return true;
  }
  const signature = signatureNode
    ? collapseWhitespace(getNodeText(signatureNode, ctx.source)).slice(0, 400)
    : collapseWhitespace(getNodeText(node, ctx.source).split('=', 1)[0] ?? '').slice(0, 240);
  const bindingNode = ctx.createNode(kind, name, node, {
    signature: signature || undefined,
    docstring: getPrecedingDocstring(signatureNode ?? node, ctx.source),
    isExported: isTopLevel
      ? isNameExported(node, ctx.source, name)
      : owner?.kind === 'trait' && isNameExported(node, ctx.source, name, owner.name),
  });
  if (!bindingNode) return true;

  declarationGroupMap(ctx).set(groupKey, bindingNode.id);
  visitFunctionPayload(node, bindingNode.id, ctx);
  return true;
}

function handleFunction(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = getChildByField(node, 'name');
  let name = nameNode ? getNodeText(nameNode, ctx.source).trim() : '';
  if (!name) {
    const infix = node.namedChildren.find((child) => child.type === 'infix');
    const operator = infix ? getChildByField(infix, 'operator') : null;
    const operatorName = operator ? getNodeText(operator, ctx.source).trim() : '';
    if (operatorName) name = `(${operatorName})`;
  }
  if (!name) return true;

  const scopeId = ctx.nodeStack[ctx.nodeStack.length - 1] ?? '';
  const parent = ctx.nodes.find((candidate) => candidate.id === scopeId);
  const kind = parent && (parent.kind === 'trait' || parent.decorators?.includes('haskell-instance'))
    ? 'method'
    : 'function';
  const isTopLevel = !parent || parent.kind === 'file' || parent.kind === 'namespace';
  const groupKey = declarationGroupKey(node, name, kind, ctx);
  const existing = groupedNode(groupKey, ctx);
  if (existing) {
    extendGroupedNode(node, existing);
    visitFunctionPayload(node, existing.id, ctx);
    return true;
  }

  const signatureNode = precedingSignature(node, name, ctx.source);
  const signature = signatureNode
    ? collapseWhitespace(getNodeText(signatureNode, ctx.source)).slice(0, 400)
    : collapseWhitespace(getNodeText(node, ctx.source).split('=', 1)[0] ?? '').slice(0, 240);
  const functionNode = ctx.createNode(kind, name, node, {
    signature: signature || undefined,
    docstring: getPrecedingDocstring(signatureNode ?? node, ctx.source),
    // Instance implementations and let/where helpers are lexical; class
    // methods are importable only when their parent class exports them.
    isExported: isTopLevel
      ? isNameExported(node, ctx.source, name)
      : parent?.kind === 'trait' && isNameExported(node, ctx.source, name, parent.name),
  });
  if (!functionNode) return true;

  declarationGroupMap(ctx).set(groupKey, functionNode.id);
  visitFunctionPayload(node, functionNode.id, ctx);
  return true;
}

const CONSTRUCTOR_DECLARATIONS = new Set([
  'data_constructor',
  'newtype_constructor',
  'gadt_constructor',
  'constructor_synonym',
]);

function handleDataDeclaration(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return true;
  const name = getNodeText(nameNode, ctx.source).trim();
  if (!name) return true;

  const typeNode = ctx.createNode(node.type === 'newtype' ? 'struct' : 'enum', name, node, {
    signature: collapseWhitespace(getNodeText(node, ctx.source)).slice(0, 400),
    docstring: getPrecedingDocstring(node, ctx.source),
    isExported: isNameExported(node, ctx.source, name),
  });
  if (!typeNode) return true;

  ctx.pushScope(typeNode.id);
  const walk = (current: SyntaxNode): void => {
    if (CONSTRUCTOR_DECLARATIONS.has(current.type)) {
      const constructorName = getChildByField(current, 'name')
        ?? firstDescendant(current, new Set(['constructor']));
      if (constructorName) {
        const constructor = getNodeText(constructorName, ctx.source).trim();
        ctx.createNode('enum_member', constructor, current, {
          signature: collapseWhitespace(getNodeText(current, ctx.source)).slice(0, 260),
          isExported: isNameExported(current, ctx.source, constructor, name),
        });
      }
      // Record fields can live below a constructor, so continue walking.
    } else if (current.type === 'field') {
      const fieldName = getChildByField(current, 'name')
        ?? firstDescendant(current, new Set(['field_name', 'variable']));
      if (fieldName) {
        const field = getNodeText(fieldName, ctx.source).trim();
        ctx.createNode('field', field, current, {
          isExported: isNameExported(current, ctx.source, field, name),
        });
      }
    }
    for (let i = 0; i < current.namedChildCount; i++) {
      const child = current.namedChild(i);
      if (child) walk(child);
    }
  };
  walk(node);
  ctx.popScope();

  for (const derived of derivedClassNames(node, ctx.source)) {
    ctx.addUnresolvedReference({
      fromNodeId: typeNode.id,
      referenceName: derived.name,
      referenceKind: 'implements',
      line: derived.node.startPosition.row + 1,
      column: derived.node.startPosition.column,
    });
  }
  return true;
}

function handleTypeAlias(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = getChildByField(node, 'name')
    ?? firstDescendant(node, new Set(['name', 'constructor']));
  if (nameNode) {
    const name = getNodeText(nameNode, ctx.source).trim();
    ctx.createNode('type_alias', name, node, {
      signature: collapseWhitespace(getNodeText(node, ctx.source)).slice(0, 400),
      docstring: getPrecedingDocstring(node, ctx.source),
      isExported: isNameExported(node, ctx.source, name),
    });
  }
  return true;
}

function handleTypeFamily(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return true;
  const patterns = getChildByField(node, 'patterns');
  const baseName = getNodeText(nameNode, ctx.source).trim();
  const name = node.type === 'type_instance' && patterns
    ? collapseWhitespace(`${baseName} ${getNodeText(patterns, ctx.source)}`)
    : baseName;
  const ownerId = ctx.nodeStack[ctx.nodeStack.length - 1] ?? '';
  const owner = ctx.nodes.find((candidate) => candidate.id === ownerId);
  ctx.createNode('type_alias', name, node, {
    signature: collapseWhitespace(getNodeText(node, ctx.source)).slice(0, 400),
    docstring: getPrecedingDocstring(node, ctx.source),
    isExported: node.type !== 'type_instance' && (
      owner?.kind === 'trait'
        ? isNameExported(node, ctx.source, baseName, owner.name)
        : isNameExported(node, ctx.source, baseName)
    ),
  });
  return true;
}

function visitDeclarationBody(node: SyntaxNode, bodyType: string, ownerId: string, ctx: ExtractorContext): void {
  const body = getChildByField(node, 'declarations')
    ?? node.namedChildren.find((child) => child.type === bodyType)
    ?? null;
  if (!body) return;
  ctx.pushScope(ownerId);
  ctx.visitNode(body);
  ctx.popScope();
}

function handleTypeclass(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return true;
  const name = getNodeText(nameNode, ctx.source).trim();
  const typeclass = ctx.createNode('trait', name, node, {
    signature: collapseWhitespace(getNodeText(node, ctx.source)).slice(0, 400),
    docstring: getPrecedingDocstring(node, ctx.source),
    isExported: isNameExported(node, ctx.source, name),
  });
  if (typeclass) {
    const context = getChildByField(node, 'context');
    const inner = context ? getChildByField(context, 'context') : null;
    const constraints = inner?.type === 'tuple' ? inner.namedChildren : inner ? [inner] : [];
    for (const constraint of constraints) {
      if (constraint.type !== 'apply') continue;
      const superclass = getChildByField(constraint, 'constructor');
      if (!superclass) continue;
      ctx.addUnresolvedReference({
        fromNodeId: typeclass.id,
        referenceName: getNodeText(superclass, ctx.source).trim(),
        referenceKind: 'extends',
        line: superclass.startPosition.row + 1,
        column: superclass.startPosition.column,
      });
    }
    visitDeclarationBody(node, 'class_declarations', typeclass.id, ctx);
  }
  return true;
}

function handleInstance(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const classNameNode = getChildByField(node, 'name');
  if (!classNameNode) return true;
  const className = getNodeText(classNameNode, ctx.source).trim();
  const patterns = getChildByField(node, 'patterns');
  const instanceName = collapseWhitespace(`${className} ${patterns ? getNodeText(patterns, ctx.source) : ''}`);
  const instanceNode = ctx.createNode('class', instanceName, node, {
    signature: collapseWhitespace(getNodeText(node, ctx.source)).slice(0, 400),
    decorators: ['haskell-instance'],
  });
  if (!instanceNode) return true;
  ctx.addUnresolvedReference({
    fromNodeId: instanceNode.id,
    referenceName: className,
    referenceKind: 'implements',
    line: classNameNode.startPosition.row + 1,
    column: classNameNode.startPosition.column,
  });
  visitDeclarationBody(node, 'instance_declarations', instanceNode.id, ctx);
  return true;
}

function handleDerivingInstance(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const classNameNode = getChildByField(node, 'name');
  if (!classNameNode) return true;
  const className = getNodeText(classNameNode, ctx.source).trim();
  const patterns = getChildByField(node, 'patterns');
  const instanceName = collapseWhitespace(`${className} ${patterns ? getNodeText(patterns, ctx.source) : ''}`);
  const instanceNode = ctx.createNode('class', instanceName, node, {
    signature: collapseWhitespace(getNodeText(node, ctx.source)).slice(0, 400),
    decorators: ['haskell-instance', 'haskell-deriving-instance'],
  });
  if (instanceNode) {
    ctx.addUnresolvedReference({
      fromNodeId: instanceNode.id,
      referenceName: className,
      referenceKind: 'implements',
      line: classNameNode.startPosition.row + 1,
      column: classNameNode.startPosition.column,
    });
  }
  return true;
}

function handleClassSignature(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const ownerId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!ownerId) return false;
  const owner = ctx.nodes.find((candidate) => candidate.id === ownerId);
  if (!owner || (owner.kind !== 'trait' && !owner.decorators?.includes('haskell-instance'))) return false;

  const nameNode = getChildByField(node, 'name');
  if (nameNode) {
    const name = getNodeText(nameNode, ctx.source).trim();
    const groupKey = declarationGroupKey(node, name, 'method', ctx);
    const existing = groupedNode(groupKey, ctx);
    if (existing) {
      extendGroupedNode(node, existing);
      return true;
    }
    const method = ctx.createNode('method', name, node, {
      signature: collapseWhitespace(getNodeText(node, ctx.source)).slice(0, 400),
      isExported: owner.kind === 'trait' && isNameExported(node, ctx.source, name, owner.name),
    });
    if (method) declarationGroupMap(ctx).set(groupKey, method.id);
  }
  return true;
}

export const haskellExtractor: LanguageExtractor = {
  // Haskell's significant declarations need clause grouping and type-position
  // filtering, so they are dispatched through visitNode rather than the generic
  // one-node-per-declaration paths.
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['import'],
  callTypes: ['apply', 'infix'],
  variableTypes: [],
  nameField: 'name',
  bodyField: 'declarations',
  paramsField: 'patterns',
  extractBareCall: extractHaskellBareCall,
  isLexicallyBound,
  higherOrderFunctionNames: HOF_NAMES,

  packageTypes: ['header'],
  extractPackage: (node, source) => {
    const moduleNode = getChildByField(node, 'module');
    return moduleNode ? getNodeText(moduleNode, source).replace(/\s+/g, '') : null;
  },

  extractImport: (node, source) => {
    const moduleNode = getChildByField(node, 'module');
    if (!moduleNode) return null;
    return {
      moduleName: getNodeText(moduleNode, source).replace(/\s+/g, ''),
      signature: collapseWhitespace(getNodeText(node, source)).slice(0, 300),
    };
  },

  visitNode: (node, ctx) => {
    switch (node.type) {
      case 'function':
        return handleFunction(node, ctx);
      case 'bind':
        return handleBind(node, ctx);
      case 'data_type':
      case 'newtype':
        return handleDataDeclaration(node, ctx);
      case 'type_synomym':
        return handleTypeAlias(node, ctx);
      case 'type_family':
      case 'type_instance':
        return handleTypeFamily(node, ctx);
      case 'class':
        return handleTypeclass(node, ctx);
      case 'instance':
        return handleInstance(node, ctx);
      case 'deriving_instance':
        return handleDerivingInstance(node, ctx);
      case 'signature':
        return handleClassSignature(node, ctx);
      default:
        return false;
    }
  },
};
