import { readdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const workspaceRoot = resolve(import.meta.dirname, '..');
const sourceRoots = ['apps', 'packages', 'test'] as const;

async function generatedJavaScriptSiblings(): Promise<string[]> {
  const files: string[] = [];
  for (const root of sourceRoots) await collect(resolve(workspaceRoot, root), files);
  return files.sort();
}

async function collect(directory: string, files: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.mastra') continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await collect(path, files);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const typeScriptPath = `${path.slice(0, -3)}.ts`;
    if (await exists(typeScriptPath)) files.push(path);
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function clearWorkspacePackageCaches(): Promise<number> {
  const packageEntries = await readdir(resolve(workspaceRoot, 'packages'), { withFileTypes: true });
  let removed = 0;
  for (const entry of packageEntries) {
    if (!entry.isDirectory()) continue;
    const cache = resolve(workspaceRoot, 'packages', entry.name, 'node_modules', '.cache');
    if (!await exists(cache)) continue;
    await rm(cache, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

async function main(): Promise<void> {
  let generated = await generatedJavaScriptSiblings();
  if (process.argv.includes('--clean')) {
    for (const file of generated) await rm(file, { force: true });
    const cacheCount = await clearWorkspacePackageCaches();
    console.info(`Removed ${generated.length} generated JavaScript siblings and ${cacheCount} workspace package caches.`);
    generated = await generatedJavaScriptSiblings();
  }
  if (process.argv.includes('--prepare')) {
    if (generated.length === 0) {
      throw new Error('Mastra preparation requires freshly emitted JavaScript source files.');
    }
    await clearWorkspacePackageCaches();
    return;
  }
  if (generated.length > 0) {
    const sample = generated.slice(0, 20).map((file) => file.slice(workspaceRoot.length + 1));
    throw new Error([
      `Found ${generated.length} generated JavaScript files beside TypeScript sources.`,
      ...sample,
      generated.length > sample.length ? `...and ${generated.length - sample.length} more` : '',
      'Run `pnpm exec tsx scripts/prepare-mastra-dev.ts --clean` before starting Mastra.',
    ].filter(Boolean).join('\n'));
  }
}

await main();
