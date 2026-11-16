import { CONTENT_MAX_WIDTH, FORM_MAX_WIDTH, screenOptions } from './layout';

describe('mobile layout (header must not cover content)', () => {
  it('uses an opaque header so screens start below it (iOS 26 defaults to a translucent one)', () => {
    expect(screenOptions.headerTransparent).toBe(false);
    expect(screenOptions.headerStyle).toEqual(expect.objectContaining({ backgroundColor: expect.any(String) }));
    expect(screenOptions.contentStyle).toEqual(expect.objectContaining({ backgroundColor: expect.any(String) }));
  });

  it('caps content width so tablets and landscape stay readable', () => {
    expect(CONTENT_MAX_WIDTH).toBeGreaterThanOrEqual(600);
    expect(FORM_MAX_WIDTH).toBeLessThan(CONTENT_MAX_WIDTH);
  });
});
