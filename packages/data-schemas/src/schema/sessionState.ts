import mongoose, { Schema } from 'mongoose';
import { FileSources } from 'librechat-data-provider';
import type { IMongoSessionState } from '~/types';

const sessionState: Schema<IMongoSessionState> = new Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
      required: true,
    },
    session_id: {
      type: String,
      index: true,
      required: true,
    },
    conversationId: {
      type: String,
      ref: 'Conversation',
      index: true,
    },
    filepath: {
      type: String,
      required: true,
    },
    source: {
      type: String,
      default: FileSources.local,
      required: true,
    },
    bytes: {
      type: Number,
      required: true,
    },
    hash: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

sessionState.index({ session_id: 1, user: 1 }, { unique: true });
sessionState.index({ createdAt: 1, updatedAt: 1 });

export default sessionState;
