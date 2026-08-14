// Credit helper — convert USD spend into consumer-facing "credits".
//
// Per the M5 deliverable: rounding strategy is *up* (ceil) so the consumer
// never under-counts spend (preferring a slight over-charge to a slight
// under-charge). Negative rates are rejected loudly; negative USD is allowed
// (it means a refund/adjust in the consumer's ledger).

export function toCredits(usd: number, rate: number): number {
  if (!Number.isFinite(usd)) throw new TypeError('toCredits: usd must be a finite number');
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new TypeError('toCredits: rate must be a positive finite number (credits per USD)');
  }
  return Math.ceil(usd * rate);
}
