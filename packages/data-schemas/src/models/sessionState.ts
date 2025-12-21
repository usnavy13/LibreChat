import sessionStateSchema from '~/schema/sessionState';
import type { IMongoSessionState } from '~/types';

/**
 * Creates or returns the SessionState model using the provided mongoose instance and schema
 */
export function createSessionStateModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.SessionState ||
    mongoose.model<IMongoSessionState>('SessionState', sessionStateSchema)
  );
}
