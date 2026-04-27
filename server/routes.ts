import type { Express } from "express";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { storage } from "./storage";
import { z } from "zod";

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  // GET /api/scores/:userId — fetch a user's score
  app.get("/api/scores/:userId", (req, res) => {
    const score = storage.getScore(req.params.userId);
    if (!score) return res.json(null);
    return res.json(score);
  });

  // POST /api/scores — upsert score after a round
  app.post("/api/scores", (req, res) => {
    const schema = z.object({
      spotifyUserId: z.string(),
      displayName: z.string(),
      score: z.number().int(),
      streak: z.number().int(),
      bestStreak: z.number().int(),
      gamesPlayed: z.number().int(),
      roundsWon: z.number().int(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
    const updated = storage.upsertScore(parsed.data);
    return res.json(updated);
  });

  // GET /api/leaderboard
  app.get("/api/leaderboard", (_req, res) => {
    const board = storage.getLeaderboard(10);
    return res.json(board);
  });

  return httpServer;
}
