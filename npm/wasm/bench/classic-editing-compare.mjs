import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const usage = `Usage: node classic-editing-compare.mjs --base <entry.js> --candidate <entry.js> --reference <entry.js> --out <new-directory> [--replicates <positive-integer>]

Runs sequential fresh Node processes: odd triplets base/candidate/reference,
even triplets reference/candidate/base. Defaults to 6 triplets.
Preserves each child's stdout JSON and stderr, and writes summary.json.
Phase statistics summarize process medianMs/p95Ms/totalMs independently;
phase observations are never pooled. Module loading is reported separately.
Source manifests hash the entry, nearest package.json, and package .js/.wasm
files recursively (excluding node_modules and dot directories). They are
checked before and after each child. Without package.json, the entry's
directory is the source root. External dependencies are outside the manifest.
--help prints this message without running a workload.
`;

function options(args) {
  const result = { replicates: 6 };
  const names = ['base', 'candidate', 'reference', 'out', 'replicates'];
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i].slice(2);
    if (args[i] !== `--${name}` || !names.includes(name) || seen.has(name)) {
      throw new TypeError(`Unknown or duplicate option: ${args[i]}`);
    }
    const value = args[i + 1];
    if (!value || value.startsWith('--')) throw new TypeError(`Missing value for --${name}`);
    seen.add(name);
    result[name] = value;
  }
  for (const name of names.slice(0, 4)) {
    if (!result[name]) throw new TypeError(`Required option: --${name}`);
    result[name] = resolve(result[name]);
  }
  if (!/^[1-9]\d*$/.test(String(result.replicates))) throw new TypeError('--replicates must be a positive integer');
  result.replicates = Number(result.replicates);
  if (!Number.isSafeInteger(result.replicates)) throw new TypeError('--replicates exceeds the safe integer range');
  return result;
}

function hash(file) {
  const bytes = readFileSync(file);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

function manifest(entry) {
  entry = realpathSync(entry);
  if (extname(entry) !== '.js' || !statSync(entry).isFile()) throw new TypeError(`Expected a .js entry file: ${entry}`);
  let root = dirname(entry);
  while (!existsSync(join(root, 'package.json')) && dirname(root) !== root) root = dirname(root);
  const packageFile = existsSync(join(root, 'package.json')) ? join(root, 'package.json') : null;
  if (!packageFile) root = dirname(entry);
  const files = [];
  function walk(directory) {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name.startsWith('.') || item.name === 'node_modules') continue;
      const path = join(directory, item.name);
      if (item.isDirectory()) walk(path);
      else if ((item.isFile() || item.isSymbolicLink()) && ['.js', '.wasm'].includes(extname(path))) {
        files.push({ path: relative(root, path), ...hash(path) });
      }
    }
  }
  walk(root);
  return { entry, entryHash: hash(entry), root, package: packageFile ? { path: packageFile, ...hash(packageFile) } : null, files };
}

function statistics(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { count: sorted.length, median, p95: sorted[Math.ceil(sorted.length * 0.95) - 1] };
}

function validate(result, source, node) {
  if (result.entry !== source.entry || result.entrySha256 !== source.entryHash.sha256 || result.node !== node) {
    throw new TypeError('Child entry hash, path or Node version does not match the manifest');
  }
  const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const counts = value => value && Object.values(value).every(count => Number.isSafeInteger(count) && count >= 0);
  if (!finite(result.moduleLoadMs) || !counts(result.counts) || !result.grouped || !Array.isArray(result.phases)) {
    throw new TypeError('Invalid workload result');
  }
  for (const phase of Object.values(result.grouped)) {
    if (!['medianMs', 'p95Ms', 'totalMs'].every(key => finite(phase[key])) || !counts(phase.hostCalls)) {
      throw new TypeError('Invalid process phase statistics or callback counts');
    }
  }
}

async function child(workload, entry, stdout, stderr) {
  const out = openSync(stdout, 'wx');
  let err;
  try {
    err = openSync(stderr, 'wx');
    await new Promise((resolveChild, rejectChild) => {
      const processChild = spawn(process.execPath, [workload, entry], { stdio: ['ignore', out, err] });
      processChild.once('error', rejectChild);
      processChild.once('close', (code, signal) => {
        if (code === 0 && signal === null) resolveChild();
        else rejectChild(new TypeError(`Child failed: exit=${code}, signal=${signal}; see ${stderr}`));
      });
    });
  } finally {
    closeSync(out);
    if (err !== undefined) closeSync(err);
  }
}

async function main() {
  if (process.argv.slice(2).includes('--help')) {
    process.stdout.write(usage);
    return;
  }
  const config = options(process.argv.slice(2));
  const workload = fileURLToPath(new URL('./classic-editing.mjs', import.meta.url));
  const workloadHash = hash(workload);
  const expectedWorkloadHash = '8849796804fb105a8dd25063384f4456b172799f4dade715cd677c41a808b515';
  if (workloadHash.sha256 !== expectedWorkloadHash) throw new TypeError('Frozen workload hash does not match');
  const arms = Object.fromEntries(['base', 'candidate', 'reference'].map(name => [name, {
    source: manifest(config[name]), samples: [],
  }]));
  // mkdir is exclusive: an existing output directory is never reused or overwritten.
  mkdirSync(config.out);
  const summary = {
    node: process.version, executable: process.execPath, replicates: config.replicates,
    workload: { path: workload, ...workloadHash }, runner: { path: fileURLToPath(import.meta.url), ...hash(fileURLToPath(import.meta.url)) },
    statistics: { unit: 'milliseconds', median: 'middle value; arithmetic mean of middle two for even counts', p95: 'nearest rank ceil(0.95 * process count)', population: 'process results only, never pooled phase observations' },
    arms, order: [],
  };
  const save = () => writeFileSync(join(config.out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  const unchanged = arm => {
    if (JSON.stringify(manifest(arm.source.entry)) !== JSON.stringify(arm.source) || hash(workload).sha256 !== workloadHash.sha256) {
      throw new TypeError('Source assets changed during comparison');
    }
  };
  save();
  try {
    for (let replicate = 1; replicate <= config.replicates; replicate++) {
      const order = replicate % 2 ? ['base', 'candidate', 'reference'] : ['reference', 'candidate', 'base'];
      for (const name of order) {
        const arm = arms[name];
        unchanged(arm);
        const prefix = `${String(replicate).padStart(2, '0')}-${name}`;
        const stdout = `${prefix}.json`;
        const stderr = `${prefix}.stderr`;
        const sequence = summary.order.length + 1;
        summary.order.push({ sequence, replicate, arm: name, stdout, stderr });
        save();
        await child(workload, arm.source.entry, join(config.out, stdout), join(config.out, stderr));
        unchanged(arm);
        const result = JSON.parse(readFileSync(join(config.out, stdout), 'utf8'));
        validate(result, arm.source, summary.node);
        const first = arms.base.samples[0]?.result;
        if (first && (result.fixtureSha256 !== first.fixtureSha256 || result.fixtureBytes !== first.fixtureBytes || result.repetitions !== first.repetitions || JSON.stringify(Object.keys(result.grouped).sort()) !== JSON.stringify(Object.keys(first.grouped).sort()))) {
          throw new TypeError('Workload fixture or phase set differs between processes');
        }
        arm.samples.push({ sequence, replicate, stdout, stderr, result });
        save();
      }
    }
    for (const arm of Object.values(arms)) {
      unchanged(arm);
      arm.aggregate = {
        moduleLoadMs: statistics(arm.samples.map(sample => sample.result.moduleLoadMs)),
        phases: Object.fromEntries(Object.keys(arm.samples[0].result.grouped).map(name => [name,
          Object.fromEntries(['medianMs', 'p95Ms', 'totalMs'].map(metric => [metric,
            statistics(arm.samples.map(sample => sample.result.grouped[name][metric])),
          ])),
        ])),
      };
    }
    summary.status = 'complete';
    save();
    process.stdout.write(`${join(config.out, 'summary.json')}\n`);
  } catch (error) {
    summary.status = 'failed';
    summary.failure = String(error);
    save();
    throw error;
  }
}

main().catch(error => {
  console.error(String(error));
  process.exitCode = 1;
});
