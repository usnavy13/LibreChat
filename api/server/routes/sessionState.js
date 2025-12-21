const express = require('express');
const { EnvVar } = require('@librechat/agents');
const { logger } = require('@librechat/data-schemas');
const { deleteCachedState } = require('~/server/services/Files/Code/state');
const { loadAuthValues } = require('~/server/services/Tools/credentials');
const { getSessionState } = require('~/models');
const { requireJwtAuth, configMiddleware } = require('~/server/middleware');

const router = express.Router();

router.use(requireJwtAuth);

/**
 * GET /session-state/:session_id
 * Returns info about a cached session state.
 */
router.get('/:session_id', async (req, res) => {
  try {
    const { session_id } = req.params;
    const state = await getSessionState(session_id, req.user.id);

    if (!state) {
      return res.status(404).json({ error: 'Session state not found' });
    }

    res.json({
      session_id: state.session_id,
      conversationId: state.conversationId,
      bytes: state.bytes,
      hash: state.hash,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    });
  } catch (error) {
    logger.error('Error getting session state:', error);
    res.status(500).json({ error: 'Failed to get session state' });
  }
});

/**
 * DELETE /session-state/:session_id
 * Deletes a cached session state (resets Python environment).
 * Also deletes the state from the Code Execution Server.
 */
router.delete('/:session_id', configMiddleware, async (req, res) => {
  try {
    const { session_id } = req.params;

    // Get API key for server deletion
    let apiKey;
    try {
      const authValues = await loadAuthValues({
        userId: req.user.id,
        authFields: [EnvVar.CODE_API_KEY],
      });
      apiKey = authValues[EnvVar.CODE_API_KEY];
    } catch (error) {
      logger.warn('Could not load CODE_API_KEY for state deletion:', error);
    }

    // Delete cached state and optionally from server
    await deleteCachedState({
      req,
      session_id,
      apiKey,
    });

    res.status(204).send();
  } catch (error) {
    logger.error('Error deleting session state:', error);
    res.status(500).json({ error: 'Failed to delete session state' });
  }
});

module.exports = router;
