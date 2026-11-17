/**
 * Threat model: catch accidental replacement of the runner's shared npm in
 * this repository's own reviewed workflows. False positives are acceptable;
 * misses are not. This guard never executes shell input.
 */
/** Use the repository's existing direct YAML dependency. */
import { parseDocument } from 'yaml';

/**
 * Install-family commands: install and its abbreviated/misspelled aliases,
 * add, install-test/it, ci, and install-ci-test/cit all count as installing.
 */
const installAliases = new Set(['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add', 'install-test', 'it', 'ci', 'install-ci-test', 'cit']);

/** npm reads these environment keys case-insensitively. */
function relevantEnvKey(key: string): boolean {
  return key.toLowerCase() === 'npm_config_global' || key.toLowerCase() === 'npm_config_location';
}

/** Computed values of either key can select global installation. */
function envForcesGlobal(env: Record<string, string>): boolean {
  return Object.entries(env).some(([key, value]) => relevantEnvKey(key) &&
    (value.includes('$') || (key.toLowerCase() === 'npm_config_global' ?
      !['false', '0', ''].includes(value.trim().toLowerCase()) : value.trim().toLowerCase() === 'global')));
}

/** Inspect assignments anywhere, including export, env and declare -x forms. */
function runForcesGlobal(script: string): boolean {
  return [...script.matchAll(/\bnpm_config_(global|location)\s*=\s*("[^"]*"|'[^']*'|[^\s;&|]*)/giu)]
    .some(match => envForcesGlobal({ [`npm_config_${match[1]}`]: match[2].replace(/^["']|["']$/gu, '') }));
}

/** An env scope the parser refuses to interpret forces every install to be checked as global. */
const unreadableEnvScope = (): Record<string, string> => ({ npm_config_global: '${{ unreadable env scope }}' });

/**
 * Split a run script into shell command segments at unquoted `;`, `&`, `|`
 * and newlines. Quoted, escaped, commented and heredoc text stays inside its
 * segment — matches inside it still count — but never delimits commands. Quote
 * state spans lines and across `$( … )` substitutions, which nest a fresh
 * quoting context even inside double quotes; an unbalanced quote or
 * substitution means the script cannot be delimited with confidence.
 */
function commandSegments(script: string): string[] | undefined {
  const segments: string[] = [];
  // Each entry restores the quote state that was open when it was entered.
  const contexts: string[] = [];
  let start = 0;
  let quote = '';
  for (let index = 0; index < script.length; index++) {
    const char = script[index];
    if (quote === "'") { if (char === "'") quote = ''; continue; }
    if (quote === '"') {
      if (char === '\\') { index++; continue; }
      if (char === '$' && script[index + 1] === '(') {
        contexts.push(quote);
        quote = '';
        index++;
        if (script[index + 1] === '(') { contexts.push(''); index++; }
        continue;
      }
      if (char === '"') quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '\\') { index++; continue; }
    if (char === '$' && script[index + 1] === '(') {
      contexts.push(quote);
      index++;
      if (script[index + 1] === '(') { contexts.push(''); index++; }
      continue;
    }
    if (char === '(' && contexts.length) { contexts.push(''); continue; }
    if (char === ')' && contexts.length) { quote = contexts.pop()!; continue; }
    if (char === '<' && script[index + 1] === '<') {
      if (script[index + 2] === '<') { index += 2; continue; }
      // A here-document body ends at its delimiter line and delimits nothing.
      let cursor = index + 2;
      let stripTabs = false;
      if (script[cursor] === '-') { stripTabs = true; cursor++; }
      let delimiter = '';
      if (script[cursor] === "'" || script[cursor] === '"') {
        const close = script.indexOf(script[cursor], cursor + 1);
        if (close === -1) return undefined;
        delimiter = script.slice(cursor + 1, close);
        cursor = close + 1;
      } else {
        const word = /^[\w.-]+/u.exec(script.slice(cursor));
        if (!word) return undefined;
        delimiter = word[0];
        cursor += delimiter.length;
      }
      if (!delimiter) return undefined;
      let position = script.indexOf('\n', cursor);
      if (position === -1) return undefined;
      for (;;) {
        position += 1;
        const lineEnd = script.indexOf('\n', position);
        if (lineEnd === -1) return undefined;
        const line = script.slice(position, lineEnd);
        if ((stripTabs ? line.replace(/^\t+/u, '') : line) === delimiter) {
          index = lineEnd - 1;
          break;
        }
        position = lineEnd;
      }
      continue;
    }
    if (char === '#' && (index === 0 || /[\s;&|(){}]/u.test(script[index - 1]))) {
      // A comment runs to end of line: its text never delimits or quotes.
      const newline = script.indexOf('\n', index);
      index = (newline === -1 ? script.length : newline) - 1;
      continue;
    }
    // Ampersands in redirects (2>&1, >&2, &>, &>>, <&) are operands.
    if (char === '&' && (/[<>]/u.test(script[index - 1] ?? '') || script[index + 1] === '>')) continue;
    if (char === '\n' || char === ';' || char === '&' || char === '|') {
      segments.push(script.slice(start, index));
      if ((char === '&' || char === '|') && script[index + 1] === char) index++;
      start = index + 1;
    }
  }
  if (quote || contexts.length) return undefined;
  segments.push(script.slice(start));
  return segments.filter(segment => segment.trim());
}

/** Strip only shell comments at word starts outside quotes, for exemptions. */
function withoutComment(segment: string): string {
  let quote = '';
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index];
    if (char === '\\' && quote !== "'") { index++; continue; }
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '#' && (index === 0 || /[\s;&|(){}<>]/u.test(segment[index - 1]))) return segment.slice(0, index);
  }
  return segment;
}

/** Broad detection words retain comments and quoted/echoed matches. */
function detectionWords(script: string): string[] {
  return script.replace(/["']/gu, '').split(/[\s;&|(){}<>]+/u).filter(Boolean);
}

/**
 * Grant exemptions only for simple npm commands we can confidently read.
 * Unknown syntax/arguments stay checked. All prefix values must be local;
 * comments, option terminators, quoted literal dollars and other commands
 * cannot contribute a prefix. Assignment prefixes must precede npm.
 */
function hasLocalPrefix(command: string): boolean {
  if (/[\\`;&|(){}<>\n]/u.test(command) || /'[^']*\$[^']*'/u.test(command)) return false;
  const words = (command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/gu) ?? []).map(word => word.replace(/["']/gu, ''));
  let index = words[0] === 'env' ? 1 : 0;
  const prefixes: string[] = [];
  while (/^[a-z_][\w]*=/iu.test(words[index] ?? '')) {
    if (/^npm_config_prefix=/iu.test(words[index])) prefixes.push(words[index].slice(words[index].indexOf('=') + 1));
    index++;
  }
  if (words[index++] !== 'npm') return false;
  let installing = false;
  for (; index < words.length; index++) {
    const word = words[index];
    if (word === '--prefix') prefixes.push(words[++index] ?? '');
    else if (word.startsWith('--prefix=')) prefixes.push(word.slice('--prefix='.length));
    else if (installAliases.has(word) && !installing) installing = true;
    else if (['-g', '--global', '--global=true', '--ignore-scripts', '--no-audit', '--no-fund'].includes(word)) continue;
    else if (installing && (word === 'npm' || /^npm@[^\s]+$/u.test(word))) continue;
    else return false;
  }
  return installing && prefixes.length > 0 && prefixes.every(prefix =>
    /^\$RUNNER_TEMP\/[\w-][\w.-]*(?:\/[\w-][\w.-]*)*$/u.test(prefix));
}

/**
 * Global configuration and flags apply conservatively to the whole run.
 * Segments are used ONLY to remove effective job-local prefix exemptions.
 * Detection keeps comments and quoted text, and checks each logical line so
 * an install without a continued operand is not joined to a later command.
 */
export function globalNpmInstalls(script: string, env?: Record<string, string>): string[][] {
  const run = script.replace(/\\\r?\n/gu, '');
  const words = detectionWords(run);
  const global = envForcesGlobal(env ?? {}) || runForcesGlobal(run) || words.some((word, index) =>
    ['--global', '--global=true', '--location=global', '-L=global'].includes(word) ||
    /^-[a-z]*g[a-z]*$/iu.test(word) ||
    (['--location', '-L'].includes(word) && words[index + 1] === 'global'));
  const segments = commandSegments(run);
  if (segments === undefined) return [['undelimitable command line']];
  if (!global) return [];
  let unchecked = run;
  let offset = 0;
  for (const segment of segments) {
    const position = run.indexOf(segment, offset);
    offset = position + segment.length;
    const effective = withoutComment(segment);
    // Mask only the effective exempt command; retain comments and separators.
    if (hasLocalPrefix(effective)) unchecked = unchecked.slice(0, position) +
      effective.replace(/[^\r\n]/gu, ' ') + unchecked.slice(position + effective.length);
  }
  const installsNpm = unchecked.split('\n').some(line => {
    const tokens = detectionWords(line);
    return tokens.some((word, index) => installAliases.has(word) &&
      tokens.slice(index + 1).some(packageWord => packageWord === 'npm' || packageWord.startsWith('npm@')));
  });
  return installsNpm ? [words] : [];
}

/** Represent extraction failures as violations, never as a successful empty scan. */
function unreadableRun(): string[][] {
  return [['unextractable step run']];
}
/** Narrow unknown YAML values before traversing the workflow's executable path. */
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Decode one composed env scope; npm reads npm_config_* keys
 * case-insensitively. A scope that cannot be read confidently, or a relevant
 * entry whose value is not a scalar, forces every install to be checked as
 * global instead of silently passing.
 */
function envScope(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!record(value)) return unreadableEnvScope();
  const entries: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') entries[key] = entry;
    else if (typeof entry === 'number' || typeof entry === 'boolean') entries[key] = String(entry);
    else if (relevantEnvKey(key)) entries[key] = '${{ unreadable env entry }}';
    // Null and irrelevant unreadable entries never reach npm as a value.
  }
  return entries;
}

/** Collect only jobs.<id>.steps[*].run; metadata called run is inert. */
export function workflowGlobalNpmInstalls(source: string): string[][] {
  try {
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length) return unreadableRun();
    const workflow: unknown = document.toJS({ maxAliasCount: 100 });
    if (!record(workflow)) return unreadableRun();
    if (!('jobs' in workflow)) return [];
    if (!record(workflow.jobs)) return unreadableRun();
    // The workflow env composes under the job env, which composes under the
    // step env: each step sees all three, with the step scope winning.
    const workflowEnv = envScope('env' in workflow ? workflow.env : undefined);
    const findings: string[][] = [];
    for (const job of Object.values(workflow.jobs)) {
      if (!record(job)) return unreadableRun();
      const jobEnv = { ...workflowEnv, ...envScope('env' in job ? job.env : undefined) };
      if (!('steps' in job)) continue;
      if (!Array.isArray(job.steps)) return unreadableRun();
      for (const step of job.steps) {
        if (!record(step)) return unreadableRun();
        if (!('run' in step)) continue;
        if (typeof step.run !== 'string') return unreadableRun();
        const stepEnv = envScope('env' in step ? step.env : undefined);
        findings.push(...globalNpmInstalls(step.run, { ...jobEnv, ...stepEnv }));
      }
    }
    return findings;
  } catch {
    return unreadableRun();
  }
}
