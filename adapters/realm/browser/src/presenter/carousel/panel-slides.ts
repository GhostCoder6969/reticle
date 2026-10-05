/**
 * Compact, text-first cards shown beside the project capsule in the chat footer.
 *
 * The value proposition is always available; a time-sensitive harness offer joins the rotation only
 * when the platform confirms that it applies and supplies a real destination.
 */
import { offerHtml, type OfferState } from './offer-card.js';
import type { Slide } from './carousel.js';

/** Harness comes with a plan or trial; the console has no /harness page (it redirected home). */
const HARNESS_URL = 'https://app.reticle.sh/settings?group=billing';
export const SLIDE_ID = {
  HARNESS: 'harness-journeys',
  REPLAY: 'replay-confidence',
  OFFER: 'harness-offer',
} as const;

const VALUE_SLIDES: readonly Slide[] = [
  {
    id: SLIDE_ID.HARNESS,
    html: `<div class="reticle-promo-copy"><span class="reticle-promo-kicker">RETICLE HARNESS</span><strong class="reticle-promo-title">End-to-end verification, 20× faster</strong><span class="reticle-promo-detail">Real personas. Deep coverage. Replay every flow.</span><a data-reticle-promo-link class="reticle-promo-link" href="${HARNESS_URL}" target="_blank" rel="noopener noreferrer">Explore →</a></div>`,
  },
  {
    id: SLIDE_ID.REPLAY,
    html: `<div class="reticle-promo-copy"><span class="reticle-promo-kicker">FROM RUN TO REGRESSION</span><strong class="reticle-promo-title">Keep every journey replayable</strong><span class="reticle-promo-detail">Catch what changes before users do.</span><a data-reticle-promo-link class="reticle-promo-link" href="${HARNESS_URL}" target="_blank" rel="noopener noreferrer">See how →</a></div>`,
  },
];

export function panelSlides(offer: OfferState | undefined, offerDeclined: boolean): Slide[] {
  const harnessOffer = offerHtml(offer, offerDeclined);
  return [
    ...('' === harnessOffer ? [] : [{ id: SLIDE_ID.OFFER, html: harnessOffer }]),
    ...VALUE_SLIDES,
  ];
}
