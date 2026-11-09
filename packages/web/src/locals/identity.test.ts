import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { identityEn, identityZhCN } from './identity';

const placeholders = (value: string) => [...value.matchAll(/\{([a-zA-Z_][\w]*)\}/g)].map((match) => match[1]).sort();

test('identity catalogs have English translations and matching placeholders', () => {
  assert.deepEqual(Object.keys(identityEn).sort(), Object.keys(identityZhCN).sort());
  for (const key of Object.keys(identityZhCN) as (keyof typeof identityZhCN)[]) {
    assert.equal(identityZhCN[key], key);
    assert.ok(identityEn[key].trim(), key);
    assert.ok(!/[\u3400-\u9fff]/u.test(identityEn[key]), `Untranslated English: ${key}`);
    assert.deepEqual(placeholders(identityEn[key]), placeholders(key), key);
  }
});

test('identity TSX surfaces contain no untranslated Chinese JSX, attributes, or confirmation options', () => {
  for (const directory of ['account', 'auth', 'administration']) {
    const base = new URL(`../components/${directory}/`, import.meta.url);
    for (const name of readdirSync(base).filter((name) => name.endsWith('.tsx'))) {
      const source = ts.createSourceFile(name, readFileSync(new URL(name, base), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node) => {
        if (ts.isJsxText(node) || (ts.isStringLiteral(node) && ts.isJsxAttribute(node.parent))) {
          assert.ok(!/[\u3400-\u9fff]/u.test(node.text), `${directory}/${name}: ${node.text.trim()}`);
        }
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'confirm') {
          const options = node.arguments[1];
          if (options && ts.isObjectLiteralExpression(options)) {
            for (const property of options.properties) {
              if (!ts.isPropertyAssignment(property) || !['title', 'confirmText'].includes(property.name.getText(source).replace(/['"]/g, ''))) continue;
              assert.ok(
                !((ts.isStringLiteral(property.initializer) || ts.isNoSubstitutionTemplateLiteral(property.initializer)) && /[\u3400-\u9fff]/u.test(property.initializer.text)),
                `${directory}/${name}: untranslated confirmation option ${property.getText(source)}`,
              );
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
});
