/** Use the repository's existing direct YAML dependency. */
import { parseDocument } from 'yaml';

/** Install aliases supported by npm; this guard never executes shell input. */
const installAliases = new Set(['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add']);

/** npm reads npm_config_* environment keys case-insensitively; only these two force installs global. */
function relevantEnvKey(key: string): boolean {
  return key.toLowerCase() === 'npm_config_global' || key.toLowerCase() === 'npm_config_location';
}

/** A computed workflow env forces global installs when it cannot be ruled out. */
function envForcesGlobal(env: Record<string, string>): boolean {
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === 'npm_config_global' && !['false', '0', ''].includes(value.trim().toLowerCase())) return true;
    if (key.toLowerCase() === 'npm_config_location' && value.trim().toLowerCase() === 'global') return true;
  }
  return false;
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
    if (char === '\n' || char === ';' || char === '&' || char === '|') {
      segments.push(script.slice(start, index));
      start = index + 1;
    }
  }
  if (quote || contexts.length) return undefined;
  segments.push(script.slice(start));
  return segments.filter(segment => segment.trim());
}

/**
 * Conservatively inspect command segments of a whole run script, not shell
 * command positions. Quoted, echoed, commented and heredoc matches
 * intentionally count: the inventory is our own workflows, so false positives
 * are preferable to a missed shared npm write. A prefix exception only covers
 * the segment that carries it, never a sibling command.
 */
export function globalNpmInstalls(script: string, env?: Record<string, string>): string[][] {
  const forced = env !== undefined && envForcesGlobal(env);
  const segments = commandSegments(script.replace(/\\\r?\n/gu, ''));
  if (segments === undefined) return [['undelimitable command line']];
  return segments.flatMap(segment => {
    const words = segment.replace(/["']/gu, '').split(/[\s;&|(){}]+/u).filter(Boolean);
    const global = forced || words.some((word, index) =>
      ['-g', '--global', '--global=true', '--location=global'].includes(word) ||
      /^-[a-z]*g[a-z]*$/iu.test(word) ||
      (word === '--location' && words[index + 1] === 'global') ||
      /^npm_config_global=/iu.test(word) || /^npm_config_location=global$/iu.test(word)
    );
    // Only an explicit runner-temporary prefix qualifies for the bootstrap
    // exception. An arbitrary --prefix could still name the shared toolcache.
    const local = words.some((word, index) =>
      /^\$RUNNER_TEMP\/[\w-][\w.-]*(?:\/[\w-][\w.-]*)*$/u.test(word === '--prefix' ? words[index + 1] ?? '' :
        word.replace(/^(?:--prefix=|npm_config_prefix=)/iu, '')) &&
      (word === '--prefix' || /^(?:--prefix=|npm_config_prefix=)/iu.test(word))
    );
    return global && !local && words.some((word, index) => installAliases.has(word) &&
      words.slice(index + 1).some(packageWord => packageWord === 'npm' || packageWord.startsWith('npm@'))) ? [words] : [];
  });
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
