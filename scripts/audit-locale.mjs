#!/usr/bin/env node
/** Static i18n guard, not proof of complete localization. No runtime/user text is rewritten.
 * node scripts/audit-locale.mjs [--json] [--summary]
 * Default report includes every remaining Han literal for human review (no allowlist).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HAN = /\p{Script=Han}/u;
const VISIBLE_ATTRIBUTES = /^(?:title|placeholder|aria-label|aria-description|aria-valuetext|alt|description|label|tooltip|helperText|hint|emptyText|loadingText|errorMessage|message|caption|summary|heading|subtitle|buttonText|confirmText|cancelText|okText|text)$/i;
export const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const unwrap = (node) => {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
    || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node))) node = node.expression;
  return node;
};
const literalText = (node) => ts.isStringLiteralLike(node) || ts.isJsxText(node)
  || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
  ? node.text : ts.isRegularExpressionLiteral(node) ? node.text : undefined;
const callName = (node) => ts.isIdentifier(node) ? node.text
  : ts.isPropertyAccessExpression(node) ? node.name.text : '';
const placeholders = (value) => [...value.matchAll(/\{([a-zA-Z_][\w]*)\}/g)].map((match) => match[1]).sort();
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** Check the literal catalog values, not source spelling or line-based exemptions. */
export function auditCatalogs(catalogs) {
  const errors = [];
  for (const [name, { zh, en }] of Object.entries(catalogs)) {
    for (const key of new Set([...Object.keys(zh), ...Object.keys(en)])) {
      const item = { file: `locals/${name}`, line: 1, column: 1, text: key };
      if (!own(zh, key) || !own(en, key)) {
        errors.push({ ...item, category: 'dictionary-key-parity' });
        continue;
      }
      if (typeof zh[key] !== 'string' || typeof en[key] !== 'string' || !en[key].trim()) {
        errors.push({ ...item, category: 'dictionary-invalid-value' });
        continue;
      }
      if (HAN.test(en[key])) errors.push({ ...item, category: 'dictionary-english-han', text: en[key] });
      if (!same(placeholders(zh[key]), placeholders(en[key])))
        errors.push({ ...item, category: 'dictionary-placeholder-parity' });
    }
  }
  return errors;
}

/** Inspect direct render expressions, not comparisons, call arguments or user data. */
function renderedLiterals(node, visit) {
  node = unwrap(node);
  if (!node) return;
  if (ts.isStringLiteralLike(node)) visit(node);
  else if (ts.isTemplateExpression(node)) {
    visit(node.head);
    for (const span of node.templateSpans) { renderedLiterals(span.expression, visit); visit(span.literal); }
  } else if (ts.isConditionalExpression(node)) {
    renderedLiterals(node.whenTrue, visit); renderedLiterals(node.whenFalse, visit);
  } else if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if ([ts.SyntaxKind.PlusToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(op))
      renderedLiterals(node.left, visit);
    if ([ts.SyntaxKind.PlusToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken,
      ts.SyntaxKind.AmpersandAmpersandToken].includes(op)) renderedLiterals(node.right, visit);
  } else if (ts.isArrayLiteralExpression(node)) {
    node.elements.forEach((element) => renderedLiterals(element, visit));
  }
}

/** Exposed for fixture tests; catalogs.main is the actual merged t() dictionary. */
export function auditSource(text, file = 'fixture.tsx', catalogs = {}) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const violations = [], review = [], translations = [], covered = new Set();
  // Only AppDialog's useConfirm API: similarly named business APIs must not be treated as UI.
  const confirmHooks = new Set(), confirmBindings = new Set();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && /(?:^|\/)AppDialog(?:\.[cm]?[jt]sx?)?$/.test(statement.moduleSpecifier.text)
      && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
      for (const binding of statement.importClause.namedBindings.elements)
        if ((binding.propertyName ?? binding.name).text === 'useConfirm') confirmHooks.add(binding.name.text);
    }
  }
  const findConfirmBindings = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const initializer = unwrap(node.initializer);
      if (initializer && ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression)
        && confirmHooks.has(initializer.expression.text)) confirmBindings.add(node.name.text);
    }
    ts.forEachChild(node, findConfirmBindings);
  };
  findConfirmBindings(source);
  const entry = (node, category, value = literalText(node)) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    return { file, line: line + 1, column: character + 1, category, text: value ?? node.getText(source) };
  };
  const visible = (node, category) => {
    if (HAN.test(literalText(node) ?? '')) {
      violations.push(entry(node, category)); covered.add(node);
    }
  };
  const scan = (node) => {
    if (ts.isJsxText(node)) visible(node, 'jsx-text');
    if (ts.isJsxAttribute(node) && VISIBLE_ATTRIBUTES.test(node.name.getText(source))) {
      const initializer = node.initializer;
      if (initializer) renderedLiterals(ts.isJsxExpression(initializer) ? initializer.expression : initializer,
        (literal) => visible(literal, 'jsx-visible-attribute'));
    }
    if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent))
      renderedLiterals(node.expression, (literal) => visible(literal, 'jsx-expression'));
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression);
      if (ts.isIdentifier(node.expression) && confirmBindings.has(name)) {
        renderedLiterals(node.arguments[0], (literal) => visible(literal, 'dialog-message'));
        const inspectOptions = (options) => {
          options = unwrap(options);
          if (!options) return;
          if (ts.isConditionalExpression(options)) {
            inspectOptions(options.whenTrue); inspectOptions(options.whenFalse);
          } else if (ts.isObjectLiteralExpression(options)) {
            for (const property of options.properties) {
              if (ts.isPropertyAssignment(property) && ['title', 'confirmText', 'cancelText'].includes(property.name.text))
                renderedLiterals(property.initializer, (literal) => visible(literal, 'dialog-visible-option'));
              else if (ts.isSpreadAssignment(property)) review.push(entry(property, 'dialog-options-spread'));
            }
          } else review.push(entry(options, 'dynamic-dialog-options'));
        };
        inspectOptions(node.arguments[1]);
      }
      if (name === 'copy' && node.arguments.length >= 2)
        violations.push(entry(node, 'copy-bypass'));
      if (name === 't' || name === 'runtimeT') {
        const argument = unwrap(node.arguments[0]);
        if (argument && ts.isStringLiteralLike(argument)) {
          covered.add(argument);
          const key = argument.text;
          const catalog = name === 'runtimeT' ? catalogs.runtime : catalogs.main;
          translations.push(entry(argument, 'translation-key', key));
          if (!catalog || !own(catalog.zh, key) || !own(catalog.en, key))
            violations.push(entry(argument, 'missing-translation-key', key));
          const required = placeholders(catalog?.zh[key] ?? key);
          const values = unwrap(node.arguments[1]);
          if (required.length && (!values || ts.isObjectLiteralExpression(values))) {
            const supplied = new Set(values?.properties.filter(ts.isPropertyAssignment)
              .map((property) => property.name.text) ?? []);
            for (const property of values?.properties ?? [])
              if (ts.isShorthandPropertyAssignment(property)) supplied.add(property.name.text);
            if (values?.properties.some(ts.isSpreadAssignment))
              review.push(entry(node, 'interpolation-values-spread'));
            else if (required.some((name) => !supplied.has(name)))
              violations.push(entry(node, 'missing-interpolation-value'));
          } else if (required.length) review.push(entry(node, 'dynamic-interpolation-values'));
        } else {
          review.push(entry(node, 'dynamic-translation-key'));
          // Conditional literal keys are still keys; Chinese nested expressions remain in inventory.
          renderedLiterals(argument, (candidate) => {
            if (!ts.isStringLiteralLike(candidate)) return;
            const catalog = name === 'runtimeT' ? catalogs.runtime : catalogs.main;
            translations.push(entry(candidate, 'conditional-translation-key'));
            if (!catalog || !own(catalog.zh, candidate.text) || !own(catalog.en, candidate.text))
              violations.push(entry(candidate, 'missing-translation-key'));
          });
          const nested = (child) => {
            if (ts.isCallExpression(child) && ['t', 'runtimeT'].includes(callName(child.expression)))
              violations.push(entry(child, 'nested-translation-key'));
            ts.forEachChild(child, nested);
          };
          if (argument) nested(argument);
        }
      }
    }
    ts.forEachChild(node, scan);
  };
  scan(source);
  const inventory = (node) => {
    const value = literalText(node);
    if (value !== undefined && HAN.test(value) && !covered.has(node)) {
      const parent = node.parent;
      let category = 'other-literal';
      if (ts.isRegularExpressionLiteral(node)) category = 'regex';
      else if (ts.isLiteralTypeNode(parent)) category = 'type-or-business-enum';
      else if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node)
        category = 'property-key';
      else if (ts.isBinaryExpression(parent) && [ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken].includes(parent.operatorToken.kind)) category = 'comparison-or-business-enum';
      else if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) category = 'call-argument-or-runtime-message';
      else if (ts.isPropertyAssignment(parent) || ts.isVariableDeclaration(parent)) category = 'data-or-display-config';
      else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) category = 'template-fragment';
      review.push(entry(node, category, value));
    }
    ts.forEachChild(node, inventory);
  };
  inventory(source);
  for (const diagnostic of source.parseDiagnostics)
    violations.push(entry(source, 'parse-error', ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')));
  return { violations, review, translations };
}

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => entry.isDirectory() ? sourceFiles(path.join(directory, entry.name))
      : entry.isFile() && /\.tsx?$/.test(entry.name) ? [path.join(directory, entry.name)] : []);
}

/** Evaluate only declarative dictionary ASTs; never import/execute application code. */
export function loadCatalogs(root = defaultRoot) {
  const directory = path.join(root, 'packages/web/src/locals');
  const modules = new Map(), cache = new Map();
  function moduleAt(file) {
    if (modules.has(file)) return modules.get(file);
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const module = { bindings: new Map(), imports: new Map(), exports: new Set() };
    modules.set(file, module);
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings
        && ts.isNamedImports(statement.importClause.namedBindings)) {
        for (const binding of statement.importClause.namedBindings.elements)
          module.imports.set(binding.name.text, { file: path.resolve(path.dirname(file), `${statement.moduleSpecifier.text}.ts`),
            name: (binding.propertyName ?? binding.name).text });
      }
      if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          module.bindings.set(declaration.name.text, declaration.initializer);
          if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
            module.exports.add(declaration.name.text);
        }
      }
    }
    return module;
  }
  function binding(file, name, active = new Set()) {
    const key = `${file}:${name}`;
    if (cache.has(key)) return cache.get(key);
    if (active.has(key)) throw new Error(`Circular dictionary binding: ${key}`);
    const next = new Set([...active, key]), module = moduleAt(file);
    const imported = module.imports.get(name);
    const value = imported ? binding(imported.file, imported.name, next)
      : evaluate(module.bindings.get(name), file, next);
    cache.set(key, value);
    return value;
  }
  function evaluate(node, file, active) {
    node = unwrap(node);
    if (!node) throw new Error(`Unresolved dictionary binding in ${file}`);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isIdentifier(node)) return binding(file, node.text, active);
    if (ts.isObjectLiteralExpression(node)) {
      const object = Object.create(null);
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) Object.assign(object, evaluate(property.expression, file, active));
        else if (ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name))
          object[property.name.text] = evaluate(property.initializer, file, active);
        else throw new Error(`Unsupported dictionary member in ${file}: ${property.getText()}`);
      }
      return object;
    }
    throw new Error(`Unsupported dictionary expression in ${file}: ${node.getText()}`);
  }
  const catalogs = {};
  for (const file of sourceFiles(directory).filter((file) => !/\.(?:test|spec)\.tsx?$/.test(file))) {
    const module = moduleAt(file);
    for (const name of module.exports) if (name === 'zhCN' || name.endsWith('ZhCN')) {
      const prefix = name === 'zhCN' ? '' : name.slice(0, -4);
      const english = prefix ? `${prefix}En` : 'en';
      if (!module.exports.has(english)) throw new Error(`Missing English dictionary ${english} in ${file}`);
      catalogs[prefix || 'main'] = { zh: binding(file, name), en: binding(file, english) };
    }
  }
  if (!catalogs.main) throw new Error('No main zhCN/en dictionaries found');
  return catalogs;
}

export function auditRepository(root = defaultRoot) {
  const catalogs = loadCatalogs(root);
  const report = { violations: auditCatalogs(catalogs), review: [], translations: [], files: 0,
    catalogKeys: Object.fromEntries(Object.entries(catalogs).map(([name, pair]) => [name, Object.keys(pair.zh).length])) };
  const sourceRoot = path.join(root, 'packages/web/src');
  for (const file of sourceFiles(sourceRoot)) {
    const relative = path.relative(sourceRoot, file).replaceAll('\\', '/');
    if (relative.startsWith('locals/') || /(?:^|\/)(?:__tests__|tests)(?:\/|$)/.test(relative)
      || /\.(?:test|spec)\.tsx?$/.test(relative)) continue;
    const result = auditSource(fs.readFileSync(file, 'utf8'), `packages/web/src/${relative}`, catalogs);
    report.files++;
    for (const key of ['violations', 'review', 'translations']) report[key].push(...result[key]);
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => !['--json', '--summary'].includes(arg))) throw new Error('Usage: node scripts/audit-locale.mjs [--json] [--summary]');
    const report = auditRepository();
    if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`Locale AST audit: ${report.files} files, ${report.translations.length} literal translation calls, ${report.violations.length} violations, ${report.review.length} remaining literals/expressions for review.`);
      console.log(`Catalog keys: ${JSON.stringify(report.catalogKeys)}`);
      for (const item of report.violations) console.log(`ERROR ${item.file}:${item.line}:${item.column} [${item.category}] ${JSON.stringify(item.text)}`);
      const categories = Object.fromEntries([...new Set(report.review.map((item) => item.category))].sort()
        .map((category) => [category, report.review.filter((item) => item.category === category).length]));
      console.log(`Review categories (not exemptions): ${JSON.stringify(categories)}`);
      if (!args.includes('--summary')) for (const item of report.review)
        console.log(`REVIEW ${item.file}:${item.line}:${item.column} [${item.category}] ${JSON.stringify(item.text)}`);
      console.log('Static scanning is supplementary: dynamic labels, indirect configuration, server messages and user content require human/runtime review. Never translate user content. Locations are diagnostics, never exemptions.');
    }
    process.exitCode = report.violations.length ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
