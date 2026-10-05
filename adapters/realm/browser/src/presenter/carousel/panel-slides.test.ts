/**
 * Text-first Harness value cards are always useful; the offer only appears when eligible.
 */
import { describe, expect, it } from 'vitest';
import { panelSlides } from './panel-slides.js';

const CLAIM_URL = 'https://app.reticle.sh/harness';

describe('panelSlides', () => {
  it('leads with the offer when it applies, followed by product value cards', () => {
    const ids = panelSlides({ claimed: false, claimUrl: CLAIM_URL }, false).map((s) => s.id);
    expect(ids).toEqual(['harness-offer', 'harness-journeys', 'replay-confidence']);
  });

  it('shows the value cards when no offer is known', () => {
    expect(panelSlides(undefined, false).map((s) => s.id)).toEqual([
      'harness-journeys',
      'replay-confidence',
    ]);
  });

  it('keeps the product value cards when somebody already declined the offer', () => {
    expect(panelSlides({ claimed: false, claimUrl: CLAIM_URL }, true).map((s) => s.id)).toEqual([
      'harness-journeys',
      'replay-confidence',
    ]);
  });
});
