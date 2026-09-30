import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { coloursOf, DEMO_ASSET_GENERATOR_VERSION, placeholderSvg } from '@garderobe/demo';
import { checkTrustedSvg } from '../../src/media/svg.js';
import { descriptorFromSvg } from '../../src/media/fakes.js';
import { checkFidelity, deltaE } from '../../src/media/fidelity.js';
import { visualScenario } from '../helpers/visual.js';

describe(`DEMO placeholder garment images (${DEMO_ASSET_GENERATOR_VERSION})`, () => {
  it('every garment of the real wardrobe (May 2026 CSV) gets a deterministic, labelled, allowlisted SVG in its own colours', async () => {
    const s = await visualScenario({ placeholders: true, deps: {} });
    const { results } = await env.DB.prepare('SELECT garment_id, name, category, color, pattern FROM garments WHERE user_id = ?').bind(s.userId).all<{ garment_id: string; name: string; category: string; color: string | null; pattern: string | null }>();
    expect(results.length).toBeGreaterThanOrEqual(127);
    for (const g of results) {
      const p = placeholderSvg(g);
      expect(placeholderSvg(g).svg).toBe(p.svg);
      expect(checkTrustedSvg(p.svg)).toEqual({ ok: true, problems: [] });
      expect(p.svg).toContain('data-garderobe="demo-placeholder"');
      expect(p.svg).toContain('>DEMO</text>');
      expect(p.svg).toContain(`DEMO placeholder — ${g.name.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/</g, '&lt;')}`);
    }
    // Every garment got exactly one catalogue placeholder, labelled and not verified.
    const linked = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM garment_media gm JOIN media_assets ma ON ma.user_id = gm.user_id AND ma.asset_id = gm.asset_id WHERE gm.user_id = ? AND gm.role = 'catalogue' AND gm.verified = 0 AND ma.asset_class = 'demo_placeholder' AND ma.label = 'Demo placeholder'",
    )
      .bind(s.userId)
      .first<{ n: number }>();
    const disposed = (await env.DB.prepare("SELECT COUNT(*) AS n FROM garments WHERE user_id = ? AND acquisition = 'disposed'").bind(s.userId).first<{ n: number }>())!.n;
    expect(linked!.n).toBe(results.length - disposed);
  });

  it('colours and patterns come from the recorded colour text', () => {
    expect(coloursOf('Light blue wide stripe')).toEqual(['#A8C5E2']);
    expect(coloursOf('Rust+grey')).toEqual(['#A5522F', '#8A8C8E']);
    expect(coloursOf('Inky Blue')).toEqual(['#1E2740']);
    expect(coloursOf('Slate+navy plaid')).toEqual(['#5F6B75', '#1F2A44']);
    expect(placeholderSvg({ name: 'Lightweight oxford — light blue wide stripe', category: 'shirt', color: 'Light blue wide stripe' }).pattern).toBe('stripe');
    expect(placeholderSvg({ name: 'Flannel plaid — rust+grey', category: 'shirt', color: 'Rust+grey' }).pattern).toBe('check');
    expect(placeholderSvg({ name: "Drake's red polka-dot", category: 'accessory', color: 'Red' }).pattern).toBe('dots');
    expect(placeholderSvg({ name: 'Mystery', category: 'shirt', color: null }).colours).toEqual(['#9A9A9A']);
  });

  it('the fidelity checks see real differences in the placeholders', () => {
    const a = descriptorFromSvg(placeholderSvg({ name: 'x', category: 'shirt', color: 'Gold' }).svg);
    const b = descriptorFromSvg(placeholderSvg({ name: 'x', category: 'shirt', color: 'Light blue' }).svg);
    expect(checkFidelity(a, a).passed).toBe(true);
    const r = checkFidelity(a, b);
    expect(r.passed).toBe(false);
    expect(r.checks.find((c) => c.name === 'dominant_colours')!.passed).toBe(false);
    expect(deltaE('#D9B44A', '#D9B44A')).toBe(0);
    expect(deltaE('#D9B44A', '#1F2A44')!).toBeGreaterThan(40);
    expect(deltaE('#D9B44A', '#DAB54B')!).toBeLessThan(2);
  });
});
