#!/usr/bin/env node
/**
 * One-off: bucket active (non-archived) repos in a GitLab group by size.
 * Usage: node scripts/count-large-repos.mjs <groupId>
 */
import dotenv from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '..', '.env') });

const { GitLabClient } = await import('../packages/parser/dist/index.js');

const GROUP_ID = parseInt(process.argv[2] ?? '6877322', 10);

const token = process.env.GIT_TOKEN;
const gitlabUrl = process.env.GITLAB_URL ?? 'https://gitlab.com';
if (!token) {
  console.error('GIT_TOKEN not set');
  process.exit(1);
}

const client = new GitLabClient();
const repos = await client.discoverRepos({
  gitlabUrl,
  token,
  groupIds: [GROUP_ID],
  maxRepoSizeMb: 1_000_000,
});

// Size buckets in MB. Upper bound is exclusive of next bucket's lower.
const buckets = [
  { label: '0',           min: 0,    max: 0    },
  { label: '> 0 – 10MB',  min: 0,    max: 10   },
  { label: '10 – 50MB',   min: 10,   max: 50   },
  { label: '50 – 100MB',  min: 50,   max: 100  },
  { label: '100 – 250MB', min: 100,  max: 250  },
  { label: '250 – 500MB', min: 250,  max: 500  },
  { label: '500MB – 1GB', min: 500,  max: 1024 },
  { label: '1 – 2GB',     min: 1024, max: 2048 },
  { label: '> 2GB',       min: 2048, max: Infinity },
];

const counts = buckets.map(() => 0);
const totals = buckets.map(() => 0); // total MB per bucket

for (const r of repos) {
  const s = r.repoSizeMb;
  let idx;
  if (s === 0) idx = 0;
  else {
    idx = buckets.findIndex((b, i) => i > 0 && s > b.min && s <= b.max);
  }
  if (idx === -1) continue;
  counts[idx]++;
  totals[idx] += s;
}

const totalRepos = repos.length;
const totalSizeMb = repos.reduce((acc, r) => acc + r.repoSizeMb, 0);

// Render table
const rows = buckets.map((b, i) => ({
  bucket: b.label,
  repos: counts[i],
  pct: totalRepos ? ((counts[i] / totalRepos) * 100).toFixed(1) + '%' : '0%',
  totalGb: (totals[i] / 1024).toFixed(2),
}));

const colWidths = {
  bucket: Math.max(12, ...rows.map((r) => r.bucket.length)),
  repos:  Math.max(5,  ...rows.map((r) => String(r.repos).length)),
  pct:    Math.max(5,  ...rows.map((r) => r.pct.length)),
  totalGb:Math.max(8,  ...rows.map((r) => r.totalGb.length)),
};

const pad = (s, w, right = false) => right ? String(s).padStart(w) : String(s).padEnd(w);
const sep = '+-' + '-'.repeat(colWidths.bucket) + '-+-' + '-'.repeat(colWidths.repos) + '-+-' + '-'.repeat(colWidths.pct) + '-+-' + '-'.repeat(colWidths.totalGb) + '-+';

console.log('');
console.log(`Group ${GROUP_ID} — ${totalRepos} active repos (${(totalSizeMb / 1024).toFixed(2)} GB total, archived excluded)`);
console.log(sep);
console.log('| ' + pad('Size bucket', colWidths.bucket) + ' | ' + pad('Repos', colWidths.repos, true) + ' | ' + pad('Share', colWidths.pct, true) + ' | ' + pad('Total GB', colWidths.totalGb, true) + ' |');
console.log(sep);
for (const r of rows) {
  console.log('| ' + pad(r.bucket, colWidths.bucket) + ' | ' + pad(r.repos, colWidths.repos, true) + ' | ' + pad(r.pct, colWidths.pct, true) + ' | ' + pad(r.totalGb, colWidths.totalGb, true) + ' |');
}
console.log(sep);

// Top 10
const top = [...repos].sort((a, b) => b.repoSizeMb - a.repoSizeMb).slice(0, 10);
console.log('\nTop 10 largest repos:');
const nameW = Math.max(4, ...top.map((r) => r.fullPath.length));
console.log('  ' + pad('Repo', nameW) + '   Size (MB)');
console.log('  ' + '-'.repeat(nameW) + '   ---------');
for (const r of top) console.log('  ' + pad(r.fullPath, nameW) + '   ' + pad(r.repoSizeMb, 9, true));
