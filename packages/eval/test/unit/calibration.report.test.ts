/**
 * Verifies the committed calibration sample produces a real, sane number and
 * that the renderer emits a well-formed report. Guards against the calibration
 * pipeline silently breaking (e.g. a labels-file schema change) and keeps the
 * committed `calibration.report.md` artifact honest.
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { computeCalibration } from '@ekg/shared';
import { loadLabels, renderCalibrationReport } from '../../src/calibration.report.js';

const here = dirname(fileURLToPath(import.meta.url));
const labelsPath = resolve(here, '..', '..', 'eval-set', 'calibration.labels.json');

describe('calibration sample → report', () => {
  const labels = loadLabels(labelsPath);

  it('loads a non-trivial labelled sample covering all three bands', () => {
    expect(labels.length).toBeGreaterThanOrEqual(50);
    const bands = new Set(labels.map((l) => l.confidence));
    expect(bands).toEqual(new Set(['HIGH', 'MEDIUM', 'LOW']));
  });

  it('computes a well-calibrated verdict with low ECE on the seed sample', () => {
    const report = computeCalibration(labels);
    expect(report.verdict).toBe('well-calibrated');
    expect(report.expectedCalibrationError).toBeLessThanOrEqual(0.1);
    expect(report.totalLabelled).toBe(labels.length);
    expect(report.perBand).toHaveLength(3);
  });

  it('renders a markdown report with a verdict and per-band table', () => {
    const md = renderCalibrationReport(computeCalibration(labels));
    expect(md).toContain('# Confidence Calibration Report');
    expect(md).toContain('**Verdict:**');
    expect(md).toContain('| HIGH |');
    expect(md).toContain('| MEDIUM |');
    expect(md).toContain('| LOW |');
  });
});
