import express, { type Request, type Response } from "express";
import { MastraServer } from "@mastra/express";
import { mastra } from "./mastra";

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

const server = new MastraServer({ app, mastra });
await server.init();

// Routes
app.get("/", (_req: Request, res: Response) => {
  res.json({ message: "Hello, World!" });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
