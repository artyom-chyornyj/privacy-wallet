declare module 'crypto-browserify'

declare module '@railgun-community/circomlibjs' {
  export const poseidon: (inputs: Array<bigint | number | string>) => bigint
  const _default: any
  export default _default
}

// snarkjs is pulled dynamically in browser; provide a loose module declaration
declare module 'snarkjs' {
  export const groth16: {
    fullProve: (
      witness: Record<string, unknown>,
      wasm: string | Uint8Array,
      zkey: string | Uint8Array,
    ) => Promise<{ proof: any; publicSignals: string[] }>
    verify: (
      vkey: object,
      publicSignals: Array<string | bigint>,
      proof: any,
      logger?: object,
    ) => Promise<boolean>
  }
}
