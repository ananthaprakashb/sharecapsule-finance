(() => {
  'use strict';

  const VERSION = 5;
  const SIZE = 17 + VERSION * 4;
  const DATA_CODEWORDS = 108;
  const ECC_CODEWORDS = 26;
  const MAX_BYTES = 106;

  function gfMul(x, y) {
    let z = 0;
    for (let i = 0; i < 8; i++) {
      if (y & 1) z ^= x;
      const carry = x & 0x80;
      x = (x << 1) & 0xff;
      if (carry) x ^= 0x1d;
      y >>>= 1;
    }
    return z;
  }

  function rsGenerator(degree) {
    let gen = [1];
    let root = 1;
    for (let i = 0; i < degree; i++) {
      const next = new Array(gen.length + 1).fill(0);
      for (let j = 0; j < gen.length; j++) {
        next[j] ^= gen[j];
        next[j + 1] ^= gfMul(gen[j], root);
      }
      gen = next;
      root = gfMul(root, 2);
    }
    return gen;
  }

  function formatBits() {
    const data = 0b01000; // Error correction L (01), mask 0.
    let remainder = data << 10;
    const polynomial = 0x537;
    for (let i = 14; i >= 10; i--) {
      if ((remainder >>> i) & 1) remainder ^= polynomial << (i - 10);
    }
    return ((data << 10) | remainder) ^ 0x5412;
  }

  function encodeCodewords(text) {
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > MAX_BYTES) throw new Error(`Pairing QR payload is too large (${bytes.length}/${MAX_BYTES} bytes)`);

    const bits = [];
    const appendBits = (value, count) => {
      for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
    };

    appendBits(0b0100, 4);
    appendBits(bytes.length, 8);
    for (const value of bytes) appendBits(value, 8);

    const capacity = DATA_CODEWORDS * 8;
    for (let i = 0; i < Math.min(4, capacity - bits.length); i++) bits.push(0);
    while (bits.length % 8) bits.push(0);

    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
      let value = 0;
      for (let j = 0; j < 8; j++) value = (value << 1) | bits[i + j];
      data.push(value);
    }

    const pads = [0xec, 0x11];
    let padIndex = 0;
    while (data.length < DATA_CODEWORDS) data.push(pads[padIndex++ % 2]);

    const generator = rsGenerator(ECC_CODEWORDS);
    let remainder = new Array(ECC_CODEWORDS).fill(0);
    for (const value of data) {
      const factor = value ^ remainder[0];
      remainder = remainder.slice(1);
      remainder.push(0);
      for (let i = 0; i < ECC_CODEWORDS; i++) remainder[i] ^= gfMul(generator[i + 1], factor);
    }
    return data.concat(remainder);
  }

  function makeMatrix(text) {
    const codewords = encodeCodewords(text);
    const modules = Array.from({ length: SIZE }, () => new Array(SIZE).fill(null));
    const isFunction = Array.from({ length: SIZE }, () => new Array(SIZE).fill(false));

    const setFunction = (row, col, dark) => {
      if (row < 0 || col < 0 || row >= SIZE || col >= SIZE) return;
      modules[row][col] = Boolean(dark);
      isFunction[row][col] = true;
    };

    const drawFinder = (centerRow, centerCol) => {
      for (let dr = -4; dr <= 4; dr++) {
        for (let dc = -4; dc <= 4; dc++) {
          const distance = Math.max(Math.abs(dr), Math.abs(dc));
          setFunction(centerRow + dr, centerCol + dc, distance <= 3 && (distance === 3 || distance <= 1));
        }
      }
    };

    drawFinder(3, 3);
    drawFinder(3, SIZE - 4);
    drawFinder(SIZE - 4, 3);

    for (let i = 8; i < SIZE - 8; i++) {
      setFunction(6, i, i % 2 === 0);
      setFunction(i, 6, i % 2 === 0);
    }

    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const distance = Math.max(Math.abs(dr), Math.abs(dc));
        setFunction(30 + dr, 30 + dc, distance === 2 || distance === 0);
      }
    }

    const format = formatBits();
    const getFormatBit = (i) => ((format >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) setFunction(i, 8, getFormatBit(i));
    setFunction(7, 8, getFormatBit(6));
    setFunction(8, 8, getFormatBit(7));
    setFunction(8, 7, getFormatBit(8));
    for (let i = 9; i < 15; i++) setFunction(8, 14 - i, getFormatBit(i));
    for (let i = 0; i < 8; i++) setFunction(8, SIZE - 1 - i, getFormatBit(i));
    for (let i = 8; i < 15; i++) setFunction(SIZE - 15 + i, 8, getFormatBit(i));
    setFunction(SIZE - 8, 8, true);

    const dataBits = [];
    for (const value of codewords) {
      for (let i = 7; i >= 0; i--) dataBits.push((value >>> i) & 1);
    }

    let bitIndex = 0;
    let right = SIZE - 1;
    let upward = true;
    while (right >= 1) {
      if (right === 6) right--;
      for (let vertical = 0; vertical < SIZE; vertical++) {
        const row = upward ? SIZE - 1 - vertical : vertical;
        for (let offset = 0; offset < 2; offset++) {
          const col = right - offset;
          if (isFunction[row][col]) continue;
          let dark = bitIndex < dataBits.length ? dataBits[bitIndex++] === 1 : false;
          if ((row + col) % 2 === 0) dark = !dark;
          modules[row][col] = dark;
        }
      }
      upward = !upward;
      right -= 2;
    }
    return modules;
  }

  function render(canvas, text, options = {}) {
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('A canvas element is required');
    const matrix = makeMatrix(text);
    const quiet = 4;
    const moduleSize = Math.max(4, Number(options.moduleSize) || 7);
    const side = (SIZE + quiet * 2) * moduleSize;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(side * ratio);
    canvas.height = Math.round(side * ratio);
    canvas.style.width = `${side}px`;
    canvas.style.height = `${side}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, side, side);
    ctx.fillStyle = '#07101d';
    for (let row = 0; row < SIZE; row++) {
      for (let col = 0; col < SIZE; col++) {
        if (matrix[row][col]) ctx.fillRect((col + quiet) * moduleSize, (row + quiet) * moduleSize, moduleSize, moduleSize);
      }
    }
    return { size: SIZE, bytes: new TextEncoder().encode(text).length };
  }

  window.ShareCapsuleQR = Object.freeze({ render, makeMatrix, maxBytes: MAX_BYTES });
})();
