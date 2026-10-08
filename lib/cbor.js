'use strict';

// Minimal CBOR decoder (RFC 8949), just the subset a WebAuthn client emits:
// ints, byte/text strings, arrays, maps, tags and simple values. Byte strings
// come back as Uint8Array; maps as Map so numeric COSE keys survive.

function readUint(state, info) {
  const { view } = state;
  if (info < 24) return info;
  if (info === 24) {
    const value = view.getUint8(state.offset);
    state.offset += 1;
    return value;
  }
  if (info === 25) {
    const value = view.getUint16(state.offset);
    state.offset += 2;
    return value;
  }
  if (info === 26) {
    const value = view.getUint32(state.offset);
    state.offset += 4;
    return value;
  }
  if (info === 27) {
    const high = view.getUint32(state.offset);
    const low = view.getUint32(state.offset + 4);
    state.offset += 8;
    return high * 2 ** 32 + low;
  }
  throw new Error('unsupported CBOR length encoding');
}

function decodeItem(state) {
  const { view } = state;
  const initial = view.getUint8(state.offset);
  state.offset += 1;
  const major = initial >> 5;
  const info = initial & 0x1f;

  switch (major) {
    case 0:
      return readUint(state, info);
    case 1:
      return -1 - readUint(state, info);
    case 2: {
      const length = readUint(state, info);
      const bytes = new Uint8Array(view.buffer, view.byteOffset + state.offset, length);
      state.offset += length;
      return bytes;
    }
    case 3: {
      const length = readUint(state, info);
      const bytes = new Uint8Array(view.buffer, view.byteOffset + state.offset, length);
      state.offset += length;
      return new TextDecoder().decode(bytes);
    }
    case 4: {
      const length = readUint(state, info);
      const array = [];
      for (let i = 0; i < length; i += 1) array.push(decodeItem(state));
      return array;
    }
    case 5: {
      const length = readUint(state, info);
      const map = new Map();
      for (let i = 0; i < length; i += 1) {
        const key = decodeItem(state);
        map.set(key, decodeItem(state));
      }
      return map;
    }
    case 6:
      readUint(state, info);
      return decodeItem(state);
    case 7:
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      if (info === 23) return undefined;
      if (info === 25) {
        const value = view.getFloat16(state.offset);
        state.offset += 2;
        return value;
      }
      if (info === 26) {
        const value = view.getFloat32(state.offset);
        state.offset += 4;
        return value;
      }
      if (info === 27) {
        const value = view.getFloat64(state.offset);
        state.offset += 8;
        return value;
      }
      return info;
    default:
      throw new Error('invalid CBOR major type');
  }
}

/** Decode the first CBOR item in `input`; returns { value, offset }. */
function decodeFirst(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const state = { view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset: 0 };
  const value = decodeItem(state);
  return { value, offset: state.offset };
}

module.exports = { decodeFirst };
