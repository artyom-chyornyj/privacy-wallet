import axios from 'axios'

import type { NetworkName } from '@/types/network'
import { NETWORK_CONFIG } from '@/types/network'
import type { SubsquidCommitment, SubsquidNullifier } from '@/types/wallet'
import { derror, dlog } from '@/utils/debug'

/**
 * Subsquid data fetcher - based on ppoi-private implementation
 * Fetches commitment and nullifier data from Subsquid GraphQL endpoints
 */
export class SubsquidDataFetcher {
  /**
   * Singleton instance of the data fetcher.
   */
  private static instance: SubsquidDataFetcher

  /**
   * Private constructor to enforce singleton pattern.
   */
  private constructor () {}

  /**
   * Get the singleton instance of SubsquidDataFetcher.
   * @returns The shared SubsquidDataFetcher instance
   */
  static getInstance (): SubsquidDataFetcher {
    if (!this.instance) {
      this.instance = new SubsquidDataFetcher()
    }
    return this.instance
  }

  /**
   * Get the Subsquid GraphQL endpoint URL for a network.
   * @param networkName - The network to get the URL for
   * @returns The Subsquid URL, or undefined if not configured
   */
  private getSubsquidURL (networkName: NetworkName): string | undefined {
    return NETWORK_CONFIG[networkName].subsquidUrl
  }

  /**
   * Fetch commitments from Subsquid starting from a given block number.
   * Based on wallet/src/services/railgun/quick-sync/V2/graphql/quick-sync-query-V2.graphql
   * @param networkName - The network to fetch commitments for
   * @param startingBlockNumber - The block number to start fetching from
   * @returns The fetched and transformed commitments
   */
  async fetchCommitments (
    networkName: NetworkName,
    startingBlockNumber: number = 0
  ): Promise<SubsquidCommitment[]> {
    try {
      const subsquidURL = this.getSubsquidURL(networkName)
      if (!subsquidURL) {
        throw new Error(`No Subsquid URL configured for network: ${networkName}`)
      }

      dlog('Fetching commitments from Subsquid:', { networkName, startingBlockNumber })

      const commitmentsQuery = `
        query GetCommitments($blockNumber: BigInt = 0) {
          commitments(
            orderBy: [blockNumber_ASC, treePosition_ASC]
            where: { blockNumber_gte: $blockNumber }
            limit: 5000
          ) {
            id
            treeNumber
            batchStartTreePosition
            treePosition
            blockNumber
            transactionHash
            blockTimestamp
            commitmentType
            hash
            ... on LegacyGeneratedCommitment {
              encryptedRandom
              preimage {
                id
                npk
                value
                token {
                  id
                  tokenType
                  tokenSubID
                  tokenAddress
                }
              }
            }
            ... on LegacyEncryptedCommitment {
              legacyCiphertext: ciphertext {
                id
                ciphertext {
                  id
                  iv
                  tag
                  data
                }
                ephemeralKeys
                memo
              }
            }
            ... on ShieldCommitment {
              shieldKey
              fee
              encryptedBundle
              preimage {
                id
                npk
                value
                token {
                  id
                  tokenType
                  tokenSubID
                  tokenAddress
                }
              }
            }
            ... on TransactCommitment {
              ciphertext {
                id
                ciphertext {
                  id
                  iv
                  tag
                  data
                }
                blindedSenderViewingKey
                blindedReceiverViewingKey
                annotationData
                memo
              }
            }
          }
        }
      `

      const commitmentsResponse = await this.makeSubsquidRequest(subsquidURL, commitmentsQuery, {
        blockNumber: startingBlockNumber,
      })

      const commitments = commitmentsResponse.data?.commitments || []
      dlog(`Fetched ${commitments.length} commitments from block ${startingBlockNumber}`)

      return this.transformCommitments(commitments)
    } catch (error) {
      derror(`Error fetching commitments from Subsquid for ${networkName}:`, error)
      return []
    }
  }

  /**
   * Backwards-compatible wrapper. Callers that destructure { commitments } will still work.
   * @param networkName - The network to fetch data for
   * @param startingBlockNumber - The block number to start fetching from
   * @returns An object containing the fetched commitments array
   */
  async fetchNewTransactionsAndCommitments (
    networkName: NetworkName,
    startingBlockNumber: number = 0
  ): Promise<{ commitments: SubsquidCommitment[] }> {
    const commitments = await this.fetchCommitments(networkName, startingBlockNumber)
    return { commitments }
  }

  /**
   * Transform raw GraphQL commitment responses into typed format.
   * Based on wallet/src/services/railgun/quick-sync/V2/graph-type-formatters-v2.ts
   * @param rawCommitments - The raw commitment objects from the GraphQL response
   * @returns The typed and structured commitment array
   */
  private transformCommitments (rawCommitments: any[]): SubsquidCommitment[] {
    return rawCommitments.map((commitment) => {
      const base = {
        id: commitment.id,
        treeNumber: commitment.treeNumber,
        batchStartTreePosition: commitment.batchStartTreePosition,
        treePosition: commitment.treePosition,
        blockNumber: commitment.blockNumber,
        transactionHash: commitment.transactionHash,
        blockTimestamp: commitment.blockTimestamp,
        commitmentType: commitment.commitmentType,
        hash: commitment.hash,
      }

      switch (commitment.commitmentType) {
        case 'LegacyGeneratedCommitment':
          return {
            ...base,
            commitmentType: 'LegacyGeneratedCommitment' as const,
            encryptedRandom: commitment.encryptedRandom,
            preimage: commitment.preimage,
          }

        case 'LegacyEncryptedCommitment':
          return {
            ...base,
            commitmentType: 'LegacyEncryptedCommitment' as const,
            legacyCiphertext: commitment.legacyCiphertext,
          }

        case 'ShieldCommitment':
          return {
            ...base,
            commitmentType: 'ShieldCommitment' as const,
            shieldKey: commitment.shieldKey,
            fee: commitment.fee,
            encryptedBundle: commitment.encryptedBundle,
            preimage: commitment.preimage,
          }

        case 'TransactCommitment':
          return {
            ...base,
            commitmentType: 'TransactCommitment' as const,
            ciphertext: commitment.ciphertext,
          }

        default:
          throw new Error(`Unknown commitment type: ${commitment.commitmentType}`)
      }
    })
  }

  /**
   * Make GraphQL request to Subsquid.
   * @param url - The Subsquid GraphQL endpoint URL
   * @param query - The GraphQL query string
   * @param variables - The GraphQL query variables
   * @returns The parsed response data from Subsquid
   */
  private async makeSubsquidRequest (
    url: string,
    query: string,
    variables: Record<string, any> = {}
  ): Promise<any> {
    try {
      const response = await axios.post(
        url,
        { query, variables },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        }
      )

      if (response.data.errors) {
        derror('Subsquid GraphQL errors:', response.data.errors)
        throw new Error(`Subsquid GraphQL errors: ${JSON.stringify(response.data.errors)}`)
      }

      return response.data
    } catch (error) {
      derror('Subsquid request failed:', error)
      throw error
    }
  }

  /**
   * Fetch nullifier events to identify spent UTXOs.
   * Nullifiers are revealed when UTXOs are spent.
   * @param networkName - The network to fetch nullifier events for
   * @param startBlockNumber - The block number to start fetching from
   * @returns The fetched nullifier events
   */
  async fetchNullifierEvents (
    networkName: NetworkName,
    startBlockNumber: number = 0
  ): Promise<SubsquidNullifier[]> {
    try {
      const subsquidURL = this.getSubsquidURL(networkName)
      if (!subsquidURL) {
        throw new Error(`No Subsquid URL configured for network: ${networkName}`)
      }

      const nullifierQuery = `
        query GetNullifiers($blockNumber: BigInt = 0) {
          nullifiers(
            orderBy: [blockNumber_ASC]
            where: { blockNumber_gte: $blockNumber }
            limit: 10000
          ) {
            id
            nullifier
            blockNumber
            transactionHash
            blockTimestamp
          }
        }
      `

      const response = await this.makeSubsquidRequest(subsquidURL, nullifierQuery, {
        blockNumber: startBlockNumber.toString(),
      })

      return response.data?.nullifiers || []
    } catch (error) {
      derror('Error fetching nullifier events:', error)
      return []
    }
  }
}
