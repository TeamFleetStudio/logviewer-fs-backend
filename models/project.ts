
import mongoose, { Schema, Document } from 'mongoose';

export interface IProject extends Document {
  id: string;
  name: string;
  description: string;
  storagePath: string;
  streams: Array<{ id: string; name: string }>;
  sourceConfig: any;
}

const ProjectSchema: Schema = new Schema({
  name: { type: String, required: true },
  description: { type: String },
  storagePath: { type: String, default: 'Internal' },
  streams: [{ id: String, name: String }],
  sourceConfig: { type: Object }
}, { timestamps: true });

export default mongoose.model<IProject>('Project', ProjectSchema);
