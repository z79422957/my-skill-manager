#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

function toPosix(p) {
  return p.split(/[\\/]/).filter(Boolean).join('/');
}

function inferComplexity(lines) {
  if (lines > 200) return 'complex';
  if (lines >= 50) return 'moderate';
  return 'simple';
}

function makeFileSummary(file) {
  const path = toPosix(file.path);
  const name = path.slice(path.lastIndexOf('/') + 1);
  const category = file.fileCategory;
  if (category === 'config') return `${name} 配置了项目中的一项构建、运行或包管理行为。`;
  if (category === 'docs') return `${name} 记录了该模块的说明或使用约束。`;
  if (category === 'data') return `${name} 定义了项目使用的数据结构、协议或配置内容。`;
  if (category === 'script') return `${name} 提供了自动化脚本或工具入口。`;
  if (category === 'infra') return `${name} 描述了项目的基础设施、流水线或部署相关内容。`;
  if (path.includes('/Hotfix/')) return `${name} 实现了热更层中的业务逻辑或处理流程。`;
  if (path.includes('/Model/')) return `${name} 定义了 ET 框架中的数据模型、枚举或共享结构。`;
  if (path.includes('/Core/')) return `${name} 提供了 ET 框架核心能力的一部分。`;
  if (path.includes('/Editor/')) return `${name} 提供了 Unity Editor 或开发工具侧的功能。`;
  if (path.includes('/DotNet~/')) return `${name} 提供了独立于 Unity 运行的 .NET 辅助逻辑。`;
  return `${name} 是项目中的一个源码文件。`;
}

function makeFunctionSummary(fn, file) {
  return `${fn.name} 是 ${file.name} 中的一个函数或方法，用于实现局部逻辑。`;
}

function makeClassSummary(cls, file) {
  return `${cls.name} 是 ${file.name} 中定义的类型，承载该文件的主要结构或行为。`;
}

function baseTags(file) {
  const path = toPosix(file.path);
  const tags = new Set();
  if (file.fileCategory === 'config') tags.add('configuration');
  if (file.fileCategory === 'docs') tags.add('documentation');
  if (file.fileCategory === 'data') tags.add('schema-definition');
  if (file.fileCategory === 'script') tags.add('automation');
  if (path.includes('/Hotfix/')) tags.add('hotfix');
  if (path.includes('/Model/')) tags.add('data-model');
  if (path.includes('/Core/')) tags.add('core');
  if (path.includes('/Editor/')) tags.add('editor');
  if (/test/i.test(path)) tags.add('test');
  if (path.endsWith('Program.cs')) tags.add('entry-point');
  if (path.endsWith('package.json')) tags.add('package');
  return [...tags].slice(0, 5);
}

function relLineRange(item) {
  if (typeof item.startLine === 'number' && typeof item.endLine === 'number') {
    return [item.startLine, item.endLine];
  }
  return undefined;
}

function normalizeFunctionId(filePath, fnName) {
  return `function:${filePath}:${fnName}`;
}

function normalizeClassId(filePath, className) {
  return `class:${filePath}:${className}`;
}

function main() {
  const projectRoot = process.argv[2];
  if (!projectRoot) {
    process.stderr.write('Usage: node generate-batch-graphs.mjs <project-root>\n');
    process.exit(1);
  }

  const root = resolve(projectRoot);
  const intermediateDir = join(root, '.understand-anything', 'intermediate');
  const tmpDir = join(root, '.understand-anything', 'tmp');
  mkdirSync(tmpDir, { recursive: true });

  const batchesPath = join(intermediateDir, 'batches.json');
  if (!existsSync(batchesPath)) {
    throw new Error(`batches.json not found: ${batchesPath}`);
  }

  const batches = JSON.parse(readFileSync(batchesPath, 'utf8')).batches ?? [];
  for (const batch of batches) {
    const batchIndex = batch.batchIndex;
    const inputPath = join(tmpDir, `ua-file-analyzer-input-${batchIndex}.json`);
    const extractPath = join(tmpDir, `ua-file-extract-results-${batchIndex}.json`);
    const outputPath = join(intermediateDir, `batch-${batchIndex}.json`);

    const input = {
      projectRoot: root,
      batchFiles: batch.files,
      batchImportData: batch.batchImportData ?? {},
    };
    writeFileSync(inputPath, JSON.stringify(input, null, 2), 'utf8');

    const run = spawnSync(process.execPath, [join(__dirname, 'extract-structure.mjs'), inputPath, extractPath], {
      cwd: root,
      encoding: 'utf8',
    });
    if (run.status !== 0) {
      throw new Error(`extract-structure failed for batch ${batchIndex}: ${run.stderr || run.stdout}`);
    }

    const extracted = JSON.parse(readFileSync(extractPath, 'utf8'));
    const nodes = [];
    const edges = [];
    const functionNamesByFile = new Map();

    for (const result of extracted.results ?? []) {
      const filePath = toPosix(result.path);
      const fileName = filePath.slice(filePath.lastIndexOf('/') + 1);
      const fileNode = {
        id: `file:${filePath}`,
        type: result.fileCategory === 'config' ? 'config' : result.fileCategory === 'docs' ? 'document' : 'file',
        name: fileName,
        filePath,
        summary: makeFileSummary(result),
        tags: baseTags(result),
        complexity: inferComplexity(result.nonEmptyLines ?? result.totalLines ?? 0),
      };
      nodes.push(fileNode);

      const fnNames = new Set();
      for (const fn of result.functions ?? []) {
        fnNames.add(fn.name);
        nodes.push({
          id: normalizeFunctionId(filePath, fn.name),
          type: 'function',
          name: fn.name,
          filePath,
          lineRange: relLineRange(fn),
          summary: makeFunctionSummary(fn, fileNode),
          tags: ['function'],
          complexity: inferComplexity((fn.endLine ?? 0) - (fn.startLine ?? 0) + 1),
        });
        edges.push({
          source: `file:${filePath}`,
          target: normalizeFunctionId(filePath, fn.name),
          type: 'contains',
          direction: 'forward',
          weight: 1.0,
        });
      }
      functionNamesByFile.set(filePath, fnNames);

      for (const cls of result.classes ?? []) {
        nodes.push({
          id: normalizeClassId(filePath, cls.name),
          type: 'class',
          name: cls.name,
          filePath,
          lineRange: relLineRange(cls),
          summary: makeClassSummary(cls, fileNode),
          tags: ['class'],
          complexity: inferComplexity((cls.endLine ?? 0) - (cls.startLine ?? 0) + 1),
        });
        edges.push({
          source: `file:${filePath}`,
          target: normalizeClassId(filePath, cls.name),
          type: 'contains',
          direction: 'forward',
          weight: 1.0,
        });
      }

      for (const imported of batch.batchImportData?.[filePath] ?? []) {
        edges.push({
          source: `file:${filePath}`,
          target: `file:${toPosix(imported)}`,
          type: 'imports',
          direction: 'forward',
          weight: 0.7,
        });
      }
    }

    for (const result of extracted.results ?? []) {
      const filePath = toPosix(result.path);
      const localFns = functionNamesByFile.get(filePath) ?? new Set();
      for (const call of result.callGraph ?? []) {
        if (!localFns.has(call.caller) || !localFns.has(call.callee)) continue;
        edges.push({
          source: normalizeFunctionId(filePath, call.caller),
          target: normalizeFunctionId(filePath, call.callee),
          type: 'calls',
          direction: 'forward',
          weight: 0.8,
        });
      }
    }

    writeFileSync(outputPath, JSON.stringify({ nodes, edges }, null, 2), 'utf8');
    process.stdout.write(`batch ${batchIndex}/${batches.length} done\n`);
  }
}

main();
