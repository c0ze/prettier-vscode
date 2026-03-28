#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { createRequire } = require('module');

const repoRoot = path.resolve(__dirname, '..');
const requireFromRepo = createRequire(path.join(repoRoot, 'package.json'));

function resolveFirst(ids) {
  for (const id of ids) {
    try {
      return requireFromRepo(id);
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(`Could not resolve any of: ${ids.join(', ')}`);
}

const vscePackage = resolveFirst(['@vscode/vsce/out/package.js', 'vsce/out/package.js']);
const globModule = resolveFirst(['glob']);
const yazl = resolveFirst(['yazl']);
const globSync = globModule.globSync || globModule.sync;

if (typeof globSync !== 'function') {
  throw new Error('Could not find a synchronous glob function');
}

const DEFAULT_IGNORE = [
  '**/.git/**',
  '**/.DS_Store',
  '**/*.vsix',
  '**/*.vsixmanifest',
  '**/.vscode-test/**',
  '**/.vscode-test-web/**',
];

function normalize(filePath) {
  return filePath.replace(/\\/g, '/');
}

function readIgnorePatterns(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  return fs
    .readFileSync(filePath, 'utf8')
    .split(/[\n\r]/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !line.startsWith('#'));
}

function expandDirectoryPatterns(patterns) {
  const expanded = [];

  for (const pattern of patterns) {
    expanded.push(pattern);

    if (!/(^|\/)[^/]*\*[^/]*$/.test(pattern)) {
      expanded.push(/\/$/.test(pattern) ? `${pattern}**` : `${pattern}/**`);
    }
  }

  return expanded;
}

function listRootFiles(ignorePatterns) {
  return globSync('**', {
    cwd: repoRoot,
    nodir: true,
    dot: true,
    follow: false,
    ignore: [...DEFAULT_IGNORE, 'node_modules/**', ...ignorePatterns],
  }).map(normalize);
}

function listDependencyFiles() {
  const output = cp.execFileSync(
    'npm',
    ['list', '--production', '--parseable', '--depth=99999', '--loglevel=error'],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );

  const directories = output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(dir => path.isAbsolute(dir))
    .filter(dir => normalize(dir) !== normalize(repoRoot));

  const dependencyFiles = [];

  for (const dir of directories) {
    const files = globSync('**', {
      cwd: dir,
      nodir: true,
      dot: true,
      follow: false,
      ignore: [...DEFAULT_IGNORE, 'node_modules/**'],
    });

    for (const file of files) {
      dependencyFiles.push(normalize(path.relative(repoRoot, path.join(dir, file))));
    }
  }

  return dependencyFiles;
}

async function main() {
  const manifest = await vscePackage.readManifest(repoRoot);
  const ignorePatterns = expandDirectoryPatterns(readIgnorePatterns(path.join(repoRoot, '.npmignore')));
  const rootFiles = listRootFiles(ignorePatterns);
  const dependencyFiles = listDependencyFiles();
  const files = [...new Set([...rootFiles, ...dependencyFiles])].sort();

  const fileEntries = files.map(file => ({
    path: `extension/${file}`,
    localPath: path.join(repoRoot, file),
  }));

  const processedFiles = await vscePackage.processFiles(
    vscePackage.createDefaultProcessors(manifest, { cwd: repoRoot }),
    fileEntries
  );

  const packagePath = path.join(repoRoot, `${manifest.name}-${manifest.version}.vsix`);

  await new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();

    for (const file of processedFiles) {
      if (Object.prototype.hasOwnProperty.call(file, 'contents')) {
        const contents = Buffer.isBuffer(file.contents)
          ? file.contents
          : Buffer.from(file.contents, 'utf8');
        zip.addBuffer(contents, file.path, { mode: file.mode });
      } else {
        zip.addFile(file.localPath, file.path, { mode: file.mode });
      }
    }

    zip.end();

    const output = fs.createWriteStream(packagePath);
    zip.outputStream.pipe(output);
    zip.outputStream.on('error', reject);
    output.on('error', reject);
    output.on('finish', resolve);
  });

  console.log(`Packaged ${packagePath}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
