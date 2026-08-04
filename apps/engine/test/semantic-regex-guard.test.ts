import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const semanticFiles = [
  'apps/engine/src/agents/orchestrator.ts',
  'apps/engine/src/agents/orchestrator-final-response.ts',
  'apps/engine/src/agents/pending-interaction-disposition.ts',
  'apps/engine/src/budgeting/budgeting-request.ts',
  'packages/runtime/src/agents/mastra-structured-agent-adapter.ts',
  'packages/contracts/src/working-memory-response.ts',
] as const;

const semanticOrchestratorMethods = [
  'classifyPendingInteractionInput',
  'generateWorkingMemoryReply',
  'generateSemanticContract',
] as const;

function regularExpressionNodes(sourceFile: ts.SourceFile, root: ts.Node = sourceFile): ts.Node[] {
  const violations: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral
      || (ts.isNewExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === 'RegExp')) {
      violations.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return violations;
}

function methodNodes(sourceFile: ts.SourceFile): ts.Node[] {
  const methods: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node)
      && node.name !== undefined
      && ts.isIdentifier(node.name)
      && semanticOrchestratorMethods.includes(node.name.text as typeof semanticOrchestratorMethods[number])) {
      methods.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return methods;
}

describe('semantic no-regex guard', () => {
  it('keeps natural-language contracts and budget interpretation free of regex construction', () => {
    const violations = semanticFiles.flatMap((relativePath) => {
      const absolutePath = resolve(repositoryRoot, relativePath);
      const sourceFile = ts.createSourceFile(
        absolutePath,
        readFileSync(absolutePath, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      return regularExpressionNodes(sourceFile).map((node) => `${relativePath}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    });

    expect(violations).toEqual([]);
  });

  it('keeps the pending classifier and Working Memory reply generators free of regex construction', () => {
    const absolutePath = resolve(repositoryRoot, 'apps/engine/src/agents/orchestrator.ts');
    const sourceFile = ts.createSourceFile(
      absolutePath,
      readFileSync(absolutePath, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const violations = methodNodes(sourceFile).flatMap((method) =>
      regularExpressionNodes(sourceFile, method).map((node) =>
        `${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`));

    expect(violations).toEqual([]);
  });
});
