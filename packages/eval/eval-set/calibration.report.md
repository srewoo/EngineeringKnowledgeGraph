# Confidence Calibration Report

> Measures whether EKG's asserted edge confidence (HIGH=1.0 / MEDIUM=0.7 / LOW=0.4)
> matches the fraction of edges that are actually correct. Generated from a labelled
> edge sample — not declared. Regenerate with `npm run eval:calibration`.

**Verdict:** `well-calibrated`  
**Labelled edges:** 80  
**Expected Calibration Error (ECE):** 0.0125  
**Brier score:** 0.095  

| Band | Asserted | Observed | Sampled | Correct | Gap |
|---|---|---|---|---|---|
| HIGH | 1 | 0.98 | 50 | 49 | -0.02 |
| MEDIUM | 0.7 | 0.7 | 20 | 14 | +0 |
| LOW | 0.4 | 0.4 | 10 | 4 | +0 |

_Gap = observed − asserted. Negative = over-confident (extractor claims more certainty than warranted); positive = under-confident._
