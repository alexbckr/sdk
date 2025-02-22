import path from 'path';
import chunk from 'lodash/chunk';
import pMap from 'p-map';

import {
  PartialDatasets,
  Entity,
  EntityRawData,
  Relationship,
  SynchronizationJob,
  IntegrationError,
} from '@jupiterone/integration-sdk-core';

import { IntegrationLogger } from '../logger';

import { ExecuteIntegrationResult } from '../execution';

import { getRootStorageDirectory, readJsonFromPath } from '../fileSystem';
import { synchronizationApiError } from './error';
import { ApiClient } from '../api';
import { timeOperation } from '../metrics';
import { FlushedGraphObjectData } from '../storage/types';
import { AttemptContext, retry } from '@lifeomic/attempt';
import { v4 as uuid } from 'uuid';

export { synchronizationApiError };
import { createEventPublishingQueue } from './events';
import { AxiosInstance } from 'axios';
import { iterateParsedGraphFiles } from '..';
export { createEventPublishingQueue } from './events';

const UPLOAD_BATCH_SIZE = 250;
const UPLOAD_CONCURRENCY = 6;

// Uploads above 6 MB will fail.  This is technically
// 6291456 bytes, but we need header space.  Most web
// servers will only allow 8KB or 16KB as a max header
// size, so 6291456 - 16384 = 6275072
const UPLOAD_SIZE_MAX = 6275072;
export enum RequestHeaders {
  CorrelationId = 'JupiterOne-Correlation-Id',
}

interface SynchronizeInput {
  logger: IntegrationLogger;
  apiClient: ApiClient;
  integrationInstanceId: string;
}

/**
 * Performs synchronization of collected data.
 */
export async function synchronizeCollectedData(
  input: SynchronizeInput,
): Promise<SynchronizationJob> {
  const jobContext = await initiateSynchronization(input);

  const eventPublishingQueue = createEventPublishingQueue(jobContext);
  jobContext.logger.on('event', (event) => eventPublishingQueue.enqueue(event));

  try {
    await uploadCollectedData(jobContext);

    return await finalizeSynchronization({
      ...jobContext,
      partialDatasets: await getPartialDatasets(),
    });
  } catch (err) {
    jobContext.logger.error(
      err,
      'Error occurred while synchronizing collected data',
    );

    try {
      await abortSynchronization({ ...jobContext, reason: err.message });
    } catch (abortError) {
      jobContext.logger.error(
        abortError,
        'Error occurred while aborting synchronization job.',
      );
      throw abortError;
    }

    throw err;
  } finally {
    await eventPublishingQueue.onIdle();
  }
}

export interface SynchronizationJobContext {
  apiClient: ApiClient;
  job: SynchronizationJob;
  logger: IntegrationLogger;
}

/**
 * Initializes a synchronization job
 */
export async function initiateSynchronization({
  logger,
  apiClient,
  integrationInstanceId,
}: SynchronizeInput): Promise<SynchronizationJobContext> {
  logger.info('Initiating synchronization job...');

  let job: SynchronizationJob;
  try {
    const response = await apiClient.post('/persister/synchronization/jobs', {
      source: 'integration-managed',
      integrationInstanceId,
    });

    job = response.data.job;
  } catch (err) {
    throw synchronizationApiError(
      err,
      'Error occurred while initiating synchronization job',
    );
  }

  return {
    apiClient,
    job,
    logger: logger.child({
      synchronizationJobId: job.id,
      integrationJobId: job.integrationJobId,
      integrationInstanceId: job.integrationInstanceId,
    }),
  };
}

interface FinalizeSynchronizationInput extends SynchronizationJobContext {
  partialDatasets: PartialDatasets;
}

/**
 * Posts to the synchronization job API to trigger
 * the synchronization of all uploaded entities and relationships.
 */
export async function finalizeSynchronization({
  apiClient,
  job,
  logger,
  partialDatasets,
}: FinalizeSynchronizationInput): Promise<SynchronizationJob> {
  logger.info('Finalizing synchronization...');

  let finalizedJob: SynchronizationJob;

  try {
    const response = await apiClient.post(
      `/persister/synchronization/jobs/${job.id}/finalize`,
      {
        partialDatasets,
      },
    );
    finalizedJob = response.data.job;
  } catch (err) {
    throw synchronizationApiError(
      err,
      'Error occurred while finalizing synchronization job.',
    );
  }

  logger.info(
    { synchronizationJob: finalizedJob },
    'Synchronization finalization result.',
  );

  return finalizedJob;
}

async function getPartialDatasets() {
  const summary = await readJsonFromPath<ExecuteIntegrationResult>(
    path.resolve(getRootStorageDirectory(), 'summary.json'),
  );

  return summary.metadata.partialDatasets;
}

export async function uploadGraphObjectData(
  synchronizationJobContext: SynchronizationJobContext,
  graphObjectData: FlushedGraphObjectData,
  uploadBatchSize?: number,
) {
  try {
    if (
      Array.isArray(graphObjectData.entities) &&
      graphObjectData.entities.length != 0
    ) {
      synchronizationJobContext.logger.info(
        {
          entities: graphObjectData.entities.length,
        },
        'Preparing batches of entities for upload',
      );

      await uploadData(
        synchronizationJobContext,
        'entities',
        graphObjectData.entities,
        uploadBatchSize,
      );

      synchronizationJobContext.logger.info(
        {
          entities: graphObjectData.entities.length,
        },
        'Successfully uploaded entities',
      );
    }

    if (
      Array.isArray(graphObjectData.relationships) &&
      graphObjectData.relationships.length != 0
    ) {
      synchronizationJobContext.logger.info(
        {
          relationships: graphObjectData.relationships.length,
        },
        'Preparing batches of relationships for upload',
      );

      await uploadData(
        synchronizationJobContext,
        'relationships',
        graphObjectData.relationships,
        uploadBatchSize,
      );

      synchronizationJobContext.logger.info(
        {
          relationships: graphObjectData.relationships.length,
        },
        'Successfully uploaded relationships',
      );
    }
  } catch (err) {
    throw synchronizationApiError(err, 'Error uploading collected data');
  }
}

/**
 * Uploads data collected by the integration into the
 */
export async function uploadCollectedData(context: SynchronizationJobContext) {
  context.logger.synchronizationUploadStart(context.job);

  async function uploadGraphObjectFile(parsedData: FlushedGraphObjectData) {
    await uploadGraphObjectData(context, parsedData);
  }

  await timeOperation({
    logger: context.logger,
    metricName: 'duration-sync-upload',
    operation: () => iterateParsedGraphFiles(uploadGraphObjectFile),
  });

  context.logger.synchronizationUploadEnd(context.job);
}

interface UploadDataLookup {
  entities: Entity;
  relationships: Relationship;
}

interface UploadDataChunkParams<T extends UploadDataLookup, K extends keyof T> {
  logger: IntegrationLogger;
  apiClient: AxiosInstance;
  jobId: string;
  type: K;
  batch: T[K][];
}

function isRequestUploadTooLargeError(err): boolean {
  return (
    err.code === 'RequestEntityTooLargeException' ||
    err.response?.status === 413
  );
}

type SystemErrorResponseData = {
  /**
   * The specific system-level error code (e.g. `ENTITY_IS_NOT_ARRAY`)
   */
  code: string;
  /**
   * The specific system-level error message
   * (e.g. `"\"entities\" should be an array"`)
   */
  message: string;
};

/**
 * The JupiterOne system will encapsulate error details in the response in
 * some situations. For example:
 *
 * {
 *   "error": {
 *     "code": "ENTITY_IS_NOT_ARRAY",
 *     "message": "\"entities\" should be an array"
 *   }
 * }
 */
function getSystemErrorResponseData(
  err: any,
): SystemErrorResponseData | undefined {
  return err.response?.data?.error;
}

type HandleUploadDataChunkErrorParams = {
  err: any;
  attemptContext: AttemptContext;
  logger: IntegrationLogger;
  batch;
};

function handleUploadDataChunkError({
  err,
  attemptContext,
  logger,
  batch,
}: HandleUploadDataChunkErrorParams): void {
  /**
   * The JupiterOne system will encapsulate error details in the response in
   * some situations. For example:
   *
   * {
   *   "error": {
   *     "code": "ENTITY_IS_NOT_ARRAY",
   *     "message": "\"entities\" should be an array"
   *   }
   * }
   */
  const systemErrorResponseData = getSystemErrorResponseData(err);

  if (isRequestUploadTooLargeError(err)) {
    logger.info(`Attempting to shrink rawData`);
    const shrinkResults = shrinkRawData(batch);
    logger.info(shrinkResults, 'Shrink raw data result');
  } else if (systemErrorResponseData?.code === 'JOB_NOT_AWAITING_UPLOADS') {
    throw new IntegrationError({
      code: 'INTEGRATION_UPLOAD_AFTER_JOB_ENDED',
      cause: err,
      fatal: true,
      message:
        'Failed to upload integration data because job has already ended',
    });
  }

  if (
    attemptContext.attemptsRemaining &&
    // There are sometimes intermittent credentials errors when running
    // a managed integration on AWS Fargate. They consistently succeed
    // with retry logic, so we don't want to log a warn.
    err.code !== 'CredentialsError'
  ) {
    logger.warn(
      {
        err,
        code: err.code,
        attemptNum: attemptContext.attemptNum,
      },
      'Failed to upload integration data chunk (will retry)',
    );
  }
}

export async function uploadDataChunk<
  T extends UploadDataLookup,
  K extends keyof T,
>({ logger, apiClient, jobId, type, batch }: UploadDataChunkParams<T, K>) {
  const uploadCorrelationId = uuid();

  await retry(
    async (ctx) => {
      logger.info(
        {
          uploadCorrelationId,
          uploadType: type,
          attemptNum: ctx.attemptNum,
          batchSize: batch.length,
        },
        'Uploading data...',
      );

      await apiClient.post(
        `/persister/synchronization/jobs/${jobId}/${type}`,
        {
          [type]: batch,
        },
        {
          headers: {
            // NOTE: Other headers that were applied when the client was created,
            // are still maintained
            [RequestHeaders.CorrelationId]: uploadCorrelationId,
          },
        },
      );
    },
    {
      maxAttempts: 5,
      delay: 200,
      factor: 1.05,
      handleError(err, attemptContext) {
        handleUploadDataChunkError({
          err,
          attemptContext,
          logger,
          batch,
        });
      },
    },
  );
}

export async function uploadData<T extends UploadDataLookup, K extends keyof T>(
  { job, apiClient, logger }: SynchronizationJobContext,
  type: K,
  data: T[K][],
  uploadBatchSize?: number,
) {
  const batches = chunk(data, uploadBatchSize || UPLOAD_BATCH_SIZE);
  await pMap(
    batches,
    async (batch: T[K][]) => {
      if (batch.length) {
        await uploadDataChunk({
          apiClient,
          logger,
          jobId: job.id,
          type,
          batch,
        });
      }
    },
    { concurrency: UPLOAD_CONCURRENCY },
  );
}

// Interface for storing both the key value and total size of a given array entry
interface KeyAndSize {
  key: string;
  size: number;
}

// Interface for shrink run results
interface ShrinkRawDataResults {
  initialSize: number;
  totalSize: number;
  itemsRemoved: number;
  totalTime: number;
}

/**
 * Helper function to find the largest entry in an object and return its key
 * and approximate byte size.  We JSON.stringify as a method to try and have
 * an apples to apples comparison no matter what the data type of the value is.
 *
 * @param data
 * @returns
 */
function getLargestItemKeyAndByteSize(data: any): KeyAndSize {
  const largestItem: KeyAndSize = { key: '', size: 0 };
  for (const item in data) {
    const length = data[item]
      ? Buffer.byteLength(JSON.stringify(data[item]))
      : 0;
    if (length > largestItem.size) {
      largestItem.key = item;
      largestItem.size = length;
    }
  }

  return largestItem;
}

/**
 * Helper function to find the largest Entity in our data array and return it.
 * We JSON.stringify as a method to try and have an apples to apples comparison
 * no matter what the data type of the value is.
 *
 * @param data
 * @returns
 */
function getLargestEntityFromBatch(
  data: UploadDataLookup[keyof UploadDataLookup][],
): Entity {
  let largestItem;
  let largestItemSize = 0;

  for (const item of data) {
    const length = item ? Buffer.byteLength(JSON.stringify(item)) : 0;
    if (length > largestItemSize) {
      largestItem = item;
      largestItemSize = length;
    }
  }
  return largestItem;
}

/**
 * Helper function to find the largest _rawData entry in an Entity and return
 * it.  We JSON.stringify as a method to try and have an apples to apples comparison
 * no matter what the data type of the value is.
 *
 * @param data
 * @returns
 */
function getLargestRawDataEntryFromEntity(
  data: EntityRawData[],
): EntityRawData {
  let largestItem;
  let largestItemSize = 0;

  for (const item of data) {
    const length = item ? Buffer.byteLength(JSON.stringify(item)) : 0;
    if (length > largestItemSize) {
      largestItem = item;
      largestItemSize = length;
    }
  }

  return largestItem;
}

/**
 * Removes data from the rawData of the largest entity until the overall size
 * of the data object is less than maxSize (defaulted to UPLOAD_SIZE_MAX).
 *
 * @param data
 */
export function shrinkRawData(
  data: UploadDataLookup[keyof UploadDataLookup][],
  maxSize = UPLOAD_SIZE_MAX,
): ShrinkRawDataResults {
  const startTimeInMilliseconds = Date.now();
  let totalSize = Buffer.byteLength(JSON.stringify(data));
  const initialSize = totalSize;
  let itemsRemoved = 0;
  const sizeOfTruncated = Buffer.byteLength("'TRUNCATED'");

  while (totalSize > maxSize) {
    // Find largest Entity
    const largestEntity = getLargestEntityFromBatch(data);

    // If we don't have any entities to shrink or the optional _rawData array is empty,
    // we have no other options than to throw an error.
    if (largestEntity?._rawData) {
      // Find largest _rawData entry (typically 0, but check to be certain)
      const largestRawDataEntry = getLargestRawDataEntryFromEntity(
        largestEntity._rawData,
      );

      // Find largest item within rawData
      const largestItemLookup = getLargestItemKeyAndByteSize(
        largestRawDataEntry.rawData,
      );

      // Truncate largest item and recalculate size to see if we need to continue truncating additional items
      largestRawDataEntry.rawData[largestItemLookup.key] = 'TRUNCATED';
      itemsRemoved += 1;
      totalSize = totalSize - largestItemLookup.size + sizeOfTruncated;
    } else {
      // Cannot find any entities to shrink, so throw
      throw new IntegrationError({
        code: 'INTEGRATION_UPLOAD_FAILED',
        fatal: false,
        message:
          'Failed to upload integration data because payload is too large and cannot shrink',
      });
    }
  }

  const endTimeInMilliseconds = Date.now();
  return {
    initialSize,
    totalSize,
    itemsRemoved,
    totalTime: endTimeInMilliseconds - startTimeInMilliseconds,
  };
}

interface AbortSynchronizationInput extends SynchronizationJobContext {
  reason?: string;
}
/**
 * Aborts a synchronization job
 */
export async function abortSynchronization({
  logger,
  apiClient,
  job,
  reason,
}: AbortSynchronizationInput) {
  logger.info('Aborting synchronization job...');

  let abortedJob: SynchronizationJob;

  try {
    const response = await apiClient.post(
      `/persister/synchronization/jobs/${job.id}/abort`,
      { reason },
    );
    abortedJob = response.data.job;
  } catch (err) {
    throw synchronizationApiError(
      err,
      'Error occurred while aborting synchronization job',
    );
  }

  return abortedJob;
}
