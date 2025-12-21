const axios = require('axios');
const { logger } = require('@librechat/data-schemas');
const { getCodeBaseURL } = require('@librechat/agents');
const { logAxiosError } = require('@librechat/api');
const { FileSources } = require('librechat-data-provider');
const { getSessionState, createSessionState, deleteSessionState } = require('~/models');

// Lazy require to avoid circular dependency (strategies.js imports ./Code which imports ./state)
const getStrategyFunctions = (fileSource) => {
  const { getStrategyFunctions: _getStrategyFunctions } = require('../strategies');
  return _getStrategyFunctions(fileSource);
};

const STATE_MAX_SIZE = 50 * 1024 * 1024; // 50 MB

/**
 * Converts a readable stream to a buffer.
 * @param {import('stream').Readable} stream - The readable stream.
 * @returns {Promise<Buffer>} - The buffer containing the stream data.
 */
async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Download state blob from Code Execution Server.
 * @param {string} session_id - The session identifier.
 * @param {string} apiKey - The API key for authentication.
 * @param {string} [currentHash] - Optional ETag for conditional request.
 * @returns {Promise<{ unchanged?: boolean, notFound?: boolean, data?: Buffer, hash?: string, size?: number }>}
 */
async function downloadState(session_id, apiKey, currentHash = null) {
  try {
    const baseURL = getCodeBaseURL();
    const headers = {
      'X-API-Key': apiKey,
      'User-Agent': 'LibreChat/1.0',
    };

    if (currentHash) {
      headers['If-None-Match'] = `"${currentHash}"`;
    }

    const response = await axios({
      method: 'get',
      url: `${baseURL}/state/${session_id}`,
      responseType: 'arraybuffer',
      headers,
      validateStatus: (status) => status === 200 || status === 304 || status === 404,
      timeout: 30000,
    });

    if (response.status === 304) {
      return { unchanged: true };
    }

    if (response.status === 404) {
      return { notFound: true };
    }

    const hash = response.headers.etag?.replace(/"/g, '');
    return {
      data: Buffer.from(response.data),
      hash,
      size: response.data.byteLength,
    };
  } catch (error) {
    throw new Error(
      logAxiosError({
        message: `Error downloading state for session ${session_id}: ${error.message}`,
        error,
      }),
    );
  }
}

/**
 * Upload state blob to Code Execution Server.
 * @param {string} session_id - The session identifier.
 * @param {Buffer} buffer - The state buffer to upload.
 * @param {string} apiKey - The API key for authentication.
 * @returns {Promise<{ message: string, size: number }>}
 */
async function uploadState(session_id, buffer, apiKey) {
  try {
    const baseURL = getCodeBaseURL();

    const response = await axios({
      method: 'post',
      url: `${baseURL}/state/${session_id}`,
      data: buffer,
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/octet-stream',
        'Content-Length': buffer.length,
        'User-Agent': 'LibreChat/1.0',
      },
      maxContentLength: STATE_MAX_SIZE,
      maxBodyLength: STATE_MAX_SIZE,
      timeout: 60000,
    });

    return response.data;
  } catch (error) {
    throw new Error(
      logAxiosError({
        message: `Error uploading state for session ${session_id}: ${error.message}`,
        error,
      }),
    );
  }
}

/**
 * Check if server has state and get info.
 * @param {string} session_id - The session identifier.
 * @param {string} apiKey - The API key for authentication.
 * @returns {Promise<{ exists: boolean, size_bytes?: number, hash?: string, created_at?: string, expires_at?: string, source?: string }>}
 */
async function getStateInfo(session_id, apiKey) {
  try {
    const baseURL = getCodeBaseURL();

    const response = await axios({
      method: 'get',
      url: `${baseURL}/state/${session_id}/info`,
      headers: {
        'X-API-Key': apiKey,
        'User-Agent': 'LibreChat/1.0',
      },
      timeout: 5000,
    });

    return response.data;
  } catch (error) {
    // 404 or connection issues mean no state
    if (error.response?.status === 404) {
      return { exists: false };
    }
    logger.warn(`[getStateInfo] Error checking state for ${session_id}: ${error.message}`);
    return { exists: false };
  }
}

/**
 * Delete state from Code Execution Server.
 * @param {string} session_id - The session identifier.
 * @param {string} apiKey - The API key for authentication.
 * @returns {Promise<void>}
 */
async function deleteServerState(session_id, apiKey) {
  try {
    const baseURL = getCodeBaseURL();

    await axios({
      method: 'delete',
      url: `${baseURL}/state/${session_id}`,
      headers: {
        'X-API-Key': apiKey,
        'User-Agent': 'LibreChat/1.0',
      },
      validateStatus: () => true, // Always succeeds (204)
      timeout: 5000,
    });
  } catch (error) {
    logger.warn(`[deleteServerState] Error deleting state for ${session_id}: ${error.message}`);
    // Don't throw - deletion failures are non-critical
  }
}

/**
 * Prime Python session state before code execution.
 * Checks if server has state, restores from cache if needed.
 *
 * @param {Object} options - The options object.
 * @param {string} options.session_id - The session identifier.
 * @param {ServerRequest} options.req - The Express request object.
 * @param {string} options.apiKey - The API key for authentication.
 * @returns {Promise<{ hasState: boolean, source?: 'server' | 'restored' | null, warning?: string }>}
 */
async function primeState(options, apiKey) {
  const { session_id, req } = options;

  try {
    // Check if server has state
    const serverInfo = await getStateInfo(session_id, apiKey);

    if (serverInfo.exists) {
      return { hasState: true, source: 'server' };
    }

    // Server doesn't have state - check our cache
    const cachedState = await getSessionState(session_id, req.user.id);

    if (!cachedState) {
      return { hasState: false, source: null };
    }

    // Restore from cache
    logger.debug(`[primeState] Restoring state from cache for session ${session_id}`);
    try {
      const { getDownloadStream } = getStrategyFunctions(cachedState.source);
      const streamResponse = await getDownloadStream(req, cachedState.filepath);
      const stream = streamResponse.data || streamResponse;
      const buffer = await streamToBuffer(stream);

      await uploadState(session_id, buffer, apiKey);
      logger.info(`[primeState] Restored state for session ${session_id} (${buffer.length} bytes)`);
      return { hasState: true, source: 'restored' };
    } catch (error) {
      logger.error(`[primeState] Failed to restore state for ${session_id}: ${error.message}`);
      return {
        hasState: false,
        source: null,
        warning: 'Previous Python session state could not be restored. Starting fresh.',
      };
    }
  } catch (error) {
    logger.error(`[primeState] Error for session ${session_id}: ${error.message}`);
    return { hasState: false, source: null };
  }
}

/**
 * Process and cache session state after code execution.
 * Downloads state from server and saves to primary storage.
 *
 * @param {Object} options - The options object.
 * @param {ServerRequest} options.req - The Express request object.
 * @param {string} options.session_id - The session identifier.
 * @param {string} options.conversationId - The conversation ID.
 * @param {string} options.state_hash - The state hash for change detection.
 * @param {string} options.apiKey - The API key for authentication.
 * @returns {Promise<{ cached: boolean, bytes?: number, hash?: string }>}
 */
async function processSessionState(options) {
  const { req, session_id, conversationId, state_hash, apiKey } = options;
  const userId = req.user.id;
  const appConfig = req.config;

  try {
    // Check if we already have this exact state
    const existingState = await getSessionState(session_id, userId);

    if (existingState && existingState.hash === state_hash) {
      return { cached: true, bytes: existingState.bytes, hash: existingState.hash };
    }

    // Download state from server
    const stateResult = await downloadState(session_id, apiKey, existingState?.hash);

    if (stateResult.unchanged) {
      return { cached: true, bytes: existingState?.bytes, hash: existingState?.hash };
    }

    if (stateResult.notFound) {
      logger.warn(`[processSessionState] State not found on server for session ${session_id}`);
      return { cached: false };
    }

    // Save to primary storage
    const fileStrategy = appConfig.fileStrategy ?? FileSources.local;
    const { saveBuffer } = getStrategyFunctions(fileStrategy);

    const fileName = `${session_id}.lz4`;
    const basePath = 'code-state';

    const filepath = await saveBuffer({
      userId,
      buffer: stateResult.data,
      fileName,
      basePath,
    });

    // Create/update MongoDB record
    await createSessionState({
      session_id,
      user: userId,
      conversationId,
      filepath,
      source: fileStrategy,
      bytes: stateResult.size,
      hash: stateResult.hash,
    });

    logger.debug(
      `[processSessionState] Cached state for session ${session_id} (${stateResult.size} bytes)`,
    );
    return { cached: true, bytes: stateResult.size, hash: stateResult.hash };
  } catch (error) {
    logger.error(
      `[processSessionState] Error caching state for session ${session_id}: ${error.message}`,
    );
    return { cached: false };
  }
}

/**
 * Delete cached session state (both from storage and database).
 *
 * @param {Object} options - The options object.
 * @param {ServerRequest} options.req - The Express request object.
 * @param {string} options.session_id - The session identifier.
 * @param {string} [options.apiKey] - Optional API key to also delete from server.
 * @returns {Promise<boolean>} - Whether deletion was successful.
 */
async function deleteCachedState(options) {
  const { req, session_id, apiKey } = options;
  const userId = req.user.id;

  try {
    // Find and delete from database
    const state = await deleteSessionState(session_id, userId);

    if (state) {
      // Delete from primary storage
      try {
        const { deleteFile } = getStrategyFunctions(state.source);
        if (deleteFile) {
          await deleteFile(req, state.filepath);
        }
      } catch (error) {
        logger.warn(`[deleteCachedState] Error deleting file for ${session_id}:`, error);
      }
    }

    // Optionally delete from server
    if (apiKey) {
      await deleteServerState(session_id, apiKey);
    }

    return true;
  } catch (error) {
    logger.error(`[deleteCachedState] Error for session ${session_id}:`, error);
    return false;
  }
}

module.exports = {
  downloadState,
  uploadState,
  getStateInfo,
  deleteServerState,
  primeState,
  processSessionState,
  deleteCachedState,
};
