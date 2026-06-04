import { describe, it, expect } from 'vitest';
import { computeCalibration, ASSERTED_CONFIDENCE, type EdgeLabel } from '../../src/calibration.js';

function labels(band: EdgeLabel['confidence'], n: number, correct: number): EdgeLabel[] {
  return Array.from({ length: n }, (_, i) => ({
    edgeKey: `${band}-${i}`,
    confidence: band,
    correct: i < correct,
  }));
}

describe('computeCalibration', () => {
  it('reports insufficient-data when no band has enough samples', () => {
    const r = computeCalibration(labels('HIGH', 3, 3), { minPerBand: 10 });
    expect(r.verdict).toBe('insufficient-data');
    expect(r.totalLabelled).toBe(3);
  });

  it('reports well-calibrated when observed matches asserted', () => {
    // HIGH asserted 1.0 → all correct; MEDIUM asserted 0.7 → 7/10 correct.
    const r = computeCalibration(
      [...labels('HIGH', 20, 20), ...labels('MEDIUM', 20, 14)],
      { minPerBand: 10 },
    );
    expect(r.verdict).toBe('well-calibrated');
    expect(r.expectedCalibrationError).toBeLessThanOrEqual(0.1);
    const high = r.perBand.find((b) => b.band === 'HIGH')!;
    expect(high.observed).toBe(1);
    expect(high.asserted).toBe(ASSERTED_CONFIDENCE.HIGH);
  });

  it('flags overconfidence when observed accuracy is well below asserted', () => {
    // HIGH asserted 1.0 but only 50% correct → gap −0.5.
    const r = computeCalibration(labels('HIGH', 20, 10), { minPerBand: 10 });
    expect(r.verdict).toBe('overconfident');
    expect(r.overconfidentBands).toContain('HIGH');
    const high = r.perBand.find((b) => b.band === 'HIGH')!;
    expect(high.gap).toBeCloseTo(-0.5, 5);
  });

  it('does not flag overconfidence on under-sampled bands', () => {
    // Only 4 HIGH edges, all wrong — too few to trust the signal.
    const r = computeCalibration(
      [...labels('HIGH', 4, 0), ...labels('MEDIUM', 15, 11)],
      { minPerBand: 10 },
    );
    expect(r.overconfidentBands).not.toContain('HIGH');
  });

  it('Brier score is 0 for perfect HIGH predictions', () => {
    const r = computeCalibration(labels('HIGH', 10, 10), { minPerBand: 5 });
    expect(r.brierScore).toBe(0);
  });

  it('empty input yields zero metrics and insufficient-data', () => {
    const r = computeCalibration([], {});
    expect(r.totalLabelled).toBe(0);
    expect(r.brierScore).toBe(0);
    expect(r.expectedCalibrationError).toBe(0);
    expect(r.verdict).toBe('insufficient-data');
  });
});
