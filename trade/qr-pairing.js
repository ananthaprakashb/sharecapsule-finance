(() => {
  'use strict';
  const base = window.ShareCapsuleQR;
  if (!base) return;
  const LONG_PREFIX = 'https://finance.sharecapsule.org/trade/#tw=';
  const SHORT_PREFIX = 'https://finance.sharecapsule.org/p/#t=';
  window.ShareCapsuleQR = Object.freeze({
    maxBytes: base.maxBytes,
    makeMatrix: base.makeMatrix,
    render(canvas, text, options) {
      const value = String(text || '');
      const encoded = value.startsWith(LONG_PREFIX) ? SHORT_PREFIX + value.slice(LONG_PREFIX.length) : value;
      return base.render(canvas, encoded, options);
    }
  });
})();
