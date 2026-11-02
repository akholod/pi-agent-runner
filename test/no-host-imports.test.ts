// The compiled runner must not execute a value import of the host packages:
// they come from `bindHostRuntime`. Type-only imports are fine. No file is
// exempt: the generated child entry points in process-session.ts carry their
// imports in a template string, which is data, not an import.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Every Pi package (pi-ai, pi-agent-core, pi-coding-agent, pi-tui, ... and
// any subpath) and typebox with any subpath.
const isHostPackage = (specifier: string) =>
  specifier.startsWith('@earendil-works/') ||
  specifier === 'typebox' ||
  specifier.startsWith('typebox/');

const src = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
);

const isHost = (node: ts.Expression | undefined) =>
  node !== undefined &&
  ts.isStringLiteralLike(node) &&
  isHostPackage(node.text);

// Executable references to host packages in one file.
const violations = (file: string) => {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const found: string[] = [];
  const at = (node: ts.Node, what: string) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
    found.push(`${path.basename(file)}:${line + 1} ${what}`);
  };
  const visit = (node: ts.Node) => {
    // With verbatimModuleSyntax only `import type` / `export type` vanish;
    // `import { type X } from` still emits a bare import of the module.
    if (ts.isImportDeclaration(node) && isHost(node.moduleSpecifier)) {
      if (!node.importClause?.isTypeOnly) at(node, 'import');
    } else if (
      ts.isExportDeclaration(node) &&
      isHost(node.moduleSpecifier) &&
      !node.isTypeOnly
    ) {
      at(node, 'export from');
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      isHost(node.moduleReference.expression) &&
      !node.isTypeOnly
    ) {
      at(node, 'import =');
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'require')) &&
      isHost(node.arguments[0])
    ) {
      at(node, 'dynamic import/require');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
};

test('no executable host-package import in the converted sources', () => {
  const files = fs.readdirSync(src).filter((name) => name.endsWith('.ts'));
  for (const name of ['pane-viewer.ts', 'process-session.ts', 'child-mcp.ts']) {
    assert.ok(files.includes(name), `${name} is checked`);
  }
  assert.ok(files.includes('session.ts'));
  assert.ok(files.includes('host-runtime.ts'));
  const found = files.flatMap((name) => violations(path.join(src, name)));
  assert.deepEqual(found, []);
});

test('the checker flags the executable forms and spares type-only ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-imports-'));
  try {
    const sample = path.join(dir, 'sample.ts');
    fs.writeFileSync(
      sample,
      `import * as a from '@earendil-works/pi-coding-agent';
import { b } from 'typebox';
import type { C } from '@earendil-works/pi-tui';
import { type D } from '@earendil-works/pi-tui';
import { type E, f } from '@earendil-works/pi-tui';
export { g } from 'typebox/compile';
export type { H } from 'typebox';
const i = await import('typebox');
import '@earendil-works/pi-tui';
import { j } from '@earendil-works/pi-ai';
import { k } from '@earendil-works/pi-agent-core';
import { l } from '@earendil-works/pi-coding-agent/dist/x.js';
import { m } from 'typebox/value';
import type { N } from '@earendil-works/pi-ai';
import { o } from 'typebox-like';
import { p } from 'node:fs';
`,
    );
    assert.deepEqual(
      violations(sample).map((v) => v.split(' ').slice(1).join(' ')),
      [
        'import',
        'import',
        'import',
        'import',
        'export from',
        'dynamic import/require',
        'import',
        'import',
        'import',
        'import',
        'import',
      ],
    );
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

// The compiled output, when it has been built.
test('the built dist has no executable host-package import', (t) => {
  const dist = path.join(path.dirname(src), 'dist');
  if (!fs.existsSync(dist)) {
    t.skip('dist is not built');
    return;
  }
  const files = fs.readdirSync(dist).filter((name) => name.endsWith('.js'));
  assert.ok(files.includes('process-session.js'));
  const found = files.flatMap((name) => violations(path.join(dist, name)));
  assert.deepEqual(found, []);
});
