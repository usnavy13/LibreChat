const { logger } = require('@librechat/data-schemas');
const { SessionState } = require('~/db/models');

/**
 * Finds a session state by session_id and user.
 * @param {string} session_id - The session identifier.
 * @param {string} user - The user ID.
 * @returns {Promise<IMongoSessionState|null>} A promise that resolves to the session state document or null.
 */
const getSessionState = async (session_id, user) => {
  return await SessionState.findOne({ session_id, user }).lean();
};

/**
 * Finds session states by conversation ID.
 * @param {string} conversationId - The conversation identifier.
 * @returns {Promise<Array<IMongoSessionState>>} A promise that resolves to an array of session state documents.
 */
const getSessionStatesByConversation = async (conversationId) => {
  return await SessionState.find({ conversationId }).lean();
};

/**
 * Creates or updates a session state.
 * @param {Object} data - The session state data.
 * @param {string} data.session_id - The session identifier.
 * @param {string} data.user - The user ID.
 * @param {string} data.conversationId - The conversation ID.
 * @param {string} data.filepath - The path to the state file in storage.
 * @param {string} data.source - The storage source (e.g., 'local', 's3').
 * @param {number} data.bytes - The size of the state in bytes.
 * @param {string} data.hash - The SHA256 hash of the state.
 * @returns {Promise<IMongoSessionState>} A promise that resolves to the created/updated session state document.
 */
const createSessionState = async (data) => {
  const { session_id, user, ...rest } = data;
  return await SessionState.findOneAndUpdate(
    { session_id, user },
    { session_id, user, ...rest },
    { new: true, upsert: true },
  ).lean();
};

/**
 * Updates a session state identified by session_id and user.
 * @param {Object} data - The data to update, must contain session_id and user.
 * @returns {Promise<IMongoSessionState|null>} A promise that resolves to the updated session state document.
 */
const updateSessionState = async (data) => {
  const { session_id, user, ...update } = data;
  return await SessionState.findOneAndUpdate(
    { session_id, user },
    { $set: update },
    { new: true },
  ).lean();
};

/**
 * Deletes a session state identified by session_id and user.
 * @param {string} session_id - The session identifier.
 * @param {string} user - The user ID.
 * @returns {Promise<IMongoSessionState|null>} A promise that resolves to the deleted session state document or null.
 */
const deleteSessionState = async (session_id, user) => {
  return await SessionState.findOneAndDelete({ session_id, user }).lean();
};

/**
 * Deletes all session states for a user, optionally filtered by conversation ID.
 * @param {string} user - The user ID.
 * @param {string} [conversationId] - Optional conversation ID to filter by.
 * @returns {Promise<Object>} A promise that resolves to the result of the deletion operation.
 */
const deleteSessionStates = async (user, conversationId) => {
  const filter = { user };
  if (conversationId) {
    filter.conversationId = conversationId;
  }
  const result = await SessionState.deleteMany(filter);
  if (result.deletedCount > 0) {
    logger.info(
      `[deleteSessionStates] Deleted ${result.deletedCount} session states for user ${user}`,
    );
  }
  return result;
};

/**
 * Deletes all session states for a conversation.
 * @param {string} conversationId - The conversation ID.
 * @returns {Promise<Object>} A promise that resolves to the result of the deletion operation.
 */
const deleteSessionStatesByConversation = async (conversationId) => {
  const result = await SessionState.deleteMany({ conversationId });
  if (result.deletedCount > 0) {
    logger.info(
      `[deleteSessionStatesByConversation] Deleted ${result.deletedCount} session states for conversation ${conversationId}`,
    );
  }
  return result;
};

module.exports = {
  getSessionState,
  getSessionStatesByConversation,
  createSessionState,
  updateSessionState,
  deleteSessionState,
  deleteSessionStates,
  deleteSessionStatesByConversation,
};
