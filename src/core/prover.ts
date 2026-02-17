import type { RailgunArtifacts } from './artifacts'
import { getArtifacts } from './artifacts'

import { dwarn } from '@/utils/debug'

type FormattedCircuitInputsRailgun = {
  merkleRoot: bigint
  boundParamsHash: bigint
  nullifiers: bigint[]
  commitmentsOut: bigint[]
  token: bigint
  publicKey: bigint[]
  signature: bigint[]
  randomIn: (string | bigint)[]
  valueIn: bigint[]
  pathElements: bigint[]
  leavesIndices: bigint[]
  nullifyingKey: bigint
  npkOut: bigint[]
  valueOut: bigint[]
}

type ProveResult = { proof: any; publicSignals: string[]; vkey: any }

/**
 * Generate a Groth16 zk-SNARK proof for a RAILGUN V2 transaction.
 * @param formattedInputs - The circuit inputs formatted for the RAILGUN proving circuit
 * @param nullifierCount - The number of nullifiers (inputs) in the transaction
 * @param commitmentCount - The number of commitments (outputs) in the transaction
 * @param onProgress - Optional callback reporting proof generation progress percentage
 * @returns The generated proof, public signals, and verification key
 */
const proveRailgunV2 = async (
  formattedInputs: FormattedCircuitInputsRailgun,
  nullifierCount: number,
  commitmentCount: number,
  onProgress?: (p: number) => void
): Promise<ProveResult> => {
  const artifacts: RailgunArtifacts = await getArtifacts(nullifierCount, commitmentCount)
  onProgress?.(10)

  try {
    // fs polyfill required before importing snarkjs (EJS checks fs.readFileSync at module load)
    const fsPolyfill = {
      /**
       * Stub readFileSync that returns empty content for browser compatibility.
       * @param _path - The file path (unused)
       * @param encoding - Optional encoding; determines return type
       * @returns An empty string or empty Buffer depending on encoding
       */
      readFileSync: (_path: string, encoding?: string) => {
        return encoding ? '' : Buffer.from('')
      },
      /**
       * Stub existsSync that always returns false in the browser.
       * @returns Always false
       */
      existsSync: () => false,
      /**
       * Stub statSync that returns an object reporting no file or directory.
       * @returns A stat-like object with isFile and isDirectory methods
       */
      statSync: () => ({
        /**
         * Reports that the path is not a file.
         * @returns Always false
         */
        isFile: () => false,
        /**
         * Reports that the path is not a directory.
         * @returns Always false
         */
        isDirectory: () => false,
      }),
      /**
       * Stub readdirSync that returns an empty directory listing.
       * @returns An empty array
       */
      readdirSync: () => [],
      /**
       * Stub async readFile that invokes the callback with empty content.
       * @param _path - The file path (unused)
       * @param args - Additional arguments including the callback
       */
      readFile: (_path: string, ...args: any[]) => {
        const callback = args[args.length - 1]
        if (typeof callback === 'function') callback(null, '')
      },
      /**
       * Stub writeFileSync that performs no operation in the browser.
       */
      writeFileSync: () => {},
      /**
       * Stub async writeFile that invokes the callback with no error.
       * @param _path - The file path (unused)
       * @param _data - The data to write (unused)
       * @param args - Additional arguments including the callback
       */
      writeFile: (_path: string, _data: any, ...args: any[]) => {
        const callback = args[args.length - 1]
        if (typeof callback === 'function') callback(null)
      },
    }

    if (typeof window !== 'undefined') {
      ;(window as any).fs = fsPolyfill
      if (!(window as any).global) {
        ;(window as any).global = window
      }
      ;(window as any).global.fs = fsPolyfill
      if ((window as any).require) {
        try {
          ;(window as any).require.cache = (window as any).require.cache || {}
          ;(window as any).require.cache['fs'] = { exports: fsPolyfill }
        } catch {
          // Not critical
        }
      }
    }

    const snarkjs = await import('snarkjs')

    if (typeof SharedArrayBuffer === 'undefined') {
      dwarn('SharedArrayBuffer not available - proof generation may fail due to memory limits')
    }

    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      formattedInputs as any,
      artifacts.wasm,
      artifacts.zkey
    )
    onProgress?.(98)

    const { vkey } = artifacts
    return { proof, publicSignals, vkey }
  } catch (error) {
    if (error instanceof Error) {
      if (
        error.message.includes('could not allocate memory') ||
        error.message.includes('out of memory')
      ) {
        throw new Error(
          'Browser ran out of memory during proof generation. ' +
            'Try restarting your browser, closing other tabs, or using a desktop browser. ' +
            `Original error: ${error.message}`
        )
      }
    }
    throw error
  }
}

export type { FormattedCircuitInputsRailgun, ProveResult }
export { proveRailgunV2 }
