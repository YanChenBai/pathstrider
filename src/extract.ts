import { parseSync, Visitor } from 'vite';
import type { ESTree } from 'vite';

type Expression = ESTree.Expression;
type Node = ESTree.Node;
type VariableDeclarator = ESTree.VariableDeclarator;

export function extractContract(code: string, filename: string): string | undefined {
  const parsed = parseSync(filename, code);
  if (parsed.errors.length) {
    throw new Error(`${filename}: ${parsed.errors.map(error => error.message).join('; ')}`);
  }
  const declarations = new Map<string, { node: VariableDeclarator; kind: string }>();
  const macroNames = new Set(['defineValidatedHandler']);
  for (const statement of parsed.program.body) {
    const declaration =
      statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type === 'VariableDeclaration') {
      for (const node of declaration.declarations) {
        if (node.id.type === 'Identifier')
          declarations.set(node.id.name, { node, kind: declaration.kind });
      }
    }
    if (statement.type === 'ImportDeclaration') {
      for (const specifier of statement.specifiers) {
        if (
          specifier.type === 'ImportSpecifier' &&
          specifier.imported.type === 'Identifier' &&
          specifier.imported.name === 'defineValidatedHandler'
        )
          macroNames.add(specifier.local.name);
      }
    }
  }
  const exported = parsed.program.body.find(
    statement => statement.type === 'ExportDefaultDeclaration',
  );
  if (!exported || exported.type !== 'ExportDefaultDeclaration') return;
  const call = unwrap(exported.declaration);
  if (
    call.type !== 'CallExpression' ||
    call.callee.type !== 'Identifier' ||
    !macroNames.has(call.callee.name)
  )
    return;

  let argument: Node | undefined = call.arguments[0] && unwrap(call.arguments[0]);
  const seen = new Set<string>();
  while (argument?.type === 'Identifier') {
    if (seen.has(argument.name)) throw new Error(`${filename}: circular handler options`);
    seen.add(argument.name);
    const initializer: Expression | null | undefined = declarations.get(argument.name)?.node.init;
    argument = initializer ? unwrap(initializer) : undefined;
  }
  if (argument?.type !== 'ObjectExpression') {
    throw new Error(`${filename}: handler options must be an object literal or a local const`);
  }

  const properties: string[] = [];
  const needed = new Set<string>();
  for (const property of argument.properties) {
    if (property.type === 'SpreadElement' || property.computed) {
      throw new Error(`${filename}: computed keys and spreads in handler options are unsupported`);
    }
    const name =
      property.key.type === 'Identifier'
        ? property.key.name
        : code.slice(property.key.start, property.key.end).replace(/^['"]|['"]$/g, '');
    if (!['validate', 'responses', 'openAPI'].includes(name)) continue;
    if (property.method || property.kind !== 'init')
      throw new Error(`${filename}: ${name} must be a schema declaration`);
    properties.push(code.slice(property.start, property.end));
    collectReferences(property.value, needed, parsed.program);
  }
  for (const name of needed) {
    const declaration = declarations.get(name);
    if (declaration?.node.init) collectReferences(declaration.node.init, needed, parsed.program);
  }

  const imports: string[] = [];
  const constants: string[] = [];
  for (const statement of parsed.program.body) {
    if (statement.type === 'ImportDeclaration' && statement.importKind !== 'type') {
      const selected = statement.specifiers.filter(
        specifier =>
          needed.has(specifier.local.name) &&
          (specifier.type !== 'ImportSpecifier' || specifier.importKind !== 'type'),
      );
      const parts = selected
        .filter(specifier => specifier.type !== 'ImportSpecifier')
        .map(specifier =>
          specifier.type === 'ImportNamespaceSpecifier'
            ? `* as ${specifier.local.name}`
            : specifier.local.name,
        );
      const named = selected.filter(specifier => specifier.type === 'ImportSpecifier');
      if (named.length)
        parts.push(
          `{ ${named.map(specifier => code.slice(specifier.start, specifier.end)).join(', ')} }`,
        );
      if (parts.length)
        imports.push(
          `import ${parts.join(', ')} from ${code.slice(statement.source.start, statement.end)}`,
        );
    }
    const declaration =
      statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type === 'VariableDeclaration') {
      for (const node of declaration.declarations) {
        if (node.id.type === 'Identifier' && needed.has(node.id.name)) {
          if (declaration.kind !== 'const' || !node.init) {
            throw new Error(
              `${filename}: schema dependencies must be initialized const declarations`,
            );
          }
          constants.push(`const ${node.id.name} = ${code.slice(node.init.start, node.init.end)};`);
        }
      }
    }
  }
  return [...imports, ...constants, `export default {${properties.join(',')}};`].join('\n');
}

function unwrap(node: Node): Node {
  if (
    node.type === 'ParenthesizedExpression' ||
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSNonNullExpression'
  ) {
    return unwrap(node.expression);
  }
  return node;
}

function collectReferences(node: Node, names: Set<string>, program: ESTree.Program): void {
  const ignored = new WeakSet<Node>();
  const typeRanges: { start: number; end: number }[] = [];
  const visitor = new Visitor({
    MemberExpression(member) {
      if (!member.computed) ignored.add(member.property);
    },
    Property(property) {
      if (!property.computed && !property.shorthand) ignored.add(property.key);
    },
    TSAsExpression(expression) {
      typeRanges.push(expression.typeAnnotation);
    },
    TSSatisfiesExpression(expression) {
      typeRanges.push(expression.typeAnnotation);
    },
    Identifier(identifier) {
      if (identifier.typeAnnotation) typeRanges.push(identifier.typeAnnotation);
      if (
        !ignored.has(identifier) &&
        !typeRanges.some(range => identifier.start >= range.start && identifier.end <= range.end)
      )
        names.add(identifier.name);
    },
  });
  visitor.visit({
    ...program,
    body: [
      {
        type: 'ExpressionStatement',
        expression: node as Expression,
        start: node.start,
        end: node.end,
      },
    ],
  });
}
