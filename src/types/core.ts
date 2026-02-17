// Shared core types used across multiple files

type Chain = {
  type: number
  id: number
}

type AddressData = {
  masterPublicKey: bigint
  viewingPublicKey: Uint8Array
  chain?: Chain
  version?: number
}

type CommitmentCiphertextStruct = {
  ciphertext: [string, string, string, string]
  blindedSenderViewingKey: string
  blindedReceiverViewingKey: string
  memo: string
  annotationData: string
}

export type { Chain, AddressData, CommitmentCiphertextStruct }
