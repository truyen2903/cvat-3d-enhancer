import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['src', 'tests', 'docs'];

const SECRET_PATTERNS = [
  {
    name: 'Hardcoded Bearer Token',
    regex: /Bearer\s+[A-Za-z0-9_\-.=]{24,}/g,
  },
  {
    name: 'GitHub/GitLab PAT',
    regex: /\b(?:ghp|gho|ghu|ghs|ghr|glpat)_[A-Za-z0-9_]{20,}\b/g,
  },
  {
    name: 'Private Key Block',
    regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  },
  {
    name: 'AWS Access Key',
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
  },
];

const UNSAFE_EXECUTION_PATTERNS = [
  {
    name: 'Direct eval() invocation',
    regex: /\beval\s*\(/g,
  },
  {
    name: 'new Function() constructor',
    regex: /\bnew\s+Function\s*\(/g,
  },
  {
    name: 'Direct document.cookie access',
    regex: /\bdocument\.cookie\b/g,
  },
  {
    name: 'Direct dangerouslySetInnerHTML usage',
    regex: /\bdangerouslySetInnerHTML\b/g,
  },
];

function walkFiles(dirPath, collected = []) {
  for (const entry of readdirSync(dirPath)) {
    const fullPath = join(dirPath, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      walkFiles(fullPath, collected);
    } else if (/\.(ts|tsx|js|mjs|json|html|md)$/.test(entry)) {
      collected.push(fullPath);
    }
  }
  return collected;
}

const findings = [];

for (const dir of SCAN_DIRS) {
  const fullDir = join(ROOT, dir);
  const files = walkFiles(fullDir);
  for (const file of files) {
    const relPath = relative(ROOT, file).replace(/\\/g, '/');
    const content = readFileSync(file, 'utf8');

    for (const pattern of SECRET_PATTERNS) {
      if (pattern.regex.test(content)) {
        // Allow explicit test fixtures marked with TEST_FIXTURE_ONLY
        if (!relPath.startsWith('tests/') || !content.includes('TEST_FIXTURE_ONLY')) {
          findings.push(`[SECRET] ${pattern.name} found in ${relPath}`);
        }
      }
      pattern.regex.lastIndex = 0;
    }

    if (relPath.startsWith('src/')) {
      for (const pattern of UNSAFE_EXECUTION_PATTERNS) {
        if (pattern.regex.test(content)) {
          findings.push(`[STATIC-SECURITY] ${pattern.name} found in ${relPath}`);
        }
        pattern.regex.lastIndex = 0;
      }
    }
  }
}

if (findings.length > 0) {
  console.error('Security scan failed with findings:');
  for (const item of findings) {
    console.error(` - ${item}`);
  }
  process.exit(1);
}

console.log('Static secret and unsafe-execution scan passed with 0 findings.');
