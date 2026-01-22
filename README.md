# LogViewer Backend

This is a Node.js Express backend with MongoDB integration.

## Setup

1. Install dependencies:
   ```sh
   npm install
   ```
2. Configure your MongoDB connection in `.env`:
   ```env
   MONGODB_URI=mongodb://localhost:27017/logviewer
   PORT=3000
   ```
3. Start the server:
   ```sh
   node server.js
   ```

## Features
- Express server
- MongoDB connection using Mongoose
- Basic health check endpoint (`/`)

## Folder Structure
- `server.js` - Main server file
- `.env` - Environment variables
- `package.json` - Project metadata and dependencies

## Troubleshooting
- Ensure MongoDB is running locally or update `MONGODB_URI` for remote connection.
- If you see connection errors, update Mongoose and MongoDB packages:
  ```sh
  npm install mongoose@latest mongodb@latest
  ```

## License
MIT
