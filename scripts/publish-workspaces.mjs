import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const rootDir = process.cwd();
const dryRun = process.argv.includes('--dry-run');
const useProvenance = process.env.NPM_PUBLISH_PROVENANCE !== 'false';

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || rootDir,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe'
  });

  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    const stdout = (result.stdout || '').trim();
    const details = [stderr, stdout].filter(Boolean).join('\n');
    throw new Error(`Command failed: ${command} ${args.join(' ')}\n${details}`);
  }

  return result;
}

function pathExists(filePath) {
  return fs.existsSync(filePath);
}

function resolveWorkspaceDirs(workspaces) {
  const dirs = new Set();

  for (const pattern of workspaces) {
    if (!pattern || typeof pattern !== 'string') continue;

    if (pattern.endsWith('/*')) {
      const baseDir = path.join(rootDir, pattern.slice(0, -2));
      if (!pathExists(baseDir)) continue;

      const entries = fs.readdirSync(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        dirs.add(path.join(baseDir, entry.name));
      }

      continue;
    }

    const fullPath = path.join(rootDir, pattern);
    if (!pathExists(fullPath)) continue;
    dirs.add(fullPath);
  }

  return Array.from(dirs);
}

function collectExportTargets(value, targets) {
  if (typeof value === 'string') {
    if (value.startsWith('./')) targets.push(value);
    return;
  }

  if (!value || typeof value !== 'object') return;

  for (const nestedValue of Object.values(value)) {
    collectExportTargets(nestedValue, targets);
  }
}

function ensureBuildArtifacts(pkgDir, pkg) {
  const distDir = path.join(pkgDir, 'dist');

  if (Array.isArray(pkg.files) && pkg.files.includes('dist')) {
    if (!pathExists(distDir)) {
      throw new Error(`[publish] Missing dist directory for ${pkg.name}. Run build first.`);
    }

    const distEntries = fs.readdirSync(distDir);
    if (distEntries.length === 0) {
      throw new Error(`[publish] Empty dist directory for ${pkg.name}. Run build first.`);
    }
  }

  const exportTargets = [];
  collectExportTargets(pkg.exports, exportTargets);

  for (const target of exportTargets) {
    const absoluteTarget = path.join(pkgDir, target);
    if (!pathExists(absoluteTarget)) {
      throw new Error(`[publish] Missing export target for ${pkg.name}: ${target}`);
    }
  }
}

function isVersionPublished(name, version) {
  const spec = `${name}@${version}`;
  const result = spawnSync(
    'npm',
    ['view', spec, 'version', '--registry', 'https://registry.npmjs.org'],
    { encoding: 'utf8' }
  );

  if (result.status === 0) {
    const publishedVersion = (result.stdout || '').trim();
    return publishedVersion === version;
  }

  const combinedOutput = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (/E404|404 Not Found|No match found for version/i.test(combinedOutput)) {
    return false;
  }

  throw new Error(
    `[publish] Failed to query npm for ${spec}:\n${combinedOutput.trim()}`
  );
}

function publishWorkspace(pkgDir, pkg) {
  const npmArgs = ['publish', '--access', 'public'];

  if (useProvenance) {
    npmArgs.push('--provenance');
  }

  if (dryRun) {
    npmArgs.push('--dry-run');
  }

  console.log(`[publish] Publishing ${pkg.name}@${pkg.version} from ${path.relative(rootDir, pkgDir)}`);
  run('npm', npmArgs, { cwd: pkgDir, stdio: 'inherit' });
}

function main() {
  const rootPkg = readJson(path.join(rootDir, 'package.json'));
  const workspacePatterns = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : [];
  const workspaceDirs = resolveWorkspaceDirs(workspacePatterns);

  const publishable = [];

  for (const workspaceDir of workspaceDirs) {
    const packageJsonPath = path.join(workspaceDir, 'package.json');
    if (!pathExists(packageJsonPath)) continue;

    const pkg = readJson(packageJsonPath);
    if (pkg.private) continue;

    if (!pkg.name || !pkg.version) {
      throw new Error(`[publish] Invalid package manifest at ${packageJsonPath}`);
    }

    publishable.push({ dir: workspaceDir, pkg });
  }

  if (publishable.length === 0) {
    console.log('[publish] No public workspaces found. Nothing to publish.');
    return;
  }

  for (const { dir, pkg } of publishable) {
    ensureBuildArtifacts(dir, pkg);

    if (isVersionPublished(pkg.name, pkg.version)) {
      console.log(`[publish] Skip ${pkg.name}@${pkg.version} (already published).`);
      continue;
    }

    publishWorkspace(dir, pkg);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
