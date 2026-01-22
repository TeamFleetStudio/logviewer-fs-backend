
import mongoose, { Schema, Document } from 'mongoose';

export interface ILog extends Document {
  timestamp: string;
  level: string;
  component: string;
  message: string;
  projectId: string;
  raw: string;
  streamId: string;
}

const LogSchema: Schema = new Schema({
  timestamp: { type: String, index: true },
  level: { type: String, index: true },
  component: { type: String, index: true },
  message: { type: String },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', index: true, required: true },
  raw: { type: String },
  streamId: { type: String }
});

// Compound index for fast filtering
LogSchema.index({ projectId: 1, timestamp: -1 });

export default mongoose.model<ILog>('Log', LogSchema);
