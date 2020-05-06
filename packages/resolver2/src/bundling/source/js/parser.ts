import { BinaryOperator, Function, Identifier, MemberExpression, Node, Pattern } from 'estree';
import { ParserFunction, Replacement, SyntaxKind } from '../../parsing';
import { SourceModuleDependency } from '../../sourceModuleDependency';
import {
  isArrayPattern,
  isArrowFunctionExpression,
  isAssignmentPattern,
  isBinaryExpression,
  isBlockStatement,
  isCallExpression,
  isClassDeclaration,
  isFunction,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isIfStatement,
  isMemberExpression,
  isNodeWithStartAndEnd,
  isObjectPattern,
  isProgram,
  isProperty,
  isRestElement,
  isStringLiteral,
  isThisExpression,
  isTryStatement,
  isVariableDeclaration,
  NodeWithParent,
  NodeWithStartAndEnd,
  parse as parseAst,
} from './ast';
import { traverse, Visitor } from './traverse';

export const parse: ParserFunction = function parseJavaScript(
  ctx,
  uri,
  data,
  options
): ReturnType<ParserFunction> {
  const visitorCtx: DependencyVisitorContext = Object.assign(Object.create(null), {
    unboundSymbols: new Map(),
    locals: new Map(),
    nodeEnv: options.nodeEnv,
    replacedSymbols: new Set<Identifier>(),
    replacements: [],
    requires: [],
    requireResolves: [],
    skip: new Set(),
  });

  const result: ReturnType<ParserFunction> = {
    code: ctx.decoder.decode(data),
    dependencies: [],
    replacements: visitorCtx.replacements,
    syntax: SyntaxKind.JavaScript,
  };

  try {
    const ast = parseAst(result.code, {
      onComment: (_isBlock, _test, start, end) => {
        result.replacements.push({ start, end, replacement: '' });
      },
      // onToken: (token) => {
      //   magicString.addSourcemapLocation(token.start);
      // },
    });

    traverse(ast, visitorCtx, scopingAndRequiresVisitor);
    traverse(ast, visitorCtx, collectGlobalsVisitor);
  } catch (err) {
    throw new Error(`Error parsing ${uri}: ${err.message}`);
  }

  // Handle explicit requires
  const requiresBySpec = new Map<string, Array<{ start: number; end: number }>>();
  for (const requireDependency of visitorCtx.requires) {
    let locations = requiresBySpec.get(requireDependency.spec.value);
    if (!locations) {
      locations = [];
      requiresBySpec.set(requireDependency.spec.value, locations);
    }

    locations.push({ start: requireDependency.spec.start, end: requireDependency.spec.end });
  }
  for (const [spec, locations] of requiresBySpec) {
    result.dependencies.push(SourceModuleDependency.fromRequire(spec, locations));
  }

  // Handle require.resolve
  const requireResolvesBySpec = new Map<string, Array<{ start: number; end: number }>>();
  for (const requireDependency of visitorCtx.requireResolves) {
    let locations = requiresBySpec.get(requireDependency.spec.value);
    if (!locations) {
      locations = [];
      requiresBySpec.set(requireDependency.spec.value, locations);
    }

    locations.push({ start: requireDependency.spec.start, end: requireDependency.spec.end });
  }
  for (const [spec, locations] of requireResolvesBySpec) {
    result.dependencies.push(SourceModuleDependency.fromRequireResolve(spec, locations));
  }

  for (const [symbolName, locations] of visitorCtx.unboundSymbols) {
    const shim = options.globalModules[symbolName];

    if (shim) {
      result.dependencies.push(
        SourceModuleDependency.fromGloblaObject(shim.spec, locations, shim.export)
      );
    }
  }

  return result;
};

export type CommonJsRequire = {
  callee: { start: number; end: number };
  spec: { start: number; end: number; value: string };
};

export type CommonJsRequireResolve = {
  callee: { start: number; end: number };
  spec: { start: number; end: number; value: string };
};

export type DependencyVisitorContext = {
  readonly unboundSymbols: Map<string, NodeWithStartAndEnd[]>;
  readonly locals: Map<Node, { [identifier: string]: boolean }>;
  readonly nodeEnv: string;
  readonly requires: CommonJsRequire[];
  readonly replacedSymbols: Set<Identifier>;
  readonly replacements: Replacement[];
  readonly requireResolves: CommonJsRequireResolve[];
  readonly skip: Set<Node>;
};

export const scopingAndRequiresVisitor: Visitor<DependencyVisitorContext> = {
  enter(node, parent, ctx) {
    if (ctx.skip.has(node)) {
      return this.skip();
    }

    visitAndCaptureScoping(node, parent, ctx);
    visitAndSkipBranches(node, parent, ctx);
    visitRequires(node, parent, ctx);
  },
};

export const collectGlobalsVisitor: Visitor<DependencyVisitorContext> = {
  enter(node, _parent, ctx) {
    if (isBindingIdentifier(node) && isIdentifier(node)) {
      var name = node.name;
      if (name === 'undefined') return;
      if (ctx.replacedSymbols.has(node)) {
        return;
      }

      let foundBinding = false;
      let nextParent = node.parent;

      while (nextParent) {
        if (name === 'arguments' && declaresArguments(nextParent)) {
          foundBinding = true;
          break;
        }

        const locals = ctx.locals.get(nextParent);

        if (locals && locals[name]) {
          foundBinding = true;
          break;
        }

        nextParent = nextParent.parent;
      }

      if (!foundBinding && isNodeWithStartAndEnd(node)) {
        let unboundSymbols = ctx.unboundSymbols.get(name);
        if (!unboundSymbols) {
          unboundSymbols = [];
          ctx.unboundSymbols.set(name, unboundSymbols);
        }
        unboundSymbols.push(node);
      }
    } else if (isThisExpression(node)) {
      let foundBinding = false;
      let nextParent = node.parent;

      while (nextParent) {
        if (declaresThis(nextParent)) {
          foundBinding = true;
          break;
        }

        nextParent = nextParent.parent;
      }

      if (!foundBinding && isNodeWithStartAndEnd(node)) {
        let unboundSymbols = ctx.unboundSymbols.get('this');
        if (!unboundSymbols) {
          unboundSymbols = [];
          ctx.unboundSymbols.set('this', unboundSymbols);
        }
        unboundSymbols.push(node);
      }
    }
  },
};

function visitAndCaptureScoping(
  node: NodeWithParent,
  _parent: NodeWithParent | null,
  ctx: DependencyVisitorContext
) {
  if (isVariableDeclaration(node)) {
    let parent: NodeWithParent | undefined;
    let nextParent = node.parent;

    while (nextParent) {
      if (node.kind === 'var' ? isScope(nextParent) : isBlockScope(nextParent)) {
        parent = nextParent;
        break;
      }

      nextParent = nextParent.parent;
    }

    if (!parent) {
      throw new Error(`Invariant violation: Failed to find a parent`);
    }

    let locals = ctx.locals.get(parent);

    if (!locals) {
      locals = {};
      ctx.locals.set(parent, locals);
    }

    for (const declaration of node.declarations) {
      declarePattern(declaration.id, locals);
    }
  } else if (isFunctionDeclaration(node)) {
    let parent: NodeWithParent | undefined;
    let nextParent = node.parent;

    if (nextParent && nextParent.parent) {
      nextParent = nextParent.parent;
    }

    while (nextParent) {
      if (isScope(nextParent)) {
        parent = nextParent;
        break;
      }

      nextParent = nextParent.parent;
    }

    if (!parent) {
      throw new Error(`Invariant violation: Failed to find a parent`);
    }

    let locals = ctx.locals.get(parent);

    if (!locals) {
      locals = {};
      ctx.locals.set(parent, locals);
    }

    declareFunction(node, locals);
  } else if (isFunction(node)) {
    let locals = ctx.locals.get(node);

    if (!locals) {
      locals = {};
      ctx.locals.set(node, locals);
    }

    declareFunction(node, locals);
  } else if (isClassDeclaration(node) && node.id) {
    let parent: NodeWithParent | undefined;
    let nextParent = node.parent;

    if (nextParent && nextParent.parent) {
      nextParent = nextParent.parent;
    }

    while (nextParent) {
      if (isScope(nextParent)) {
        parent = nextParent;
        break;
      }

      nextParent = nextParent.parent;
    }

    if (!parent) {
      throw new Error(`Invariant violation: Failed to find a parent`);
    }

    let locals = ctx.locals.get(parent);

    if (!locals) {
      locals = {};
      ctx.locals.set(parent, locals);
    }

    locals[node.id.name] = true;
  } else if (isTryStatement(node)) {
    if (node.handler) {
      let locals = ctx.locals.get(node.handler);

      if (!locals) {
        locals = {};
        ctx.locals.set(node.handler, locals);
      }

      if (node.handler.param) {
        declarePattern(node.handler.param, locals);
      }
    }
  }
}

function visitAndSkipBranches(
  node: NodeWithParent,
  _parent: NodeWithParent | null,
  ctx: DependencyVisitorContext
) {
  if (isIfStatement(node) && isBinaryExpression(node.test)) {
    const tests = {
      '!=': (l: string, r: string) => l != r,
      '!==': (l: string, r: string) => l !== r,
      '==': (l: string, r: string) => l == r,
      '===': (l: string, r: string) => l === r,
    } as { [key in BinaryOperator]: (l: string, r: string) => boolean };
    const test = tests[node.test.operator];

    if (test) {
      if (
        isStringLiteral(node.test.left) &&
        isMemberExpression(node.test.right) &&
        memberExpressionMatches(node.test.right, 'process.env.NODE_ENV')
      ) {
        let rootObject = node.test.right;
        while (isMemberExpression(rootObject.object)) {
          rootObject = rootObject.object;
        }
        if (isIdentifier(rootObject.object)) {
          ctx.replacedSymbols.add(rootObject.object);
        }
        // if ('development' === process.env.NODE_ENV) {}
        ctx.replacements.push({
          start: (node.test.right as any).start,
          end: (node.test.right as any).end,
          replacement: JSON.stringify(ctx.nodeEnv),
        });

        if (!test(node.test.left.value, ctx.nodeEnv)) {
          ctx.skip.add(node.consequent);
        } else if (node.alternate) {
          ctx.skip.add(node.alternate);
        }
      } else if (
        isStringLiteral(node.test.right) &&
        isMemberExpression(node.test.left) &&
        memberExpressionMatches(node.test.left, 'process.env.NODE_ENV')
      ) {
        let rootObject = node.test.left;
        while (isMemberExpression(rootObject.object)) {
          rootObject = rootObject.object;
        }
        if (isIdentifier(rootObject.object)) {
          ctx.replacedSymbols.add(rootObject.object);
        } // if (process.env.NODE_ENV === 'development') {}
        ctx.replacements.push({
          start: (node.test.left as any).start,
          end: (node.test.left as any).end,
          replacement: JSON.stringify(ctx.nodeEnv),
        });

        if (!test(node.test.right.value, ctx.nodeEnv)) {
          ctx.skip.add(node.consequent);
        } else if (node.alternate) {
          ctx.skip.add(node.alternate);
        }
      }
    }
  }
}

function visitRequires(
  node: NodeWithParent,
  _parent: NodeWithParent | null,
  ctx: DependencyVisitorContext
) {
  if (isCallExpression(node) && isNodeWithStartAndEnd(node.callee)) {
    const callee = node.callee;
    if (isIdentifier(callee) && isNodeWithStartAndEnd(callee) && callee.name === 'require') {
      const firstArg = node.arguments[0];

      if (isStringLiteral(firstArg) && isNodeWithStartAndEnd(firstArg)) {
        ctx.requires.push({
          spec: { start: firstArg.start, end: firstArg.end, value: firstArg.value },
          callee: { start: callee.start, end: callee.end },
        });
      } else {
        console.warn('Non string-literal first arg to require', firstArg);
      }
    } else if (
      isMemberExpression(callee) &&
      isIdentifier(callee.object) &&
      callee.object.name === 'require' &&
      isIdentifier(callee.property) &&
      callee.property.name === 'resolve'
    ) {
      const firstArg = node.arguments[0];

      if (isStringLiteral(firstArg) && isNodeWithStartAndEnd(firstArg)) {
        ctx.requireResolves.push({
          spec: { start: firstArg.start, end: firstArg.end, value: firstArg.value },
          callee: { start: callee.start, end: callee.end },
        });
      } else {
        console.warn('Non string-literal first arg to require.resolve', firstArg);
      }
    }
  }
}

function declareFunction(node: Function, locals: { [name: string]: boolean }) {
  node.params.forEach(function (node) {
    declarePattern(node, locals);
  });
  if ((node as any).id) {
    locals[(node as any).id.name] = true;
  }
}

function declarePattern(node: Pattern, locals: { [name: string]: boolean }) {
  if (isIdentifier(node)) {
    locals[node.name] = true;
  } else if (isObjectPattern(node)) {
    node.properties.forEach((node) =>
      isRestElement(node)
        ? declarePattern(node.argument, locals)
        : declarePattern(node.value, locals)
    );
  } else if (isArrayPattern(node)) {
    node.elements.forEach((node) => node && declarePattern(node, locals));
  } else if (isRestElement(node)) {
    declarePattern(node.argument, locals);
  } else if (isAssignmentPattern(node)) {
    declarePattern(node.left, locals);
  } else {
    throw new Error(`Invariant violation: Unexpected pattern type: ${node.type}`);
  }
}

function isBindingIdentifier(node: NodeWithParent) {
  return isIdentifier(node) && !isPropertyOfMemberExpression(node) && !isKeyOfProperty(node);
}

function isKeyOfProperty(node: NodeWithParent) {
  return node.parent && isProperty(node.parent) && node.parent.key === node;
}

function isPropertyOfMemberExpression(node: NodeWithParent) {
  return node.parent && isMemberExpression(node.parent) && node.parent.object !== node;
}

function isScope(node: NodeWithParent) {
  return (
    isFunctionDeclaration(node) ||
    isFunctionExpression(node) ||
    isArrowFunctionExpression(node) ||
    isProgram(node)
  );
}

function isBlockScope(node: NodeWithParent) {
  return isBlockStatement(node) || isScope(node);
}

function declaresArguments(node: NodeWithParent) {
  return isFunctionDeclaration(node) || isFunctionExpression(node);
}

function declaresThis(node: NodeWithParent) {
  return isFunctionDeclaration(node) || isFunctionExpression(node);
}

function memberExpressionMatches(node: MemberExpression, pattern: string) {
  const memberParts = pattern.split('.');

  if (memberParts.length < 2) {
    return false;
  }

  const object = memberParts.shift();
  const property = memberParts.shift();

  for (let i = memberParts.length - 1; i >= 0; i--) {
    if (!isIdentifier(node.property) || node.property.name !== memberParts[i]) {
      return false;
    }

    if (!isMemberExpression(node.object)) {
      return false;
    }

    node = node.object;
  }

  if (!isIdentifier(node.object) || !isIdentifier(node.property)) {
    return false;
  }

  return node.object.name === object && node.property.name === property;
}