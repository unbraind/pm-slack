/** Use the repository's existing direct YAML dependency. */
import { parseDocument } from 'yaml';

/** Install aliases supported by npm; this guard never executes shell input. */
const installAliases = new Set(['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add']);

/**
 * Conservatively inspect logical lines, not shell command positions. Quoted,
 * echoed and commented matches intentionally count: the inventory is our own
 * workflows, so false positives are preferable to a missed shared npm write.
 */
export function globalNpmInstalls(script: string): string[][] {
  return script.replace(/\\\r?\n/gu, '').split(/\r?\n/u).map(line =>
    line.replace(/["']/gu, '').split(/[\s;&|(){}]+/u).filter(Boolean)
  ).filter(words => {
    const global = words.some((word, index) =>
      ['-g', '--global', '--global=true', '--location=global'].includes(word) ||
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
      words.slice(index + 1).some(packageWord => packageWord === 'npm' || packageWord.startsWith('npm@')));
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

/** Collect only jobs.<id>.steps[*].run; metadata called run is inert. */
export function workflowGlobalNpmInstalls(source: string): string[][] {
  try {
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length) return unreadableRun();
    const workflow: unknown = document.toJS({ maxAliasCount: 100 });
    if (!record(workflow)) return unreadableRun();
    if (!('jobs' in workflow)) return [];
    if (!record(workflow.jobs)) return unreadableRun();
    const findings: string[][] = [];
    for (const job of Object.values(workflow.jobs)) {
      if (!record(job)) return unreadableRun();
      if (!('steps' in job)) continue;
      if (!Array.isArray(job.steps)) return unreadableRun();
      for (const step of job.steps) {
        if (!record(step)) return unreadableRun();
        if (!('run' in step)) continue;
        if (typeof step.run !== 'string') return unreadableRun();
        findings.push(...globalNpmInstalls(step.run));
      }
    }
    return findings;
  } catch {
    return unreadableRun();
  }
}
