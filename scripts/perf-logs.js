#!/usr/bin/env node
/**
 * Latency percentiles from the web process's own logs - read-only.
 *
 * Every question writes timing lines (src/web/chat.service.ts, src/ai/rag.service.ts,
 * src/ai/precedents.service.ts): "Question answered", "Question routed",
 * "Answer timings" and "Judgment search timings". This reads them out of the
 * pm2 logs and prints P50 / P90 / P95 / P99 for every step, so a change can be
 * measured on real traffic before and after.
 *
 *   node scripts/perf-logs.js                 last 24 hours
 *   node scripts/perf-logs.js --hours 168     last week
 *   node scripts/perf-logs.js --since 2026-10-04T10:00
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const since = arg('--since') ? new Date(arg('--since')) : new Date(Date.now() - Number(arg('--hours') ?? 24) * 3_600_000);
const dir = arg('--dir') ?? path.join(os.homedir(), '.pm2', 'logs');

const LINES = {
  'Question answered': ['ms', 'setupMs'],
  'Question routed': ['routeMs'],
  'Answer timings': ['ms', 'retrieveMs', 'firstDraftMs', 'writeMs', 'checkMs'],
  'Judgment search timings': ['ms', 'searchMs', 'documentsMs', 'summariesMs'],
};

const samples = {};
const files = fs.readdirSync(dir).filter((f) => /^leylegal-web-out.*\.log$/.test(f));
for (const file of files) {
  for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
    const start = line.indexOf('{"level"');
    if (start < 0) continue;
    let entry;
    try {
      entry = JSON.parse(line.slice(start));
    } catch {
      continue;
    }
    const fields = LINES[entry.msg];
    if (!fields || new Date(entry.time) < since) continue;
    const group = entry.intent ? `${entry.msg} [${entry.intent}]` : entry.msg;
    for (const field of fields) {
      if (typeof entry[field] !== 'number') continue;
      ((samples[group] ??= {})[field] ??= []).push(entry[field]);
    }
  }
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
console.log(`Since ${since.toISOString()} - ${files.length} log file(s) in ${dir}\n`);
if (Object.keys(samples).length === 0) console.log('No timing lines yet: they are written from the release that added this script on.');
for (const group of Object.keys(samples).sort()) {
  const rows = Object.entries(samples[group]).map(([field, values]) => {
    const sorted = values.sort((a, b) => a - b);
    return { step: field, n: sorted.length, p50: pct(sorted, 50), p90: pct(sorted, 90), p95: pct(sorted, 95), p99: pct(sorted, 99), max: sorted[sorted.length - 1] };
  });
  console.log(group);
  console.table(rows);
}
