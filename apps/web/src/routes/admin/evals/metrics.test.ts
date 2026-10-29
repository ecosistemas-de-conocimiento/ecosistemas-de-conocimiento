import { describe, expect, it } from 'vitest';
import { delta, pct, sparkPoints, usd } from './metrics';

describe('metrics helpers', () => {
  it('delta reads good or bad by the metric direction', () => {
    expect(delta(0.8, 0.6, true)).toEqual({ text: '+20', good: true });
    expect(delta(0.3, 0.1, false)).toEqual({ text: '+20', good: false });
    expect(delta(0.5, 0.5, true)).toEqual({ text: '±0', good: null });
    expect(delta(0.5, null, true)).toBeNull();
  });
  it('formats', () => {
    expect(pct(0.756)).toBe('76%');
    expect(pct(null)).toBe('—');
    expect(usd(0.0042)).toBe('$0.0042');
    expect(usd(0.25)).toBe('$0.25');
  });
  it('sparkline skips nulls and spans the width', () => {
    const pts = sparkPoints([0, null, 1], 100, 20);
    expect(pts).toEqual([[0, 18], [100, 2]]);
  });
});
