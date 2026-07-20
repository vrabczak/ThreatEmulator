/**
 * Persists a user-approved GeoTIFF file handle for restoration across browser sessions.
 * This module depends on the File System Access API and IndexedDB, both of which are optional.
 */

const DATABASE_NAME = 'threat-emulator-persistent-files';
const DATABASE_VERSION = 1;
const STORE_NAME = 'files';
const TERRAIN_KEY = 'terrain-geotiff';

type FilePickerAcceptType = {
  description?: string;
  accept: Record<string, string[]>;
};

type FilePickerOptions = {
  excludeAcceptAllOption?: boolean;
  multiple?: boolean;
  types?: FilePickerAcceptType[];
};

type FileHandlePermissionDescriptor = {
  mode: 'read';
};

export type PersistentFileHandle = {
  kind?: 'file';
  name: string;
  getFile: () => Promise<File>;
  queryPermission?: (descriptor: FileHandlePermissionDescriptor) => Promise<PermissionState>;
  requestPermission?: (descriptor: FileHandlePermissionDescriptor) => Promise<PermissionState>;
};

type FilePickerWindow = Window & {
  showOpenFilePicker?: (options?: FilePickerOptions) => Promise<PersistentFileHandle[]>;
};

type StoredPersistentFile = {
  fileName: string;
  handle: PersistentFileHandle;
  savedAtMs: number;
};

export type RestorePersistentTerrainFileResult =
  | {
      status: 'loaded';
      file: File;
    }
  | {
      status: 'missing';
    }
  | {
      status: 'permission-needed';
      fileName: string;
    }
  | {
      status: 'unavailable';
      fileName: string | null;
      reason: string;
    };

const READ_PERMISSION = { mode: 'read' } as const;

/**
 * Detects whether persistent file selection and handle storage are available.
 * @returns Whether the browser exposes the required File System Access and IndexedDB APIs.
 */
export function supportsPersistentFilePicker(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof indexedDB !== 'undefined' &&
    typeof (window as FilePickerWindow).showOpenFilePicker === 'function'
  );
}

/**
 * Prompts for one GeoTIFF and remembers its file handle for future sessions.
 * @returns The selected file, or `null` when the picker is canceled or returns no selection.
 * @throws {Error} When persistent selection is unsupported or the file handle cannot be read or stored.
 */
export async function pickPersistentTerrainFile(): Promise<File | null> {
  if (!supportsPersistentFilePicker()) {
    throw new Error('Persistent GeoTIFF restore is not supported by this browser.');
  }

  let handles: PersistentFileHandle[];
  try {
    handles = await (window as FilePickerWindow).showOpenFilePicker!({
      excludeAcceptAllOption: false,
      multiple: false,
      types: [
        {
          description: 'GeoTIFF elevation data',
          accept: {
            'image/tiff': ['.tif', '.tiff'],
            'application/octet-stream': ['.tif', '.tiff']
          }
        }
      ]
    });
  } catch (error) {
    if (isAbortError(error)) {
      return null;
    }
    throw error;
  }

  const handle = handles[0];
  if (!handle) {
    return null;
  }

  const file = await handle.getFile();
  await saveTerrainFileHandle(handle);
  return file;
}

/**
 * Attempts to reopen the remembered terrain file, optionally requesting read permission.
 * @param options - Controls whether the browser may prompt to restore handle permission.
 * @returns A discriminated restoration result describing the file or recovery action needed.
 * @throws {Error} When IndexedDB cannot be opened or queried.
 */
export async function restorePersistentTerrainFile(options: {
  requestPermission: boolean;
}): Promise<RestorePersistentTerrainFileResult> {
  const stored = await getStoredTerrainFile();
  if (!stored) {
    return { status: 'missing' };
  }

  try {
    const permission = await getReadPermission(stored.handle, options.requestPermission);
    if (permission !== 'granted') {
      return { status: 'permission-needed', fileName: stored.fileName };
    }

    return {
      status: 'loaded',
      file: await stored.handle.getFile()
    };
  } catch (error) {
    return {
      status: 'unavailable',
      fileName: stored.fileName,
      reason: error instanceof Error ? error.message : 'Unable to restore remembered GeoTIFF.'
    };
  }
}

/**
 * Removes the remembered terrain file handle from persistent browser storage.
 * @throws {Error} When IndexedDB cannot be opened or updated.
 */
export async function forgetPersistentTerrainFile(): Promise<void> {
  const database = await openDatabase();
  try {
    await requestToPromise(database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(TERRAIN_KEY));
  } finally {
    database.close();
  }
}

async function saveTerrainFileHandle(handle: PersistentFileHandle): Promise<void> {
  const database = await openDatabase();
  try {
    const stored: StoredPersistentFile = {
      fileName: handle.name,
      handle,
      savedAtMs: Date.now()
    };
    await requestToPromise(database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(stored, TERRAIN_KEY));
  } finally {
    database.close();
  }
}

async function getStoredTerrainFile(): Promise<StoredPersistentFile | null> {
  const database = await openDatabase();
  try {
    const stored = await requestToPromise<StoredPersistentFile | undefined>(
      database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(TERRAIN_KEY)
    );
    return stored ?? null;
  } finally {
    database.close();
  }
}

async function getReadPermission(
  handle: PersistentFileHandle,
  requestPermission: boolean
): Promise<PermissionState> {
  const queriedPermission = await handle.queryPermission?.(READ_PERMISSION);
  if (queriedPermission === 'granted' || !requestPermission) {
    return queriedPermission ?? 'granted';
  }

  return (await handle.requestPermission?.(READ_PERMISSION)) ?? queriedPermission ?? 'granted';
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open persistent file storage.'));
    request.onblocked = () => reject(new Error('Persistent file storage is blocked by another app window.'));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Persistent file storage request failed.'));
  });
}

function isAbortError(error: unknown): boolean {
  return typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError';
}
