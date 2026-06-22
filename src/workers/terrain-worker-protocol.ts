import type {
  AircraftState,
  LineOfSightOptions,
  LineOfSightBatchResult,
  LineOfSightResult,
  TerrainMetadata,
  TerrainSample,
  Threat
} from '../domain/types';

export type TerrainWorkerRequest =
  | {
      id: string;
      type: 'load';
      file: File;
    }
  | {
      id: string;
      type: 'sample';
      latitude: number;
      longitude: number;
    }
  | {
      id: string;
      type: 'los';
      aircraft: AircraftState;
      threat: Threat;
      options?: LineOfSightOptions;
    }
  | {
      id: string;
      type: 'los-batch';
      aircraft: AircraftState;
      threats: Threat[];
      options?: LineOfSightOptions;
    }
  | {
      id: string;
      type: 'cancel';
    };

export type TerrainWorkerResponse =
  | {
      id: string;
      type: 'loaded';
      metadata: TerrainMetadata;
    }
  | {
      id: string;
      type: 'sampled';
      sample: TerrainSample;
    }
  | {
      id: string;
      type: 'los-result';
      result: LineOfSightResult;
    }
  | {
      id: string;
      type: 'los-batch-result';
      results: LineOfSightBatchResult[];
    }
  | {
      id: string;
      type: 'error';
      message: string;
    };
