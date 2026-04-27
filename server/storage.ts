import { db } from "./db";
import { scores, type Score, type InsertScore } from "@shared/schema";
import { eq } from "drizzle-orm";

export interface IStorage {
  getScore(spotifyUserId: string): Score | undefined;
  upsertScore(data: InsertScore): Score;
  getLeaderboard(limit?: number): Score[];
}

export class DatabaseStorage implements IStorage {
  getScore(spotifyUserId: string): Score | undefined {
    return db.select().from(scores).where(eq(scores.spotifyUserId, spotifyUserId)).get();
  }

  upsertScore(data: InsertScore): Score {
    const existing = this.getScore(data.spotifyUserId);
    if (existing) {
      return db
        .update(scores)
        .set(data)
        .where(eq(scores.spotifyUserId, data.spotifyUserId))
        .returning()
        .get();
    }
    return db.insert(scores).values(data).returning().get();
  }

  getLeaderboard(limit = 10): Score[] {
    return db.select().from(scores).orderBy(scores.score).all().slice(0, limit);
  }
}

export const storage = new DatabaseStorage();
