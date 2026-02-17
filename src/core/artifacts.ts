import { ArtifactDownloadService } from '@/services/ArtifactDownloadService'
import { dlog } from '@/utils/debug'

type RailgunArtifacts = {
  wasm: Uint8Array
  zkey: Uint8Array
  vkey: object
}

type POICircuitSize = '3x3' | '13x13'
type POIArtifacts = RailgunArtifacts

/**
 * Build a zero-padded circuit variant string from input and output counts.
 * @param inputs - The number of circuit inputs (nullifiers)
 * @param outputs - The number of circuit outputs (commitments)
 * @returns A variant string like "02x02"
 */
const variantFor = (inputs: number, outputs: number): string => {
  const i = String(inputs).padStart(2, '0')
  const o = String(outputs).padStart(2, '0')
  return `${i}x${o}`
}

/**
 * Parse a PPOI circuit size string into its maxInputs and maxOutputs values.
 * @param circuitSize - The circuit size string (e.g., "3x3" or "13x13")
 * @returns The parsed maxInputs and maxOutputs values
 */
const parsePOICircuitSize = (
  circuitSize: POICircuitSize
): {
  maxInputs: number
  maxOutputs: number
} => {
  const [inputsStr, outputsStr] = circuitSize.split('x')
  if (!inputsStr || !outputsStr) {
    throw new Error(`Invalid PPOI circuit size: ${circuitSize}`)
  }
  const maxInputs = Number.parseInt(inputsStr, 10)
  const maxOutputs = Number.parseInt(outputsStr, 10)
  if (!Number.isFinite(maxInputs) || !Number.isFinite(maxOutputs)) {
    throw new Error(`Invalid PPOI circuit size: ${circuitSize}`)
  }
  return { maxInputs, maxOutputs }
}

/**
 * Load a circuit variant's artifacts from IndexedDB, downloading from IPFS if needed.
 * @param variant - The circuit variant string (e.g., "02x02" or "POI_3x3")
 * @returns The circuit artifacts containing wasm, zkey, and vkey
 */
const loadArtifactsForVariant = async (variant: string): Promise<RailgunArtifacts> => {
  const service = ArtifactDownloadService.getInstance()

  // Check if all artifacts are in IndexedDB
  const downloaded = await service.isVariantDownloaded(variant)

  if (!downloaded) {
    // Download on-the-fly from IPFS gateway
    dlog(`Circuit ${variant} not in cache, downloading from IPFS...`)
    await service.downloadVariant(variant)
  }

  // Read from IndexedDB
  const [vkeyRaw, zkey, wasm] = await Promise.all([
    service.getArtifact(variant, 'vkey'),
    service.getArtifact(variant, 'zkey'),
    service.getArtifact(variant, 'wasm'),
  ])

  if (!vkeyRaw || !zkey || !wasm) {
    throw new Error(`Failed to load circuit artifacts for ${variant} from IndexedDB after download`)
  }

  // vkey is stored as JSON string, parse it
  const vkey = typeof vkeyRaw === 'string' ? JSON.parse(vkeyRaw) : JSON.parse(new TextDecoder().decode(vkeyRaw as Uint8Array))

  return {
    vkey,
    zkey: zkey as Uint8Array,
    wasm: wasm as Uint8Array,
  }
}

// In-memory cache for V2 RAILGUN artifacts to avoid repeated IndexedDB reads
// and redundant memory allocation of large WASM/zkey binaries (~9MB total)
const v2ArtifactCache = new Map<string, RailgunArtifacts>()

/**
 * Fetch and cache RAILGUN V2 circuit artifacts (wasm, zkey, vkey) for a given circuit size.
 * Checks in-memory cache first, then IndexedDB, then downloads from IPFS if needed.
 * @param nullifierCount - The number of nullifiers (inputs) for the circuit
 * @param commitmentCount - The number of commitments (outputs) for the circuit
 * @returns The circuit artifacts containing wasm, zkey, and vkey
 */
const getArtifacts = async (
  nullifierCount: number,
  commitmentCount: number
): Promise<RailgunArtifacts> => {
  if (nullifierCount < 1 || commitmentCount < 1) {
    throw new Error('Invalid artifact request: inputs/outputs must be >= 1')
  }
  const v = variantFor(nullifierCount, commitmentCount)

  const cached = v2ArtifactCache.get(v)
  if (cached) return cached

  dlog(`Loading circuit artifacts for ${v}`)

  const artifacts = await loadArtifactsForVariant(v)
  v2ArtifactCache.set(v, artifacts)
  return artifacts
}

// In-memory cache for PPOI artifacts to avoid repeated IndexedDB reads
const poiArtifactCache = new Map<string, RailgunArtifacts>()

/**
 * Get PPOI circuit artifacts.
 * PPOI circuits are named POI_{maxInputs}x{maxOutputs}.
 * Results are cached in memory after first load.
 * @param maxInputs - The maximum number of inputs for the PPOI circuit
 * @param maxOutputs - The maximum number of outputs for the PPOI circuit
 * @returns The PPOI circuit artifacts containing wasm, zkey, and vkey
 */
const getArtifactsPOI = async (
  maxInputs: number,
  maxOutputs: number
): Promise<RailgunArtifacts> => {
  if (maxInputs < 1 || maxOutputs < 1) {
    throw new Error('Invalid PPOI artifact request: maxInputs/maxOutputs must be >= 1')
  }

  const poiVariant = `POI_${maxInputs}x${maxOutputs}`

  const cached = poiArtifactCache.get(poiVariant)
  if (cached) return cached

  dlog(`Loading PPOI circuit artifacts for ${poiVariant}`)

  const artifacts = await loadArtifactsForVariant(poiVariant)
  poiArtifactCache.set(poiVariant, artifacts)
  return artifacts
}

/**
 * Fetch PPOI artifacts by circuit size string, delegating to getArtifactsPOI.
 * @param circuitSize - The circuit size identifier (e.g., "3x3")
 * @returns The PPOI circuit artifacts
 */
const getPOIArtifacts = async (circuitSize: POICircuitSize): Promise<POIArtifacts> => {
  const { maxInputs, maxOutputs } = parsePOICircuitSize(circuitSize)
  return getArtifactsPOI(maxInputs, maxOutputs)
}

export type { RailgunArtifacts, POICircuitSize, POIArtifacts }
export { getArtifacts, getArtifactsPOI, getPOIArtifacts }
