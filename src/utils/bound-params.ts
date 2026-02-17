import { ethers } from 'ethers'

import { ByteLength, ByteUtils } from './crypto'
import { SNARK_PRIME } from './railgun-crypto'

import type { CommitmentCiphertextStruct } from '@/types/core'

type BoundParamsV2 = {
  treeNumber: bigint // uint16
  minGasPrice: bigint // uint48
  unshield: bigint // uint8
  chainID: bigint // uint64
  adaptContract: string
  adaptParams: string // bytes32 (32 bytes)
  commitmentCiphertext: CommitmentCiphertextStruct[]
}

/**
 * Compute bound params hash V2 exactly /src/transaction/bound-params.ts
 * @param boundParams - The V2 bound parameters struct to hash
 * @returns The keccak256 hash of the ABI-encoded bound params, reduced modulo SNARK_PRIME
 */
export const hashBoundParamsV2 = (boundParams: BoundParamsV2): bigint => {
  const abi = ethers.AbiCoder.defaultAbiCoder()
  // Ensure adaptParams is 32 bytes
  const adaptParams32 = ByteUtils.formatToByteLength(
    boundParams.adaptParams || '0x',
    ByteLength.UINT_256,
    true
  )
  const encoded = abi.encode(
    [
      'tuple(uint16 treeNumber, uint48 minGasPrice, uint8 unshield, uint64 chainID, address adaptContract, bytes32 adaptParams, tuple(bytes32[4] ciphertext, bytes32 blindedSenderViewingKey, bytes32 blindedReceiverViewingKey, bytes annotationData, bytes memo)[] commitmentCiphertext) boundParams',
    ],
    [
      {
        treeNumber: boundParams.treeNumber,
        minGasPrice: boundParams.minGasPrice,
        unshield: boundParams.unshield,
        chainID: boundParams.chainID,
        adaptContract: boundParams.adaptContract,
        adaptParams: adaptParams32,
        commitmentCiphertext: boundParams.commitmentCiphertext,
      },
    ]
  )
  const hashed = ethers.keccak256(encoded)
  return ByteUtils.hexToBigInt(hashed) % SNARK_PRIME
}
