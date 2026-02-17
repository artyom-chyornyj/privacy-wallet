import * as ed from '@noble/ed25519'
import initCurve25519wasm, {
  scalarMultiply as scalarMultiplyWasm,
} from '@railgun-community/curve25519-scalarmult-wasm'
import { bytesToHex } from 'ethereum-cryptography/utils'

import { ByteLength, ByteUtils } from './crypto'

import { derror, dlog } from '@/utils/debug'

// In @noble/ed25519 v3, Point is exported directly
const Point = ed.Point

/**
 * Initializes the curve25519 WASM module, falling back silently to JavaScript on failure.
 * @returns A promise that resolves when initialization completes
 */
const initCurve25519Wasm = (): Promise<any> => {
  try {
    // Try WASM implementation.
    return typeof initCurve25519wasm === 'function' ? initCurve25519wasm() : Promise.resolve()
  } catch (cause) {
    if (!(cause instanceof Error)) {
      throw new Error('Non-error thrown from initCurve25519Wasm')
    }
    // Fallback to Javascript. No init needed.
    dlog('curve25519-scalarmult-wasm init failed: Fallback to JavaScript')
    derror(cause)
    return Promise.resolve()
  }
}
// Initialize WASM on module load (side-effect)
initCurve25519Wasm()

/**
 * Performs elliptic curve scalar multiplication using WASM, falling back to JavaScript on failure.
 * @param point - The curve point as a Uint8Array
 * @param scalar - The scalar multiplier as a bigint
 * @returns The resulting curve point as a Uint8Array
 */
const scalarMultiplyWasmFallbackToJavascript = (
  point: Uint8Array,
  scalar: bigint
): Uint8Array => {
  if (!scalarMultiplyWasm) {
    // Fallback to JavaScript if this module is running directly in React Native
    return scalarMultiplyJavascript(point, scalar)
  }
  try {
    // Try WASM implementation.
    const scalarUint8Array = ByteUtils.nToBytes(scalar, ByteLength.UINT_256)
    return scalarMultiplyWasm(point, scalarUint8Array)
  } catch (cause) {
    if (!(cause instanceof Error)) {
      throw new Error('Non-error thrown from scalarMultiplyWasmFallbackToJavascript')
    }
    if (cause.message.includes('invalid y coordinate')) {
      // Noble/ed25519 would also throw this error, so no need to call Noble
      throw new Error('scalarMultiply failed')
    }
    // Fallback to Javascript.
    dlog('curve25519-scalarmult-wasm scalarMultiply failed: Fallback to JavaScript')
    derror(cause)
    return scalarMultiplyJavascript(point, scalar)
  }
}

/**
 * Pure JavaScript fallback for elliptic curve scalar multiplication using noble/ed25519.
 * @param point - The curve point as a Uint8Array
 * @param scalar - The scalar multiplier as a bigint
 * @returns The resulting curve point as a Uint8Array
 */
const scalarMultiplyJavascript = (point: Uint8Array, scalar: bigint) => {
  const pk = Point.fromHex(bytesToHex(point))
  return pk.multiply(scalar).toBytes()
}

export { scalarMultiplyWasmFallbackToJavascript }
