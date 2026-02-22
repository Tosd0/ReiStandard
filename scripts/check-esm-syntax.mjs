import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const rootDir = process.cwd();
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist']);
const ESM_EXTENSIONS = new Set(['.js', '.mjs']);
const CJS_PATTERNS = [
  /\brequire\s*\(/,
  /\bmodule\.exports\b/,
  /\bexports\.[A-Za-z_$]/
];

function walkFiles(dir, onFile) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkFiles(fullPath, onFile);
      continue;
    }
    onFile(fullPath);
  }
}

function findPackageJsonFiles() {
  const files = [];
  walkFiles(rootDir, (fullPath) => {
    if (path.basename(fullPath) === 'package.json') {
      files.push(fullPath);
    }
  });
  return files;
}

function getEsmPackageDirs() {
  const dirs = [];
  for (const pkgFile of findPackageJsonFiles()) {
    const raw = fs.readFileSync(pkgFile, 'utf8');
    const pkg = JSON.parse(raw);
    if (pkg.type === 'module') {
      dirs.push(path.dirname(pkgFile));
    }
  }
  return dirs;
}

function listEsmSourceFiles(packageDir) {
  const files = [];
  walkFiles(packageDir, (fullPath) => {
    const ext = path.extname(fullPath);
    if (!ESM_EXTENSIONS.has(ext)) return;
    files.push(fullPath);
  });
  return files;
}

function checkSyntax(filePath) {
  const result = spawnSync(process.execPath, ['--check', filePath], {
    encoding: 'utf8'
  });

  if (result.status === 0) return null;

  return {
    type: 'syntax',
    filePath,
    message: (result.stderr || result.stdout || 'Unknown syntax error').trim()
  };
}

function checkCjsTokens(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const errors = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of CJS_PATTERNS) {
      if (!pattern.test(line)) continue;
      errors.push({
        type: 'cjs-token',
        filePath,
        message: `CommonJS token found at line ${i + 1}: ${line.trim()}`
      });
      break;
    }
  }

  return errors;
}

const packageDirs = getEsmPackageDirs();
const filesToCheck = packageDirs.flatMap(listEsmSourceFiles);
const errors = [];

for (const filePath of filesToCheck) {
  const syntaxError = checkSyntax(filePath);
  if (syntaxError) errors.push(syntaxError);
  errors.push(...checkCjsTokens(filePath));
}

if (errors.length > 0) {
  console.error(`[check:esm] Found ${errors.length} issue(s):`);
  for (const error of errors) {
    const rel = path.relative(rootDir, error.filePath);
    console.error(`- ${rel}: ${error.message}`);
  }
  process.exit(1);
}

console.log(`[check:esm] OK - checked ${filesToCheck.length} file(s) across ${packageDirs.length} ESM package(s).`);
