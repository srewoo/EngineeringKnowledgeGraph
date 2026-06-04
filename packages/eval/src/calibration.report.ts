#!/usr/bin/env node
/**
 * Calibration report (Item: produce a real calibration number).
 *
 * Reads a labelled edge sample (edges sampled via the `calibrate` MCP tool and
 * judged correct/incorrect), runs `computeCalibration` from @ekg/shared, and
 * renders a Markdown report. This turns "avg confidence 0.8" from a declaration
 * into a measured artifact (`calibration.report.md`).
 *
 * CLI:
 *   ekg-calibration [labels.json] [--out report.md]
 *   (defaults: eval-set/calibration.labels.json → eval-set/calibration.report.md)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { computeCalibration, type CalibrationReport, type EdgeLabel } from '@ekg/shared';

const labelSchema = z.object({
  edgeKey: z.string().min(1),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  correct: z.boolean(),
});
const fileSchema = z.union([
  z.array(labelSchema),
  z.object({ labels: z.array(labelSchema) }),
]);

export function loadLabels(path: string): EdgeLabel[] {
  const parsed = fileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const rows = Array.isArray(parsed) ? parsed : parsed.labels;
  return rows.map((r) => ({ edgeKey: r.edgeKey, confidence: r.confidence, correct: r.correct }));
}

export function renderCalibrationReport(report: CalibrationReport): string {
  const lines: string[] = [];
  lines.push('# Confidence Calibration Report');
  lines.push('');
  lines.push('> Measures whether EKG\'s asserted edge confidence (HIGH=1.0 / MEDIUM=0.7 / LOW=0.4)');
  lines.push('> matches the fraction of edges that are actually correct. Generated from a labelled');
  lines.push('> edge sample — not declared. Regenerate with `npm run eval:calibration`.');
  lines.push('');
  lines.push(`**Verdict:** \`${report.verdict}\`  `);
  lines.push(`**Labelled edges:** ${report.totalLabelled}  `);
  lines.push(`**Expected Calibration Error (ECE):** ${report.expectedCalibrationError}  `);
  lines.push(`**Brier score:** ${report.brierScore}  `);
  if (report.overconfidentBands.length > 0) {
    lines.push(`**Over-confident bands:** ${report.overconfidentBands.join(', ')}  `);
  }
  lines.push('');
  lines.push('| Band | Asserted | Observed | Sampled | Correct | Gap |');
  lines.push('|---|---|---|---|---|---|');
  for (const b of report.perBand) {
    const gap = b.gap >= 0 ? `+${b.gap}` : `${b.gap}`;
    lines.push(`| ${b.band} | ${b.asserted} | ${b.observed} | ${b.sampled} | ${b.correct} | ${gap} |`);
  }
  lines.push('');
  lines.push('_Gap = observed − asserted. Negative = over-confident (extractor claims more certainty than warranted); positive = under-confident._');
  lines.push('');
  return lines.join('\n');
}

function evalSetDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'eval-set');
}

function main(): void {
  const args = process.argv.slice(2);
  let labelsPath: string | undefined;
  let outPath: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--out') { outPath = args[i + 1]; i += 1; }
    else if (!args[i]!.startsWith('--')) { labelsPath = args[i]; }
  }
  const labels = loadLabels(labelsPath ?? resolve(evalSetDir(), 'calibration.labels.json'));
  const report = computeCalibration(labels);
  const md = renderCalibrationReport(report);
  const dest = outPath ?? resolve(evalSetDir(), 'calibration.report.md');
  writeFileSync(dest, md, 'utf8');
  process.stdout.write(`calibration: verdict=${report.verdict} ece=${report.expectedCalibrationError} brier=${report.brierScore} → ${dest}\n`);
}

// Run as CLI only when invoked directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
