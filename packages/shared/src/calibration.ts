/**
 * Confidence calibration (Item 5).
 *
 * EKG asserts edge confidence as HIGH=1.0 / MEDIUM=0.7 / LOW=0.4
 * (`EDGE_CONFIDENCE_SCORES`). Those numbers were hand-assigned by the
 * extractor authors. This module turns the assertion into a *measurement*:
 * given a sample of edges that a human (or a re-derivation pass) has labelled
 * correct / incorrect, it computes the observed accuracy per band and the
 * standard calibration error metrics.
 *
 * Pure / deterministic. No I/O. The graph sampling + labelling happen in the
 * `calibrate` MCP tool; the math lives here so it is unit-testable in
 * isolation and reusable from the eval harness.
 */

export type ConfidenceBand = 'HIGH' | 'MEDIUM' | 'LOW';

/** Asserted score per band — mirrors EDGE_CONFIDENCE_SCORES in graph.types. */
export const ASSERTED_CONFIDENCE: Readonly<Record<ConfidenceBand, number>> = {
  HIGH: 1.0,
  MEDIUM: 0.7,
  LOW: 0.4,
} as const;

export interface EdgeLabel {
  /** Stable edge id: `${sourceId}|${type}|${targetId}`. */
  readonly edgeKey: string;
  readonly confidence: ConfidenceBand;
  /** True if the edge was judged a correct relationship, false if spurious. */
  readonly correct: boolean;
}

export interface BandCalibration {
  readonly band: ConfidenceBand;
  readonly asserted: number;
  /** Observed fraction correct in the sample. */
  readonly observed: number;
  readonly sampled: number;
  readonly correct: number;
  /** observed − asserted. Negative = over-confident; positive = under-confident. */
  readonly gap: number;
}

export interface CalibrationReport {
  readonly totalLabelled: number;
  readonly perBand: readonly BandCalibration[];
  /** Expected Calibration Error: sample-weighted mean |observed − asserted|. */
  readonly expectedCalibrationError: number;
  /** Brier score over all labelled edges (lower is better; 0 = perfect). */
  readonly brierScore: number;
  /** Bands where the extractor is materially over-confident (gap < −0.1). */
  readonly overconfidentBands: readonly ConfidenceBand[];
  readonly verdict: 'well-calibrated' | 'review' | 'overconfident' | 'insufficient-data';
}

const BANDS: readonly ConfidenceBand[] = ['HIGH', 'MEDIUM', 'LOW'];

function round(n: number): number {
  return Number(n.toFixed(4));
}

/**
 * Compute calibration from a set of labelled edges. Bands with no samples are
 * omitted from `perBand` and excluded from ECE/Brier (you can only measure
 * what was labelled). `minPerBand` gates the verdict so a 2-edge sample never
 * reports "overconfident" with false authority.
 */
export function computeCalibration(
  labels: readonly EdgeLabel[],
  opts: { readonly minPerBand?: number } = {},
): CalibrationReport {
  const minPerBand = opts.minPerBand ?? 10;
  const perBand: BandCalibration[] = [];
  let brierSum = 0;
  let eceWeightedSum = 0;

  for (const band of BANDS) {
    const inBand = labels.filter((l) => l.confidence === band);
    if (inBand.length === 0) continue;
    const correct = inBand.filter((l) => l.correct).length;
    const observed = correct / inBand.length;
    const asserted = ASSERTED_CONFIDENCE[band];
    perBand.push({
      band,
      asserted,
      observed: round(observed),
      sampled: inBand.length,
      correct,
      gap: round(observed - asserted),
    });
    eceWeightedSum += inBand.length * Math.abs(observed - asserted);
  }

  for (const l of labels) {
    const p = ASSERTED_CONFIDENCE[l.confidence];
    const y = l.correct ? 1 : 0;
    brierSum += (p - y) * (p - y);
  }

  const totalLabelled = labels.length;
  const expectedCalibrationError = totalLabelled === 0 ? 0 : round(eceWeightedSum / totalLabelled);
  const brierScore = totalLabelled === 0 ? 0 : round(brierSum / totalLabelled);

  // Only trust over-confidence signal on bands with enough samples.
  const overconfidentBands = perBand
    .filter((b) => b.sampled >= minPerBand && b.gap < -0.1)
    .map((b) => b.band);

  const verdict = pickVerdict(perBand, minPerBand, overconfidentBands, expectedCalibrationError);

  return {
    totalLabelled,
    perBand,
    expectedCalibrationError,
    brierScore,
    overconfidentBands,
    verdict,
  };
}

function pickVerdict(
  perBand: readonly BandCalibration[],
  minPerBand: number,
  overconfidentBands: readonly ConfidenceBand[],
  ece: number,
): CalibrationReport['verdict'] {
  const haveEnough = perBand.some((b) => b.sampled >= minPerBand);
  if (!haveEnough) return 'insufficient-data';
  if (overconfidentBands.length > 0) return 'overconfident';
  if (ece <= 0.1) return 'well-calibrated';
  return 'review';
}
