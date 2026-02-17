import { IndexedDBDatabase } from '@/core/merkletrees/database'
import { dlog } from '@/utils/debug'

const IPFS_GATEWAY = 'https://ipfs-lb.com'

// CID roots for IPFS artifact directories
const RAILGUN_ARTIFACTS_CID = 'QmUsmnK4PFc7zDp2cmC4wBZxYLjNyRgWfs5GNcJJ2uLcpU'
const PPOI_ARTIFACTS_CID = 'QmZrP9zaZw2LwErT2yA6VpMWm65UdToQiKj4DtStVsUJHr'

const POI_PREFIX = 'POI_'

// Common circuit variants that cover ~95% of transaction use cases
const COMMON_VARIANTS = [
  '01x01', '01x02', '02x01', '02x02', '02x03',
  '03x01', '04x01', '05x01',
]

const POI_VARIANTS = ['POI_3x3', 'POI_13x13']

const COMMON_VARIANTS_WITH_POI = [...COMMON_VARIANTS, ...POI_VARIANTS]

// All RAILGUN V2 circuit variants (1x1 through 13x13)
const ALL_V2_VARIANTS: string[] = []
for (let i = 1; i <= 13; i++) {
  for (let o = 1; o <= 13; o++) {
    ALL_V2_VARIANTS.push(
      `${String(i).padStart(2, '0')}x${String(o).padStart(2, '0')}`
    )
  }
}

const ALL_VARIANTS = [...ALL_V2_VARIANTS, ...POI_VARIANTS]

type DownloadProgressCallback = (current: number, total: number, currentVariant: string) => void

/**
 * Check whether a circuit variant is a POI variant.
 * @param variant - The circuit variant identifier
 * @returns True if the variant starts with the POI prefix
 */
const isPOIVariant = (variant: string): boolean => variant.startsWith(POI_PREFIX)

/**
 * Get the IPFS URL for a specific artifact file.
 * URL patterns copied from wallet/src/services/artifacts/artifact-util.ts
 * @param variant - The circuit variant identifier
 * @param artifactType - The type of artifact to fetch
 * @returns The full IPFS gateway URL for the artifact
 */
const getArtifactUrl = (
  variant: string,
  artifactType: 'vkey' | 'zkey' | 'wasm'
): string => {
  if (isPOIVariant(variant)) {
    const cid = PPOI_ARTIFACTS_CID
    switch (artifactType) {
      case 'vkey':
        return `${IPFS_GATEWAY}/ipfs/${cid}/${variant}/vkey.json`
      case 'zkey':
        return `${IPFS_GATEWAY}/ipfs/${cid}/${variant}/zkey.br`
      case 'wasm':
        return `${IPFS_GATEWAY}/ipfs/${cid}/${variant}/wasm.br`
    }
  }

  const cid = RAILGUN_ARTIFACTS_CID
  switch (artifactType) {
    case 'vkey':
      return `${IPFS_GATEWAY}/ipfs/${cid}/circuits/${variant}/vkey.json`
    case 'zkey':
      return `${IPFS_GATEWAY}/ipfs/${cid}/circuits/${variant}/zkey.br`
    case 'wasm':
      return `${IPFS_GATEWAY}/ipfs/${cid}/prover/snarkjs/${variant}.wasm.br`
  }
}

/**
 * Build the IndexedDB storage key for an artifact.
 * @param variant - The circuit variant identifier
 * @param artifactType - The type of artifact
 * @returns The storage key string
 */
const artifactKey = (variant: string, artifactType: 'vkey' | 'zkey' | 'wasm'): string => {
  switch (artifactType) {
    case 'vkey':
      return `${variant}/vkey.json`
    case 'zkey':
      return `${variant}/zkey`
    case 'wasm':
      return `${variant}/wasm`
  }
}

/**
 * Download and decompress a Brotli-compressed binary artifact from IPFS.
 * @param url - The IPFS gateway URL to fetch
 * @returns The decompressed binary data
 */
const fetchAndDecompressBinary = async (url: string): Promise<Uint8Array> => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`)

  const arrayBuffer = await res.arrayBuffer()
  const compressed = new Uint8Array(arrayBuffer)

  const brotliModule = await import('brotli-wasm')
  const brotli = await brotliModule.default
  const decompressed = brotli.decompress(compressed)

  dlog(`Decompressed ${url}: ${compressed.length} -> ${decompressed.length} bytes`)
  return decompressed
}

/**
 * Fetch a JSON artifact (vkey) from IPFS. Not compressed.
 * @param url - The IPFS gateway URL to fetch
 * @returns The raw JSON text
 */
const fetchVkey = async (url: string): Promise<string> => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`)
  const text = await res.text()
  // Validate it's actually JSON
  JSON.parse(text)
  return text
}

/**
 * Service for downloading RAILGUN circuit artifacts from IPFS and storing them in IndexedDB.
 */
class ArtifactDownloadService {
  /** Singleton instance. */
  private static instance: ArtifactDownloadService | null = null
  /** IndexedDB database for artifact storage. */
  private db: IndexedDBDatabase

  /** Initialize the service with an IndexedDB database. */
  private constructor () {
    this.db = new IndexedDBDatabase('railgun-artifacts', { storeName: 'artifacts' })
  }

  /**
   * Get the singleton service instance.
   * @returns The shared ArtifactDownloadService instance
   */
  static getInstance (): ArtifactDownloadService {
    if (!ArtifactDownloadService.instance) {
      ArtifactDownloadService.instance = new ArtifactDownloadService()
    }
    return ArtifactDownloadService.instance
  }

  /**
   * Check if a specific artifact exists in IndexedDB.
   * @param variant - The circuit variant identifier
   * @param type - The artifact type to check
   * @returns Whether the artifact exists
   */
  async hasArtifact (variant: string, type: 'vkey' | 'zkey' | 'wasm'): Promise<boolean> {
    return this.db.has(artifactKey(variant, type))
  }

  /**
   * Get a specific artifact from IndexedDB.
   * @param variant - The circuit variant identifier
   * @param type - The artifact type to retrieve
   * @returns The artifact data, or null if not found
   */
  async getArtifact (variant: string, type: 'vkey' | 'zkey' | 'wasm'): Promise<Uint8Array | string | null> {
    try {
      return await this.db.get(artifactKey(variant, type))
    } catch {
      return null
    }
  }

  /**
   * Check if all 3 artifacts for a variant are downloaded.
   * @param variant - The circuit variant identifier
   * @returns Whether all artifacts (vkey, zkey, wasm) exist
   */
  async isVariantDownloaded (variant: string): Promise<boolean> {
    const [hasVkey, hasZkey, hasWasm] = await Promise.all([
      this.hasArtifact(variant, 'vkey'),
      this.hasArtifact(variant, 'zkey'),
      this.hasArtifact(variant, 'wasm'),
    ])
    return hasVkey && hasZkey && hasWasm
  }

  /**
   * Download all 3 artifacts (vkey, zkey, wasm) for a single circuit variant from IPFS.
   * Stores decompressed data in IndexedDB.
   * @param variant - The circuit variant identifier to download
   */
  async downloadVariant (variant: string): Promise<void> {
    // Skip if already fully downloaded
    if (await this.isVariantDownloaded(variant)) {
      dlog(`Variant ${variant} already downloaded, skipping`)
      return
    }

    dlog(`Downloading circuit artifacts for ${variant} from IPFS...`)

    const vkeyUrl = getArtifactUrl(variant, 'vkey')
    const zkeyUrl = getArtifactUrl(variant, 'zkey')
    const wasmUrl = getArtifactUrl(variant, 'wasm')

    // Download all 3 files in parallel
    const [vkeyText, zkeyData, wasmData] = await Promise.all([
      fetchVkey(vkeyUrl),
      fetchAndDecompressBinary(zkeyUrl),
      fetchAndDecompressBinary(wasmUrl),
    ])

    // Store in IndexedDB
    await Promise.all([
      this.db.put(artifactKey(variant, 'vkey'), vkeyText),
      this.db.put(artifactKey(variant, 'zkey'), zkeyData),
      this.db.put(artifactKey(variant, 'wasm'), wasmData),
    ])

    dlog(`Stored circuit artifacts for ${variant} in IndexedDB`)
  }

  /**
   * Download the common circuit variants used by most transactions.
   * @param onProgress - Optional callback for download progress updates
   */
  async downloadCommonVariants (onProgress?: DownloadProgressCallback): Promise<void> {
    const variants = COMMON_VARIANTS_WITH_POI
    for (let i = 0; i < variants.length; i++) {
      const variant = variants[i]!
      onProgress?.(i + 1, variants.length, variant)
      await this.downloadVariant(variant)
    }
  }

  /**
   * Download all possible circuit variants (93 V2 + 2 POI).
   * @param onProgress - Optional callback for download progress updates
   */
  async downloadAllVariants (onProgress?: DownloadProgressCallback): Promise<void> {
    const variants = ALL_VARIANTS
    for (let i = 0; i < variants.length; i++) {
      const variant = variants[i]!
      onProgress?.(i + 1, variants.length, variant)
      await this.downloadVariant(variant)
    }
  }

  /**
   * Get a list of all fully downloaded variant strings.
   * @returns Sorted array of downloaded variant identifiers
   */
  async getDownloadedVariants (): Promise<string[]> {
    const keys = await this.db.keys()
    // Group keys by variant — a variant is "downloaded" only if all 3 files exist
    const variantFiles = new Map<string, Set<string>>()
    for (const key of keys) {
      const slashIdx = key.lastIndexOf('/')
      if (slashIdx === -1) continue
      const variant = key.substring(0, slashIdx)
      if (!variantFiles.has(variant)) {
        variantFiles.set(variant, new Set())
      }
      variantFiles.get(variant)!.add(key.substring(slashIdx + 1))
    }

    const downloaded: string[] = []
    for (const [variant, files] of variantFiles) {
      if (files.has('vkey.json') && files.has('zkey') && files.has('wasm')) {
        downloaded.push(variant)
      }
    }
    return downloaded.sort()
  }

  /**
   * Clear all downloaded artifacts from IndexedDB.
   */
  async clearDownloadedArtifacts (): Promise<void> {
    await this.db.clear()
    dlog('Cleared all downloaded circuit artifacts from IndexedDB')
  }
}

export { ArtifactDownloadService, COMMON_VARIANTS_WITH_POI, ALL_VARIANTS }
export type { DownloadProgressCallback }
