import { Document, Types } from 'mongoose';

export interface IMongoSessionState extends Document {
  user: Types.ObjectId;
  session_id: string;
  conversationId?: string;
  filepath: string;
  source: string;
  bytes: number;
  hash: string;
  createdAt?: Date;
  updatedAt?: Date;
}
