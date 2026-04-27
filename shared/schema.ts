import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Scores table — persists high scores per Spotify user
export const scores = sqliteTable("scores", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  spotifyUserId: text("spotify_user_id").notNull(),
  displayName: text("display_name").notNull(),
  score: integer("score").notNull().default(0),
  streak: integer("streak").notNull().default(0),
  bestStreak: integer("best_streak").notNull().default(0),
  gamesPlayed: integer("games_played").notNull().default(0),
  roundsWon: integer("rounds_won").notNull().default(0),
});

export const insertScoreSchema = createInsertSchema(scores).omit({ id: true });
export type InsertScore = z.infer<typeof insertScoreSchema>;
export type Score = typeof scores.$inferSelect;
