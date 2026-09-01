/**
 * Verifies that terrain import stops active evaluation before opening the file picker and still loads the selection.
 * Minimal event targets stand in for the mounted terrain controls; persistent file handles are intentionally absent.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerrainMetadata, TerrainService } from '../domain/types';
import { TerrainController } from './terrain-controller';

describe('TerrainController', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prepares the application before the picker opens and before the selected terrain loads', async () => {
    const events: string[] = [];
    const terrainInput = Object.assign(new EventTarget(), {
      files: null as FileList | null,
      value: 'previous-selection.tif',
      click: vi.fn(() => events.push('picker opened'))
    });
    const terrainImportButton = new EventTarget();
    vi.stubGlobal('document', {
      getElementById: vi.fn((id: string) => {
        if (id === 'terrainInput') {
          return terrainInput;
        }
        if (id === 'terrainImportButton') {
          return terrainImportButton;
        }
        return null;
      })
    });

    const metadata: TerrainMetadata = {
      fileName: 'terrain.tif',
      fileSize: 3,
      width: 10,
      height: 10,
      bbox: [14, 49, 15, 50],
      resolutionDeg: { longitude: 0.1, latitude: 0.1 },
      samplesPerPixel: 1,
      tileWidth: 10,
      tileHeight: 10,
      noDataValue: null,
      isWgs84: true,
      warnings: []
    };
    const loadGeoTiff = vi.fn(async () => {
      events.push('terrain loading');
      return metadata;
    });
    const terrainService = { loadGeoTiff } as unknown as TerrainService;
    const onTerrainChanged = vi.fn();

    new TerrainController({
      terrainService,
      onBeforeTerrainLoad: () => events.push('emulator stopped'),
      onTerrainChanged,
      onMessage: vi.fn(),
      onStateChanged: vi.fn()
    });

    terrainImportButton.dispatchEvent(new Event('click'));

    expect(events).toEqual(['emulator stopped', 'picker opened']);
    expect(terrainInput.value).toBe('');

    const file = new File(['dem'], 'terrain.tif', { type: 'image/tiff' });
    terrainInput.files = [file] as unknown as FileList;
    terrainInput.dispatchEvent(new Event('change'));

    await vi.waitFor(() => expect(loadGeoTiff).toHaveBeenCalledWith(file));
    expect(events).toEqual([
      'emulator stopped',
      'picker opened',
      'emulator stopped',
      'terrain loading'
    ]);
    await vi.waitFor(() => expect(onTerrainChanged).toHaveBeenLastCalledWith(metadata));
  });
});
