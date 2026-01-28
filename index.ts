import dotenv from 'dotenv';
dotenv.config();

import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import OpenAI from 'openai';
import { connectDB } from './db';
import Project from './models/project';
import Log from './models/log';

// Initialize OpenAI
const openai = process.env.OPENAI_API_KEY 
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) 
  : null;

const app: Application = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));

connectDB();

// Root endpoint
app.get('/', (req: Request, res: Response) => {
  res.json({
    message: 'LogHub API Server',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/api/health',
      projects: '/api/projects',
      logs: '/api/logs/:projectId'
    }
  });
});

// Health check endpoint
app.get('/api/health', (req: Request, res: Response) => {
  const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
  res.json({ status: 'ok', database: dbStatus });
});

// --- Project Routes ---

app.get('/api/projects', async (req: Request, res: Response) => {
  try {
    const projects = await Project.find().sort({ createdAt: -1 });
    res.json(projects);
  } catch (err: any) {
    console.error('Error fetching projects:', err.message);
    res.status(500).json({ error: 'Failed to fetch projects', details: err.message });
  }
});

app.post('/api/projects', async (req: Request, res: Response) => {
  try {
    const project = new Project(req.body);
    await project.save();
    res.status(201).json(project);
  } catch (err: any) {
    console.error('Error creating project:', err.message);
    res.status(400).json({ error: 'Failed to create project', details: err.message });
  }
});

app.delete('/api/projects/:id', async (req: Request, res: Response) => {
  try {
    const projectId = req.params.id;
    console.log(`Deleting project ${projectId} and its logs...`);
    
    // Delete logs and project in parallel for speed
    const [logResult, projectResult] = await Promise.all([
      Log.deleteMany({ projectId }),
      Project.findByIdAndDelete(projectId)
    ]);
    
    console.log(`Deleted project and ${logResult.deletedCount} logs`);
    res.json({ success: true, logsDeleted: logResult.deletedCount });
  } catch (err: any) {
    console.error('Error deleting project:', err.message);
    res.status(500).json({ error: 'Failed to delete project', details: err.message });
  }
});

// --- Log Routes ---

app.get('/api/logs/:projectId', async (req: Request, res: Response) => {
  try {
    const { level, search, start, end, limit, skip } = req.query;
    const query: any = { projectId: req.params.projectId };

    if (level) query.level = { $in: (level as string).split(',') };
    if (start || end) {
      query.timestamp = {};
      if (start) query.timestamp.$gte = start;
      if (end) query.timestamp.$lte = end;
    }
    if (search) {
      query.$or = [
        { message: { $regex: search, $options: 'i' } },
        { raw: { $regex: search, $options: 'i' } },
        { component: { $regex: search, $options: 'i' } }
      ];
    }

    // Get total count
    const totalCount = await Log.countDocuments(query);
    
    // Use lean() for faster queries (returns plain JS objects instead of Mongoose docs)
    const pageLimit = limit ? parseInt(limit as string) : 50000; // Default limit
    const pageSkip = skip ? parseInt(skip as string) : 0;
    
    console.log(`Fetching logs for project ${req.params.projectId} (total: ${totalCount}, limit: ${pageLimit}, skip: ${pageSkip})`);
    
    const logs = await Log.find(query)
      .sort({ timestamp: -1 })
      .skip(pageSkip)
      .limit(pageLimit)
      .lean(); // lean() is much faster for read-only queries
    
    console.log(`Returning ${logs.length} logs`);
    res.json({ logs, total: totalCount, hasMore: totalCount > pageSkip + logs.length });
  } catch (err: any) {
    console.error('Error fetching logs:', err.message);
    res.status(500).json({ error: 'Failed to fetch logs', details: err.message });
  }
});

app.post('/api/logs/bulk', async (req: Request, res: Response) => {
  try {
    const { projectId, logs } = req.body;
    
    if (!logs || !Array.isArray(logs) || logs.length === 0) {
      return res.status(400).json({ error: 'No logs provided' });
    }
    
    console.log(`Received ${logs.length} logs for project ${projectId}`);
    
    // Map logs to include the MongoDB Project ID
    const logsToInsert = logs.map((l: any) => ({
      ...l,
      projectId
    }));
    
    // Use larger batches and parallel inserts for speed
    const BATCH_SIZE = 5000;
    const PARALLEL_BATCHES = 4;
    let insertedCount = 0;
    const totalBatches = Math.ceil(logsToInsert.length / BATCH_SIZE);
    
    // Process batches in parallel groups
    for (let i = 0; i < logsToInsert.length; i += BATCH_SIZE * PARALLEL_BATCHES) {
      const parallelPromises = [];
      
      for (let j = 0; j < PARALLEL_BATCHES; j++) {
        const startIdx = i + (j * BATCH_SIZE);
        if (startIdx >= logsToInsert.length) break;
        
        const batch = logsToInsert.slice(startIdx, startIdx + BATCH_SIZE);
        const batchNum = Math.floor(startIdx / BATCH_SIZE) + 1;
        
        parallelPromises.push(
          Log.insertMany(batch, { ordered: false })
            .then(() => {
              console.log(`Batch ${batchNum}/${totalBatches} done (${batch.length} logs)`);
              return batch.length;
            })
            .catch((err: any) => {
              console.error(`Batch ${batchNum} error:`, err.message);
              return 0;
            })
        );
      }
      
      const results = await Promise.all(parallelPromises);
      insertedCount += results.reduce((sum, count) => sum + count, 0);
    }
    
    console.log(`Successfully inserted ${insertedCount} logs for project ${projectId}`);
    res.status(201).json({ count: insertedCount });
  } catch (err: any) {
    console.error('Error bulk inserting logs:', err.message);
    res.status(500).json({ error: 'Bulk ingestion failed', details: err.message });
  }
});

// --- OpenAI Analysis Routes (Proxy to avoid CORS) ---

app.post('/api/analyze', async (req: Request, res: Response) => {
  try {
    if (!openai) {
      return res.status(500).json({ error: 'OpenAI API key not configured on server' });
    }

    const { logs } = req.body;
    if (!logs || !Array.isArray(logs) || logs.length === 0) {
      return res.status(400).json({ error: 'No logs provided' });
    }

    const logSnapshot = logs.slice(0, 150)
      .map((log: any) => `[${log.timestamp || 'NO_TS'}] [${log.level}] ${log.message}`)
      .join('\n');

    const prompt = `Analyze these logs and provide a BRIEF, ACTIONABLE summary.

FORMAT RULES:
- Use short bullet points (max 10-15 words each)
- No lengthy paragraphs or explanations
- Use emojis for quick visual scanning
- Only include what's actually found in the logs
- If nothing found for a section, skip it entirely

OUTPUT FORMAT:

📊 **Quick Stats**
• Total logs: X | Errors: X | Warnings: X
• Time range: [start] to [end]

🔴 **Critical Issues** (if any)
• [Brief issue description]
• [Another issue]

⚠️ **Warnings** (if any)
• [Brief warning]

💡 **Key Recommendations** (max 3)
• [Action item 1]
• [Action item 2]

✅ **Status**: [One line overall health assessment]

LOG DATA:
${logSnapshot}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a concise log analyst. Give brief, scannable insights. No fluff. Use bullet points. Max 200 words total." },
        { role: "user", content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 500,
    });

    const result = response.choices[0]?.message?.content || "Analysis failed.";
    res.json({ result });
  } catch (err: any) {
    console.error('OpenAI analysis error:', err.message);
    res.status(500).json({ error: 'Analysis failed', details: err.message });
  }
});

app.post('/api/anomalies', async (req: Request, res: Response) => {
  try {
    if (!openai) {
      return res.status(500).json({ error: 'OpenAI API key not configured on server' });
    }

    const { logs } = req.body;
    if (!logs || !Array.isArray(logs) || logs.length === 0) {
      return res.status(400).json({ error: 'No logs provided' });
    }

    const logSnapshot = logs.slice(0, 150)
      .map((log: any) => `[${log.timestamp || 'NO_TS'}] [${log.level}] ${log.message}`)
      .join('\n');

    const prompt = `Scan these logs for anomalies. Be BRIEF and DIRECT.

FORMAT RULES:
- Short bullet points only (max 12 words each)
- Use severity emojis: 🔴 High, 🟠 Medium, 🟡 Low
- Skip sections with no findings
- No explanations, just findings

OUTPUT FORMAT:

🔍 **Anomalies Detected**

🔴 **High Severity**
• [What's wrong] → [Impact]

🟠 **Medium Severity**  
• [What's wrong] → [Impact]

🟡 **Low Severity**
• [What's wrong] → [Impact]

🎯 **Action Required** (max 2 items)
• [Immediate action needed]

📈 **Risk Level**: [Low/Medium/High/Critical] - [One sentence why]

LOG DATA:
${logSnapshot}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are an anomaly detector. Be extremely concise. List only actual anomalies found. No generic advice. Max 150 words." },
        { role: "user", content: prompt }
      ],
      temperature: 0.2,
      max_tokens: 400,
    });

    const result = response.choices[0]?.message?.content || "Detection failed.";
    res.json({ result });
  } catch (err: any) {
    console.error('OpenAI anomaly detection error:', err.message);
    res.status(500).json({ error: 'Anomaly detection failed', details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
