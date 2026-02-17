/**
 * In-memory database for storing commitments and merkletree data
 */

interface Database {
  get(key: string): Promise<any>
  put(key: string, value: any): Promise<void>
  batch(operations: BatchOperation[]): Promise<void>
  keys(): Promise<string[]>
}

interface BatchOperation {
  type: 'put' | 'del'
  key: string
  value?: any
}

/**
 * Get the IndexedDB factory from the global scope if available.
 * @returns The IDBFactory instance, or undefined if not available
 */
const getIndexedDBFactory = (): IDBFactory | undefined => {
  if (typeof globalThis === 'undefined') {
    return undefined
  }
  return (globalThis as typeof globalThis & { indexedDB?: IDBFactory }).indexedDB
}

/**
 * Check whether IndexedDB is supported in the current environment.
 * @returns True if IndexedDB is available
 */
const hasIndexedDBSupport = (): boolean => getIndexedDBFactory() !== undefined

/**
 * Volatile in-memory database backed by a Map, used as a fallback when no persistent storage is available.
 */
class InMemoryDatabase implements Database {
  /** Internal data store. */
  private data: Map<string, any> = new Map()

  /**
   * Retrieve a value by key from the in-memory store.
   * @param key - The key to look up
   * @returns The stored value
   */
  async get (key: string): Promise<any> {
    if (!this.data.has(key)) {
      throw new Error(`Key not found: ${key}`)
    }
    return this.data.get(key)
  }

  /**
   * Store a key-value pair in memory.
   * @param key - The key to store under
   * @param value - The value to store
   */
  async put (key: string, value: any): Promise<void> {
    this.data.set(key, value)
  }

  /**
   * Execute a batch of put/delete operations atomically in memory.
   * @param operations - Array of batch operations to execute
   */
  async batch (operations: BatchOperation[]): Promise<void> {
    for (const op of operations) {
      if (op.type === 'put') {
        this.data.set(op.key, op.value)
      } else if (op.type === 'del') {
        this.data.delete(op.key)
      }
    }
  }

  /**
   * Get all keys stored in the in-memory database.
   * @returns Array of all stored keys
   */
  async keys (): Promise<string[]> {
    return Array.from(this.data.keys())
  }

  // Additional helper methods
  /**
   * Check if a key exists in the in-memory store.
   * @param key - The key to check
   * @returns True if the key exists
   */
  has (key: string): boolean {
    return this.data.has(key)
  }
}

/**
 * LocalStorage-backed database with in-memory cache for performance
 * Automatically persists to localStorage on every write
 */
class LocalStorageDatabase implements Database {
  /** In-memory cache mirroring the localStorage contents. */
  private cache: Map<string, any> = new Map()
  /** The localStorage key used for persistence. */
  private readonly storageKey: string

  /**
   * Initialize the database and load existing data from localStorage.
   * @param storageKey - The localStorage key to persist data under
   */
  constructor (storageKey: string) {
    this.storageKey = storageKey
    this.loadFromStorage()
  }

  /**
   * Load persisted data from localStorage into the in-memory cache.
   */
  private loadFromStorage (): void {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) {
        return
      }

      const stored = localStorage.getItem(this.storageKey)
      if (stored) {
        const data = JSON.parse(stored)
        this.cache = new Map(Object.entries(data))
      }
    } catch (error) {
      console.error(`Failed to load from localStorage key ${this.storageKey}:`, error)
      this.cache.clear()
    }
  }

  /**
   * Persist the in-memory cache to localStorage.
   */
  private saveToStorage (): void {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) {
        return
      }

      const data = Object.fromEntries(this.cache.entries())
      localStorage.setItem(this.storageKey, JSON.stringify(data))
    } catch (error) {
      console.error(`Failed to save to localStorage key ${this.storageKey}:`, error)
    }
  }

  /**
   * Retrieve a value by key from the cache.
   * @param key - The key to look up
   * @returns The stored value
   */
  async get (key: string): Promise<any> {
    if (!this.cache.has(key)) {
      throw new Error(`Key not found: ${key}`)
    }
    return this.cache.get(key)
  }

  /**
   * Store a key-value pair and persist to localStorage.
   * @param key - The key to store under
   * @param value - The value to store
   */
  async put (key: string, value: any): Promise<void> {
    this.cache.set(key, value)
    this.saveToStorage()
  }

  /**
   * Execute a batch of put/delete operations and persist to localStorage.
   * @param operations - Array of batch operations to execute
   */
  async batch (operations: BatchOperation[]): Promise<void> {
    for (const op of operations) {
      if (op.type === 'put') {
        this.cache.set(op.key, op.value)
      } else if (op.type === 'del') {
        this.cache.delete(op.key)
      }
    }
    this.saveToStorage()
  }

  /**
   * Get all keys stored in the database.
   * @returns Array of all stored keys
   */
  async keys (): Promise<string[]> {
    return Array.from(this.cache.keys())
  }

  /**
   * Check if a key exists in the cache.
   * @param key - The key to check
   * @returns True if the key exists
   */
  has (key: string): boolean {
    return this.cache.has(key)
  }

  /**
   * Clear all data from the cache and remove the localStorage entry.
   */
  clear (): void {
    this.cache.clear()
    try {
      if (typeof localStorage !== 'undefined' && localStorage) {
        localStorage.removeItem(this.storageKey)
      }
    } catch (error) {
      console.error(`Failed to clear localStorage key ${this.storageKey}:`, error)
    }
  }

  /**
   * Get the number of entries in the database.
   * @returns The number of stored key-value pairs
   */
  size (): number {
    return this.cache.size
  }
}

/**
 * IndexedDB-backed database for durable, asynchronous storage
 * Provides larger quotas than localStorage and non-blocking operations
 */
class IndexedDBDatabase implements Database {
  /** Promise resolving to the opened IDBDatabase instance. */
  private readonly dbPromise: Promise<IDBDatabase>
  /** Name of the object store within the IndexedDB database. */
  private readonly storeName: string
  /** Reference to the IndexedDB factory for opening databases. */
  private readonly indexedDBFactory: IDBFactory
  /** Schema version number for the IndexedDB database. */
  private readonly version: number

  /**
   * Open an IndexedDB database with the given name and options.
   * @param dbName - The name of the IndexedDB database to open
   * @param options - Optional configuration for store name and version
   * @param options.storeName - The object store name (defaults to 'railgun-merkletree')
   * @param options.version - The database version (defaults to 1)
   */
  constructor (dbName: string, options: { storeName?: string; version?: number } = {}) {
    const indexedDBFactory = getIndexedDBFactory()
    if (!indexedDBFactory) {
      throw new Error('IndexedDB is not available in this environment')
    }

    this.indexedDBFactory = indexedDBFactory
    this.storeName = options.storeName ?? 'railgun-merkletree'
    this.version = options.version ?? 1
    this.dbPromise = this.openDatabase(dbName)
  }

  /**
   * Open the IndexedDB database and create the object store if needed.
   * @param dbName - The name of the database to open
   * @returns A promise resolving to the opened IDBDatabase
   */
  private openDatabase (dbName: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = this.indexedDBFactory.open(dbName, this.version)

      /** Handle database upgrade by creating the object store if it does not exist. */
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName)
        }
      }

      /** Reject the promise if the database open request fails. */
      request.onerror = () => {
        reject(request.error ?? new Error(`Failed to open IndexedDB database ${dbName}`))
      }

      /** Resolve with the opened database and register a version change handler. */
      request.onsuccess = () => {
        const db = request.result
        /**
         * Close the database when another connection triggers a version change.
         * @returns The result of closing the database
         */
        db.onversionchange = () => db.close()
        resolve(db)
      }
    })
  }

  /**
   * Get the opened IDBDatabase instance.
   * @returns The IDBDatabase instance
   */
  private async getDatabase (): Promise<IDBDatabase> {
    return this.dbPromise
  }

  /**
   * Read a raw value from IndexedDB, returning undefined if not found.
   * @param key - The key to look up
   * @returns The stored value, or undefined if not found
   */
  private async readValue (key: string): Promise<any | undefined> {
    const db = await this.getDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly')
      /**
       * Reject if the read transaction is aborted.
       * @returns The rejected promise
       */
      tx.onabort = () =>
        reject(tx.error ?? new Error('IndexedDB transaction aborted while reading value'))
      /**
       * Reject if the read transaction encounters an error.
       * @returns The rejected promise
       */
      tx.onerror = () =>
        reject(tx.error ?? new Error('IndexedDB transaction failed while reading value'))
      const store = tx.objectStore(this.storeName)
      const request = store.get(key)
      /**
       * Resolve with the retrieved value.
       * @returns The resolved promise
       */
      request.onsuccess = () => resolve(request.result)
      /**
       * Reject if the get request fails.
       * @returns The rejected promise
       */
      request.onerror = () =>
        reject(request.error ?? new Error('IndexedDB request failed while reading value'))
    })
  }

  /**
   * Retrieve a value by key from IndexedDB, throwing if not found.
   * @param key - The key to look up
   * @returns The stored value
   */
  async get (key: string): Promise<any> {
    const value = await this.readValue(key)
    if (value === undefined) {
      throw new Error(`Key not found: ${key}`)
    }
    return value
  }

  /**
   * Store a key-value pair in IndexedDB.
   * @param key - The key to store under
   * @param value - The value to store
   */
  async put (key: string, value: any): Promise<void> {
    const db = await this.getDatabase()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite')
      /**
       * Resolve when the write transaction completes successfully.
       * @returns The resolved promise
       */
      tx.oncomplete = () => resolve()
      /**
       * Reject if the write transaction is aborted.
       * @returns The rejected promise
       */
      tx.onabort = () =>
        reject(tx.error ?? new Error('IndexedDB transaction aborted while writing value'))
      /**
       * Reject if the write transaction encounters an error.
       * @returns The rejected promise
       */
      tx.onerror = () =>
        reject(tx.error ?? new Error('IndexedDB transaction failed while writing value'))
      const store = tx.objectStore(this.storeName)
      store.put(value, key)
    })
  }

  /**
   * Execute a batch of put/delete operations in a single IndexedDB transaction.
   * @param operations - Array of batch operations to execute
   */
  async batch (operations: BatchOperation[]): Promise<void> {
    if (operations.length === 0) {
      return
    }

    const db = await this.getDatabase()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite')
      /**
       * Resolve when the batch transaction completes successfully.
       * @returns The resolved promise
       */
      tx.oncomplete = () => resolve()
      /**
       * Reject if the batch transaction is aborted.
       * @returns The rejected promise
       */
      tx.onabort = () =>
        reject(tx.error ?? new Error('IndexedDB transaction aborted during batch operation'))
      /**
       * Reject if the batch transaction encounters an error.
       * @returns The rejected promise
       */
      tx.onerror = () =>
        reject(tx.error ?? new Error('IndexedDB transaction failed during batch operation'))
      const store = tx.objectStore(this.storeName)
      for (const op of operations) {
        if (op.type === 'put') {
          store.put(op.value, op.key)
        } else if (op.type === 'del') {
          store.delete(op.key)
        }
      }
    })
  }

  /**
   * Get all keys stored in the IndexedDB object store.
   * @returns Array of all stored keys as strings
   */
  async keys (): Promise<string[]> {
    const db = await this.getDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly')
      /**
       * Reject if the keys transaction is aborted.
       * @returns The rejected promise
       */
      tx.onabort = () =>
        reject(tx.error ?? new Error('IndexedDB transaction aborted while listing keys'))
      /**
       * Reject if the keys transaction encounters an error.
       * @returns The rejected promise
       */
      tx.onerror = () =>
        reject(tx.error ?? new Error('IndexedDB transaction failed while listing keys'))
      const store = tx.objectStore(this.storeName)

      if (typeof store.getAllKeys === 'function') {
        const request = store.getAllKeys()
        /** Resolve with all keys converted to strings. */
        request.onsuccess = () => {
          const result = request.result as IDBValidKey[]
          resolve(result.map((key) => String(key)))
        }
        /**
         * Reject if the getAllKeys request fails.
         * @returns The rejected promise
         */
        request.onerror = () =>
          reject(request.error ?? new Error('IndexedDB request failed while fetching keys'))
        return
      }

      const keys: string[] = []
      const cursorRequest = store.openKeyCursor()
      /** Iterate the cursor collecting keys, resolving when the cursor is exhausted. */
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result
        if (!cursor) {
          resolve(keys)
          return
        }
        keys.push(String(cursor.key))
        cursor.continue()
      }
      /**
       * Reject if the cursor request fails.
       * @returns The rejected promise
       */
      cursorRequest.onerror = () =>
        reject(cursorRequest.error ?? new Error('IndexedDB cursor failed while fetching keys'))
    })
  }

  /**
   * Check if a key exists in the IndexedDB store.
   * @param key - The key to check
   * @returns True if the key exists
   */
  async has (key: string): Promise<boolean> {
    const value = await this.readValue(key)
    return value !== undefined
  }

  /**
   * Clear all entries from the IndexedDB object store.
   */
  async clear (): Promise<void> {
    const db = await this.getDatabase()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite')
      /**
       * Resolve when the clear transaction completes successfully.
       * @returns The resolved promise
       */
      tx.oncomplete = () => resolve()
      /**
       * Reject if the clear transaction is aborted.
       * @returns The rejected promise
       */
      tx.onabort = () =>
        reject(tx.error ?? new Error('IndexedDB transaction aborted while clearing store'))
      /**
       * Reject if the clear transaction encounters an error.
       * @returns The rejected promise
       */
      tx.onerror = () =>
        reject(tx.error ?? new Error('IndexedDB transaction failed while clearing store'))
      tx.objectStore(this.storeName).clear()
    })
  }

  /**
   * Get the number of entries in the IndexedDB object store.
   * @returns The count of stored entries
   */
  async size (): Promise<number> {
    const db = await this.getDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly')
      /**
       * Reject if the count transaction is aborted.
       * @returns The rejected promise
       */
      tx.onabort = () =>
        reject(tx.error ?? new Error('IndexedDB transaction aborted while counting entries'))
      /**
       * Reject if the count transaction encounters an error.
       * @returns The rejected promise
       */
      tx.onerror = () =>
        reject(tx.error ?? new Error('IndexedDB transaction failed while counting entries'))
      const request = tx.objectStore(this.storeName).count()
      /**
       * Resolve with the entry count.
       * @returns The resolved promise with count
       */
      request.onsuccess = () => resolve(Number(request.result))
      /**
       * Reject if the count request fails.
       * @returns The rejected promise
       */
      request.onerror = () =>
        reject(request.error ?? new Error('IndexedDB request failed while counting entries'))
    })
  }
}

/**
 * Create the most durable database available in the current environment.
 * Falls back from IndexedDB to localStorage to in-memory map.
 * @param storageKey - The storage key or database name to use for persistence
 * @returns A Database instance using the best available storage backend
 */
const createPersistentMerkletreeDatabase = (storageKey: string): Database => {
  if (hasIndexedDBSupport()) {
    try {
      return new IndexedDBDatabase(storageKey)
    } catch (error) {
      console.warn('Failed to initialize IndexedDB, falling back to localStorage:', error)
    }
  }

  if (typeof localStorage !== 'undefined' && localStorage) {
    return new LocalStorageDatabase(storageKey)
  }

  console.warn(
    'localStorage unavailable, falling back to in-memory database. Data will not persist.'
  )
  return new InMemoryDatabase()
}

export type { Database, BatchOperation }
export {
  InMemoryDatabase,
  LocalStorageDatabase,
  IndexedDBDatabase,
  createPersistentMerkletreeDatabase,
}
