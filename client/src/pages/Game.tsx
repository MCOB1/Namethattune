import { useState, useEffect, useRef, useCallback, Component } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import {
  initiateSpotifyLogin,
  exchangeCodeForToken,
  refreshToken,
  getCurrentUser,
  getUserPlaylists,
  getPlaylistTracks,
  getLikedTracks,
  getCategories,
  getCategoryPlaylists,
  getFeaturedPlaylists,
  searchPlaylists,
  shuffleArray,
  SPOTIFY_CLIENT_ID,
  type SpotifyTokens,
  type SpotifyUser,
  type SpotifyPlaylist,
  type SpotifyTrack,
  type SpotifyCategory,
} from "@/lib/spotify";
import { apiRequest } from "@/lib/queryClient";
import {
  Music,
  Mic,
  MicOff,
  Play,
  SkipForward,
  Volume2,
  Trophy,
  Zap,
  CheckCircle,
  XCircle,
  ChevronRight,
  LogOut,
  Loader2,
  Headphones,
  ListMusic,
  Heart,
  AlertTriangle,
  Star,
  ChevronDown,
  Clock,
  Lightbulb,
  Flag,
  Search,
  X,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────
type GameView = "setup" | "source-select" | "playing" | "game-over";
type GuessMode = "song" | "artist" | "either" | "both";
type GuessResult = "correct" | "partial" | "wrong" | null;

interface GameState {
  tracks: SpotifyTrack[];
  currentIndex: number;
  score: number;
  streak: number;
  bestStreak: number;
  roundsWon: number;
  totalRounds: number;
}

// Each wrong guess adds 5 seconds. Max 6 guesses total.
const INITIAL_CLIP_MS = 5000;
const EXTRA_CLIP_MS = 5000;
const MAX_GUESSES = 6;
const ROUNDS_PER_GAME = 10;

// Points: more points for getting it in fewer guesses
const GUESS_POINTS = [5, 4, 3, 2, 1, 1]; // indexed by guess attempt (0-based)
const PARTIAL_MULTIPLIER = 0.5; // partial credit = half points, rounded

const GUESS_MODE_LABELS: Record<GuessMode, string> = {
  song:   "Song title",
  artist: "Artist name",
  either: "Song or Artist",
  both:   "Song AND Artist",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function normalize(str: string): string {
  return str
    .toLowerCase()
    .replace(/[''`]/g, "'")
    .replace(/[^a-z0-9'\s]/g, "")
    .replace(/\b(the|a|an|and|&|feat|ft|featuring)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Levenshtein distance for fuzzy matching
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

function fuzzyMatch(guess: string, target: string): boolean {
  const g = normalize(guess);
  const t = normalize(target);
  if (!g || !t) return false;
  // Exact after normalize
  if (g === t) return true;
  // Substring (3+ chars)
  if (g.length >= 3 && t.includes(g)) return true;
  if (t.length >= 3 && g.includes(t)) return true;
  // Levenshtein within ~20% of longer string
  const maxDist = Math.floor(Math.max(g.length, t.length) * 0.25);
  return maxDist > 0 && levenshtein(g, t) <= maxDist;
}

function titleMatch(guess: string, track: SpotifyTrack): boolean {
  return fuzzyMatch(guess, track.name);
}

function artistMatch(guess: string, track: SpotifyTrack): boolean {
  return track.artists.some((a) => fuzzyMatch(guess, a.name));
}

// Returns "correct", "partial", or "wrong"
function checkGuess(guess: string, track: SpotifyTrack, mode: GuessMode): GuessResult {
  const songOk = titleMatch(guess, track);
  const artistOk = artistMatch(guess, track);

  switch (mode) {
    case "song":
      return songOk ? "correct" : "wrong";
    case "artist":
      return artistOk ? "correct" : "wrong";
    case "either":
      return (songOk || artistOk) ? "correct" : "wrong";
    case "both":
      if (songOk && artistOk) return "correct";
      if (songOk || artistOk) return "partial"; // got one of two
      return "wrong";
  }
}

function getAlbumArt(track: SpotifyTrack): string {
  return track.album.images?.[0]?.url || "";
}

// Generate a letter-reveal hint: first N letters shown, rest as underscores
// e.g. "Hotel California" with revealCount=1 → "H____ C_________"
function generateLetterHint(text: string, revealCount: number): string {
  return text
    .split(" ")
    .map((word) => {
      if (!word) return "";
      const reveal = Math.min(revealCount, word.length);
      return word.slice(0, reveal) + "_".repeat(word.length - reveal);
    })
    .join(" ");
}

// Generate context hints from track metadata (no external API needed)
function getContextHints(track: SpotifyTrack): string[] {
  const hints: string[] = [];
  const artistName = track.artists[0]?.name || "";
  const songName = track.name;
  const albumName = track.album.name;
  const durationSec = Math.round(track.duration_ms / 1000);
  const durationMin = Math.floor(durationSec / 60);
  const durationRemSec = durationSec % 60;

  // Word/character counts
  const songWords = songName.trim().split(/\s+/).length;
  const artistWords = artistName.trim().split(/\s+/).length;

  // First letter clues
  const songFirst = songName[0]?.toUpperCase();
  const artistFirst = artistName[0]?.toUpperCase();

  // Build hints in order of usefulness
  hints.push(`The song title starts with the letter "${songFirst}" and has ${songWords} word${songWords !== 1 ? "s" : ""}`);
  hints.push(`The artist's name starts with "${artistFirst}" and has ${artistWords === 1 ? "one word" : `${artistWords} words`}`);
  hints.push(`The full song is about ${durationMin}m ${durationRemSec}s long`);
  hints.push(`This track is from the album: "${albumName}"`);

  // Syllable feel hint for the song
  const vowels = songName.toLowerCase().replace(/[^aeiouy]/g, "").length;
  if (vowels <= 3) hints.push(`The song title is short — only ${vowels} syllable${vowels !== 1 ? "s" : ""} worth of vowels`);
  else hints.push(`The song title has ${vowels} vowels in it`);

  // Artist collaboration hint
  if (track.artists.length > 1) {
    hints.push(`This is a collaboration — ${track.artists.length} artists are credited on this track`);
  } else {
    hints.push(`This song is performed by a solo artist (just one name in the credits)`);
  }

  return hints;
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function Game() {
  const { toast } = useToast();

  // Auth
  const [tokens, setTokens] = useState<SpotifyTokens | null>(null);
  const [user, setUser] = useState<SpotifyUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [clientIdMissing, setClientIdMissing] = useState(false);

  // Source selection
  const [sourceTab, setSourceTab] = useState<"mine" | "spotify">("mine");
  const [myPlaylists, setMyPlaylists] = useState<SpotifyPlaylist[]>([]);
  const [categories, setCategories] = useState<SpotifyCategory[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<SpotifyCategory | null>(null);
  const [categoryPlaylists, setCategoryPlaylists] = useState<SpotifyPlaylist[]>([]);
  const [featuredPlaylists, setFeaturedPlaylists] = useState<SpotifyPlaylist[]>([]);
  const [loadingPlaylists, setLoadingPlaylists] = useState(false);
  const [selectedSource, setSelectedSource] = useState<"liked" | string>("liked");
  // Spotify search
  const [spotifySearchQuery, setSpotifySearchQuery] = useState("");
  const [spotifySearchResults, setSpotifySearchResults] = useState<SpotifyPlaylist[]>([]);
  const [searchingSpotify, setSearchingSpotify] = useState(false);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Guess mode
  const [guessMode, setGuessMode] = useState<GuessMode>("either");

  // Game
  const [view, setView] = useState<GameView>("setup");
  const [game, setGame] = useState<GameState | null>(null);
  const [guess, setGuess] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [result, setResult] = useState<GuessResult>(null);
  const [loadingTracks, setLoadingTracks] = useState(false);
  const [sdkReady, setSdkReady] = useState(false);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);

  // Per-round tracking
  const [guessAttempt, setGuessAttempt] = useState(0); // 0-based, which attempt we're on
  const [clipDurationMs, setClipDurationMs] = useState(INITIAL_CLIP_MS);
  const [clipTimer, setClipTimer] = useState(INITIAL_CLIP_MS / 1000);
  const [wrongGuesses, setWrongGuesses] = useState<string[]>([]);
  const [hints, setHints] = useState<string[]>([]); // list of revealed hints so far
  const [hintIndex, setHintIndex] = useState(0);    // which hint slot we're on next
  const [letterReveal, setLetterReveal] = useState(1); // how many letters shown in letter hint
  const [pointsEarned, setPointsEarned] = useState(0);

  const playerRef = useRef<any>(null);
  const clipTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tokensRef = useRef<SpotifyTokens | null>(null);

  useEffect(() => { tokensRef.current = tokens; }, [tokens]);

  // ─── Token helper ────────────────────────────────────────────────
  const getValidToken = useCallback(async (): Promise<string | null> => {
    const t = tokensRef.current;
    if (!t) return null;
    if (Date.now() < t.expires_at - 60000) return t.access_token;
    const refreshed = await refreshToken(t.refresh_token);
    if (!refreshed) return null;
    setTokens(refreshed);
    return refreshed.access_token;
  }, []);

  // ─── OAuth callback ──────────────────────────────────────────────
  useEffect(() => {
    if (!SPOTIFY_CLIENT_ID) { setClientIdMissing(true); setAuthLoading(false); return; }
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    if (code && state) {
      window.history.replaceState({}, "", window.location.pathname);
      setAuthLoading(true);
      exchangeCodeForToken(code, state).then(async (t) => {
        if (!t) { toast({ title: "Auth failed", variant: "destructive" }); setAuthLoading(false); return; }
        setTokens(t);
        try { const u = await getCurrentUser(t.access_token); setUser(u); } catch {}
        setAuthLoading(false);
      });
    } else {
      setAuthLoading(false);
    }
  }, []);

  // ─── Spotify Web Playback SDK ─────────────────────────────────────
  useEffect(() => {
    if (!tokens) return;
    if (!document.getElementById("spotify-sdk")) {
      const script = document.createElement("script");
      script.id = "spotify-sdk";
      script.src = "https://sdk.scdn.co/spotify-player.js";
      script.async = true;
      document.body.appendChild(script);
    }
    (window as any).onSpotifyWebPlaybackSDKReady = () => {
      const player = new (window as any).Spotify.Player({
        name: "Name That Tune",
        getOAuthToken: async (cb: (t: string) => void) => { const t = await getValidToken(); if (t) cb(t); },
        volume: 0.8,
      });
      player.addListener("ready", ({ device_id }: any) => { setDeviceId(device_id); setSdkReady(true); setPlayerError(null); });
      player.addListener("not_ready", () => { setSdkReady(false); });
      player.addListener("authentication_error", () => setPlayerError("Auth error — Spotify Premium required."));
      player.addListener("account_error", () => setPlayerError("Spotify Premium required for in-browser playback."));
      player.connect();
      playerRef.current = player;
    };
    return () => { playerRef.current?.disconnect(); };
  }, [tokens, getValidToken]);

  // ─── Load my playlists ───────────────────────────────────────────
  const loadMyPlaylists = useCallback(async () => {
    const token = await getValidToken();
    if (!token) return;
    setLoadingPlaylists(true);
    try { setMyPlaylists(await getUserPlaylists(token)); } catch {}
    setLoadingPlaylists(false);
  }, [getValidToken]);

  // ─── Load Spotify categories ─────────────────────────────────────
  const loadCategories = useCallback(async () => {
    const token = await getValidToken();
    if (!token) return;
    setLoadingPlaylists(true);
    try {
      const [cats, featured] = await Promise.all([
        getCategories(token),
        getFeaturedPlaylists(token),
      ]);
      setCategories(cats || []);
      setFeaturedPlaylists(featured || []);
    } catch (e) {
      console.error("Failed to load categories:", e);
      setCategories([]);
      setFeaturedPlaylists([]);
    }
    setLoadingPlaylists(false);
  }, [getValidToken]);

  // ─── Load category playlists ─────────────────────────────────────
  const loadCategoryPlaylists = useCallback(async (cat: SpotifyCategory) => {
    const token = await getValidToken();
    if (!token) return;
    setSelectedCategory(cat);
    setCategoryPlaylists([]);
    setLoadingPlaylists(true);
    try {
      let pls = await getCategoryPlaylists(cat.id, token);
      // Fallback: if nothing came back, search by name directly
      if (!pls || pls.length === 0) {
        pls = await getCategoryPlaylists(cat.name, token);
      }
      setCategoryPlaylists(pls || []);
    } catch (e) {
      console.error("loadCategoryPlaylists error:", e);
      setCategoryPlaylists([]);
    }
    setLoadingPlaylists(false);
  }, [getValidToken]);

  useEffect(() => {
    if (!tokens || view !== "source-select") return;
    if (sourceTab === "mine") loadMyPlaylists();
    // Spotify tab: categories load is no longer needed — we use live search
  }, [tokens, view, sourceTab]);

  // ─── Spotify playlist search (debounced) ─────────────────────────────
  const handleSpotifySearch = useCallback((q: string) => {
    setSpotifySearchQuery(q);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (!q.trim()) { setSpotifySearchResults([]); return; }
    searchDebounceRef.current = setTimeout(async () => {
      const token = await getValidToken();
      if (!token) return;
      setSearchingSpotify(true);
      try {
        const results = await searchPlaylists(q, token);
        setSpotifySearchResults(results);
      } catch (e) {
        console.error("Spotify search error:", e);
        setSpotifySearchResults([]);
      }
      setSearchingSpotify(false);
    }, 500);
  }, [getValidToken]);

  // ─── Reset round state ───────────────────────────────────────────
  const resetRound = useCallback(() => {
    setGuess("");
    setResult(null);
    setRevealed(false);
    setIsPlaying(false);
    setGuessAttempt(0);
    setClipDurationMs(INITIAL_CLIP_MS);
    setClipTimer(INITIAL_CLIP_MS / 1000);
    setWrongGuesses([]);
    setHints([]);
    setHintIndex(0);
    setLetterReveal(1);
    setPointsEarned(0);
  }, []);

  // ─── Start game ──────────────────────────────────────────────────
  const startGame = useCallback(async () => {
    const token = await getValidToken();
    if (!token) return;
    setLoadingTracks(true);
    try {
      let tracks: SpotifyTrack[];
      if (selectedSource === "liked") tracks = await getLikedTracks(token);
      else tracks = await getPlaylistTracks(selectedSource, token);

      if (tracks.length < 5) {
        toast({ title: "Not enough tracks", description: "Need at least 5 tracks. Try a different source.", variant: "destructive" });
        setLoadingTracks(false);
        return;
      }
      const shuffled = shuffleArray(tracks).slice(0, ROUNDS_PER_GAME);
      setGame({ tracks: shuffled, currentIndex: 0, score: 0, streak: 0, bestStreak: 0, roundsWon: 0, totalRounds: shuffled.length });
      resetRound();
      setView("playing");
    } catch (e) {
      toast({ title: "Failed to load tracks", description: String(e), variant: "destructive" });
    }
    setLoadingTracks(false);
  }, [getValidToken, selectedSource, toast, resetRound]);

  // ─── Clear timers ────────────────────────────────────────────────
  const clearTimers = useCallback(() => {
    if (clipTimerRef.current) clearInterval(clipTimerRef.current);
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
  }, []);

  // ─── Pause playback ──────────────────────────────────────────────
  const pausePlayback = useCallback(async () => {
    const t = await getValidToken();
    if (t && deviceId) {
      fetch(`https://api.spotify.com/v1/me/player/pause?device_id=${deviceId}`, {
        method: "PUT", headers: { Authorization: `Bearer ${t}` },
      }).catch(() => {});
    }
    setIsPlaying(false);
  }, [getValidToken, deviceId]);

  // ─── Play clip ───────────────────────────────────────────────────
  const playClip = useCallback(async (durationMs: number, startFromMs: number = 0) => {
    if (!game || !deviceId || !sdkReady) return;
    const track = game.tracks[game.currentIndex];
    const token = await getValidToken();
    if (!token) return;

    setIsPlaying(true);
    const segmentMs = durationMs - startFromMs;
    let remaining = segmentMs / 1000;
    setClipTimer(remaining);

    try {
      await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ uris: [track.uri], position_ms: startFromMs }),
      });

      clearTimers();
      clipTimerRef.current = setInterval(() => {
        remaining -= 0.1;
        setClipTimer(Math.max(0, remaining));
      }, 100);

      stopTimerRef.current = setTimeout(async () => {
        clearTimers();
        await pausePlayback();
        setClipTimer(0);
      }, segmentMs);

    } catch {
      setIsPlaying(false);
      toast({ title: "Playback failed", description: "Check your Spotify connection.", variant: "destructive" });
    }
  }, [game, deviceId, sdkReady, getValidToken, clearTimers, pausePlayback, toast]);

  // ─── Play more time (after wrong guess) ─────────────────────────
  const playMoreTime = useCallback(async () => {
    clearTimers();
    await pausePlayback();
    const prevDuration = clipDurationMs;
    const newDuration = clipDurationMs + EXTRA_CLIP_MS;
    setClipDurationMs(newDuration);
    setTimeout(() => playClip(newDuration, prevDuration), 400);
  }, [clipDurationMs, clearTimers, pausePlayback, playClip]);

  // ─── Hint ────────────────────────────────────────────────────────
  // Hints rotate through: context facts first, then letter reveals
  const showHint = useCallback(() => {
    if (!game) return;
    const track = game.tracks[game.currentIndex];
    const contextHints = getContextHints(track);
    const totalContextHints = contextHints.length;

    let newHintText = "";

    if (hintIndex < totalContextHints) {
      // Show the next context hint
      newHintText = contextHints[hintIndex];
      setHintIndex(hintIndex + 1);
    } else {
      // All context hints shown — now do progressive letter reveals
      const rev = letterReveal;
      const parts: string[] = [];
      if (guessMode === "song" || guessMode === "either" || guessMode === "both") {
        parts.push(`Song: ${generateLetterHint(track.name, rev)}`);
      }
      if (guessMode === "artist" || guessMode === "either" || guessMode === "both") {
        parts.push(`Artist: ${generateLetterHint(track.artists[0].name, rev)}`);
      }
      newHintText = parts.join("  •  ");
      setLetterReveal(rev + 1);
      setHintIndex(hintIndex + 1);
    }

    setHints(prev => [...prev, newHintText]);
  }, [game, guessMode, hintIndex, letterReveal]);

  // ─── Submit guess ────────────────────────────────────────────────
  const submitGuess = useCallback((guessText: string) => {
    if (!game || result !== null || !guessText.trim()) return;
    const track = game.tracks[game.currentIndex];
    const guessResult = checkGuess(guessText, track, guessMode);

    if (guessResult === "correct" || guessResult === "partial") {
      clearTimers();
      pausePlayback();

      const basePoints = GUESS_POINTS[Math.min(guessAttempt, GUESS_POINTS.length - 1)];
      const pts = guessResult === "partial" ? Math.max(1, Math.round(basePoints * PARTIAL_MULTIPLIER)) : basePoints;

      setPointsEarned(pts);
      setGame(prev => prev ? {
        ...prev,
        score: prev.score + pts,
        streak: prev.streak + 1,
        bestStreak: Math.max(prev.bestStreak, prev.streak + 1),
        roundsWon: prev.roundsWon + 1,
      } : prev);
      setResult(guessResult);
      setRevealed(true);
    } else {
      // Wrong
      const newAttempt = guessAttempt + 1;
      const newWrong = [...wrongGuesses, guessText];
      setWrongGuesses(newWrong);

      if (newAttempt >= MAX_GUESSES) {
        // Out of guesses — reveal answer
        clearTimers();
        pausePlayback();
        setGame(prev => prev ? { ...prev, streak: 0 } : prev);
        setResult("wrong");
        setRevealed(true);
      } else {
        setGuessAttempt(newAttempt);
        setGuess("");
        // Extend clip automatically on wrong guess
        clearTimers();
        pausePlayback();
        const newDuration = clipDurationMs + EXTRA_CLIP_MS;
        setClipDurationMs(newDuration);
        // play the new extra segment from where we left off
        setTimeout(() => playClip(newDuration, clipDurationMs), 400);
      }
    }
  }, [game, result, guessMode, guessAttempt, wrongGuesses, clipDurationMs, clearTimers, pausePlayback, playClip]);

  // ─── Give up ─────────────────────────────────────────────────────
  const giveUp = useCallback(() => {
    if (!game || result !== null) return;
    clearTimers();
    pausePlayback();
    setGame(prev => prev ? { ...prev, streak: 0 } : prev);
    setResult("wrong");
    setRevealed(true);
    setPointsEarned(0);
  }, [game, result, clearTimers, pausePlayback]);

  // ─── Next round ──────────────────────────────────────────────────
  const nextRound = useCallback(async () => {
    if (!game) return;
    const nextIndex = game.currentIndex + 1;
    if (nextIndex >= game.totalRounds) {
      if (user) {
        try {
          await apiRequest("POST", "/api/scores", {
            spotifyUserId: user.id, displayName: user.display_name,
            score: game.score, streak: game.streak, bestStreak: game.bestStreak,
            gamesPlayed: 1, roundsWon: game.roundsWon,
          });
        } catch {}
      }
      setView("game-over");
      return;
    }
    setGame(prev => prev ? { ...prev, currentIndex: nextIndex } : prev);
    resetRound();
  }, [game, user, resetRound]);

  // ─── Voice input ─────────────────────────────────────────────────
  const { state: voiceState, toggle: toggleVoice } = useVoiceInput({
    onResult: (transcript) => { setGuess(transcript); submitGuess(transcript); },
    onError: (err) => toast({ title: "Voice error", description: err, variant: "destructive" }),
  });

  const logout = () => {
    setTokens(null); setUser(null); setView("setup");
    playerRef.current?.disconnect();
  };

  // ─── Render ───────────────────────────────────────────────────────
  if (clientIdMissing) return <SetupRequired />;
  if (authLoading) return <Spinner />;
  if (!tokens || !user) return <LoginScreen onLogin={initiateSpotifyLogin} />;

  if (view === "source-select") {
    return (
      <SourceSelectScreen
        user={user}
        sourceTab={sourceTab}
        onTabChange={(tab) => { setSourceTab(tab); setSelectedCategory(null); setSpotifySearchQuery(""); setSpotifySearchResults([]); }}
        myPlaylists={myPlaylists}
        loading={loadingPlaylists}
        selectedSource={selectedSource}
        onSelect={setSelectedSource}
        guessMode={guessMode}
        onGuessModeChange={setGuessMode}
        onStart={startGame}
        onBack={() => setView("setup")}
        loadingTracks={loadingTracks}
        onLogout={logout}
        spotifySearchQuery={spotifySearchQuery}
        spotifySearchResults={spotifySearchResults}
        searchingSpotify={searchingSpotify}
        onSpotifySearch={handleSpotifySearch}
      />
    );
  }

  if (view === "game-over" && game && user) {
    return <GameOverScreen game={game} user={user} onPlayAgain={() => setView("source-select")} onLogout={logout} />;
  }

  if (view === "playing" && game) {
    const track = game.tracks[game.currentIndex];
    return (
      <PlayingScreen
        game={game} track={track}
        isPlaying={isPlaying} clipTimer={clipTimer}
        clipDurationMs={clipDurationMs} guessAttempt={guessAttempt}
        guess={guess} onGuessChange={setGuess}
        onSubmit={() => submitGuess(guess)}
        onPlayClip={() => playClip(clipDurationMs, 0)}
        onMoreTime={playMoreTime}
        onNext={nextRound}
        onGiveUp={giveUp}
        result={result} revealed={revealed}
        wrongGuesses={wrongGuesses}
        hints={hints}
        onShowHint={showHint}
        pointsEarned={pointsEarned}
        voiceState={voiceState} onToggleVoice={toggleVoice}
        sdkReady={sdkReady} playerError={playerError}
        guessMode={guessMode}
        onLogout={logout}
      />
    );
  }

  return (
    <HomeScreen
      user={user} sdkReady={sdkReady} playerError={playerError}
      onStart={() => setView("source-select")}
      onLogout={logout}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-screens
// ─────────────────────────────────────────────────────────────────────────────

function Spinner() {
  return <div className="min-h-screen flex items-center justify-center bg-background"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
}

function SetupRequired() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="max-w-lg w-full space-y-6">
        <div className="text-center space-y-3">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto">
            <AlertTriangle className="w-8 h-8 text-primary" />
          </div>
          <h1 className="text-2xl font-bold">Setup Required</h1>
          <p className="text-muted-foreground">Add your Spotify Client ID to get started.</p>
        </div>
      </div>
    </div>
  );
}

function LoginScreen({ onLogin }: { onLogin: () => void }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="max-w-sm w-full text-center space-y-8">
        <div className="space-y-4">
          <div className="w-20 h-20 rounded-3xl bg-primary flex items-center justify-center mx-auto shadow-lg shadow-primary/30">
            <Music className="w-10 h-10 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Name That Tune</h1>
            <p className="text-muted-foreground mt-1">Identify songs from just a few seconds</p>
          </div>
        </div>
        <div className="space-y-3">
          {[
            { icon: Headphones, text: "Requires Spotify Premium" },
            { icon: Mic, text: "Guess by voice or typing" },
            { icon: Clock, text: "6 chances per song, 5 seconds each" },
          ].map(({ icon: Icon, text }, i) => (
            <div key={i} className="flex items-center gap-3 bg-card border border-border rounded-lg p-3 text-base text-muted-foreground">
              <Icon className="w-4 h-4 shrink-0 text-primary" />{text}
            </div>
          ))}
        </div>
        <Button data-testid="button-login" onClick={onLogin} className="w-full h-12 text-base font-semibold bg-[#1DB954] hover:bg-[#1ed760] text-black">
          <svg className="w-5 h-5 mr-2" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>
          Connect with Spotify
        </Button>
      </div>
    </div>
  );
}

function HomeScreen({ user, sdkReady, playerError, onStart, onLogout }: {
  user: SpotifyUser; sdkReady: boolean; playerError: string | null; onStart: () => void; onLogout: () => void;
}) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background p-6">
      <div className="max-w-sm w-full space-y-8">
        <div className="text-center space-y-3">
          <div className="w-20 h-20 rounded-3xl bg-primary flex items-center justify-center mx-auto shadow-lg shadow-primary/30">
            <Music className="w-10 h-10 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">Name That Tune</h1>
            <p className="text-muted-foreground">Hey, {user.display_name.split(" ")[0]}!</p>
          </div>
        </div>
        {playerError ? (
          <div className="flex items-start gap-3 bg-destructive/10 border border-destructive/30 rounded-xl p-4 text-sm text-destructive">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /><span>{playerError}</span>
          </div>
        ) : !sdkReady ? (
          <div className="flex items-center gap-3 bg-card border border-border rounded-xl p-4 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin shrink-0" /><span>Initializing Spotify player…</span>
          </div>
        ) : (
          <div className="flex items-center gap-3 bg-card border border-border rounded-xl p-4 text-sm">
            <div className="w-2 h-2 rounded-full bg-green-500 shrink-0" /><span>Spotify player ready</span>
          </div>
        )}
        <div className="space-y-2">
          {[
            { icon: Play, text: "Hit Play — hear the first 5 seconds" },
            { icon: Clock, text: "Each wrong guess plays 5 more seconds" },
            { icon: Mic, text: "Guess by voice or typing — song, artist, or both" },
            { icon: Trophy, text: "Score more points for faster correct guesses" },
          ].map(({ icon: Icon, text }, i) => (
            <div key={i} className="flex items-center gap-3 text-sm text-muted-foreground">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                <Icon className="w-4 h-4 text-primary" />
              </div>{text}
            </div>
          ))}
        </div>
        <div className="space-y-3">
          <Button data-testid="button-play" className="w-full h-12 text-base font-semibold" onClick={onStart} disabled={!sdkReady}>
            Choose Songs & Play <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
          <Button variant="ghost" size="sm" className="w-full text-muted-foreground" onClick={onLogout}>
            <LogOut className="w-3 h-3 mr-1" /> Disconnect Spotify
          </Button>
        </div>
      </div>
    </div>
  );
}

function PlaylistButton({ playlist, selected, onSelect }: { playlist: SpotifyPlaylist; selected: boolean; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      className={`w-full flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${selected ? "border-primary bg-primary/10" : "border-border bg-card hover:border-primary/50"}`}
    >
      <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center shrink-0 overflow-hidden">
        {playlist.images?.[0]?.url ? (
          <img src={playlist.images[0].url} alt={playlist.name} className="w-full h-full object-cover" />
        ) : (
          <ListMusic className="w-5 h-5 text-muted-foreground" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm text-foreground truncate">{playlist.name}</p>
        <p className="text-sm text-muted-foreground">{playlist.tracks?.total ?? "?"} tracks</p>
      </div>
      {selected && <CheckCircle className="w-4 h-4 text-primary shrink-0" />}
    </button>
  );
}

function SourceSelectScreen({
  user, sourceTab, onTabChange, myPlaylists, loading, selectedSource,
  onSelect, guessMode, onGuessModeChange, onStart, onBack, loadingTracks, onLogout,
  spotifySearchQuery, spotifySearchResults, searchingSpotify, onSpotifySearch,
}: {
  user: SpotifyUser; sourceTab: "mine" | "spotify";
  onTabChange: (t: "mine" | "spotify") => void;
  myPlaylists: SpotifyPlaylist[];
  loading: boolean; selectedSource: string; onSelect: (s: string) => void;
  guessMode: GuessMode; onGuessModeChange: (m: GuessMode) => void;
  onStart: () => void; onBack: () => void; loadingTracks: boolean; onLogout: () => void;
  spotifySearchQuery: string; spotifySearchResults: SpotifyPlaylist[];
  searchingSpotify: boolean; onSpotifySearch: (q: string) => void;
}) {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="flex items-center justify-between px-5 py-4 border-b border-border">
        <button onClick={onBack} className="text-muted-foreground hover:text-foreground text-base">← Back</button>
        <span className="font-semibold text-base">Choose your music</span>
        <button onClick={onLogout} className="text-muted-foreground hover:text-foreground"><LogOut className="w-4 h-4" /></button>
      </header>

      {/* 3-column layout */}
      <div className="flex-1 overflow-hidden grid grid-cols-1 md:grid-cols-3 gap-0 divide-y md:divide-y-0 md:divide-x divide-border">

        {/* Column 1 — Guessing mode */}
        <div className="flex flex-col p-5 overflow-y-auto">
          <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">What are you guessing?</p>
          <div className="grid grid-cols-1 gap-2">
            {(["song", "artist", "either", "both"] as GuessMode[]).map((m) => (
              <button
                key={m}
                onClick={() => onGuessModeChange(m)}
                className={`p-3 rounded-xl border text-sm font-medium transition-all text-left ${guessMode === m ? "border-primary bg-primary/10 text-primary" : "border-border bg-card text-muted-foreground hover:border-primary/50"}`}
              >
                <span className="block font-semibold">{GUESS_MODE_LABELS[m]}</span>
                <span className="block text-xs opacity-70 mt-0.5">
                  {m === "song" && "Identify the track title only"}
                  {m === "artist" && "Identify the performer only"}
                  {m === "either" && "Name either the song or artist"}
                  {m === "both" && "Name both — partial credit if one"}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Column 2 — Music source */}
        <div className="flex flex-col p-5 overflow-y-auto">
          <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Music source</p>

          {/* Tabs */}
          <div className="flex gap-2 mb-4">
            {([["mine", "My Music"], ["spotify", "Spotify Search"]] as const).map(([tab, label]) => (
              <button
                key={tab}
                onClick={() => onTabChange(tab)}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${
                  sourceTab === tab
                    ? "bg-primary text-primary-foreground"
                    : "bg-card border border-border text-muted-foreground hover:border-primary/50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="flex-1 space-y-2 min-h-0 overflow-y-auto">
            {sourceTab === "mine" ? (
              /* ── My Music ─────────────────────────────── */
              loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <>
                  {/* Liked Songs */}
                  <button
                    onClick={() => onSelect("liked")}
                    className={`w-full flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${
                      selectedSource === "liked" ? "border-primary bg-primary/10" : "border-border bg-card hover:border-primary/50"
                    }`}
                  >
                    <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center shrink-0">
                      <Heart className="w-5 h-5 text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm text-foreground">Liked Songs</p>
                      <p className="text-sm text-muted-foreground">Your saved tracks</p>
                    </div>
                    {selectedSource === "liked" && <CheckCircle className="w-4 h-4 text-primary ml-auto" />}
                  </button>
                  {myPlaylists.map(pl => (
                    <PlaylistButton key={pl.id} playlist={pl} selected={selectedSource === pl.id} onSelect={() => onSelect(pl.id)} />
                  ))}
                </>
              )
            ) : (
              /* ── Spotify Search ────────────────────────── */
              <>
                {/* Search box */}
                <div className="relative mb-2">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                  <input
                    type="text"
                    value={spotifySearchQuery}
                    onChange={e => onSpotifySearch(e.target.value)}
                    placeholder="Search playlists on Spotify…"
                    className="w-full h-11 pl-9 pr-9 rounded-xl border-2 border-primary/40 bg-card text-foreground placeholder:text-muted-foreground text-sm focus:outline-none focus:border-primary transition-colors"
                    autoFocus
                  />
                  {spotifySearchQuery && (
                    <button
                      onClick={() => onSpotifySearch("")}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>

                {/* States */}
                {searchingSpotify && (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                    <span className="ml-2 text-sm text-muted-foreground">Searching…</span>
                  </div>
                )}

                {!searchingSpotify && !spotifySearchQuery && (
                  <div className="text-center py-10 space-y-2">
                    <Search className="w-8 h-8 text-muted-foreground/40 mx-auto" />
                    <p className="text-sm text-muted-foreground">Type anything — genre, decade, mood, artist name…</p>
                    <p className="text-xs text-muted-foreground/60">e.g. "70s rock", "chill vibes", "Taylor Swift"</p>
                  </div>
                )}

                {!searchingSpotify && spotifySearchQuery && spotifySearchResults.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-8">No playlists found for "{spotifySearchQuery}"</p>
                )}

                {!searchingSpotify && spotifySearchResults.map(pl => (
                  <PlaylistButton key={pl.id} playlist={pl} selected={selectedSource === pl.id} onSelect={() => onSelect(pl.id)} />
                ))}
              </>
            )}
          </div>
        </div>

        {/* Column 3 — Rules + Start */}
        <div className="flex flex-col p-5">
          {/* Start button at the TOP */}
          <Button
            data-testid="button-start-game"
            className="w-full h-12 text-base font-semibold mb-5"
            onClick={onStart}
            disabled={loadingTracks}
          >
            {loadingTracks
              ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Loading tracks…</>
              : <><Play className="w-4 h-4 mr-2" />Start Game</>}
          </Button>

          <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Rules</p>

          <div className="space-y-3 overflow-y-auto">
            {/* Current settings summary */}
            <div className="bg-card border border-border rounded-xl p-4 space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Mode</span>
                <span className="font-medium text-foreground">{GUESS_MODE_LABELS[guessMode]}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Rounds</span>
                <span className="font-medium text-foreground">{ROUNDS_PER_GAME}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Chances / song</span>
                <span className="font-medium text-foreground">{MAX_GUESSES}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">First clip</span>
                <span className="font-medium text-foreground">{INITIAL_CLIP_MS / 1000}s</span>
              </div>
            </div>

            {/* Scoring */}
            <div className="bg-card border border-border rounded-xl p-4 text-sm space-y-1">
              <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2">Scoring</p>
              {GUESS_POINTS.slice(0, MAX_GUESSES).map((pts, i) => (
                <div key={i} className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Guess {i + 1} &nbsp;({(INITIAL_CLIP_MS + i * EXTRA_CLIP_MS) / 1000}s clip)</span>
                  <span className="font-semibold text-primary">{pts} pts</span>
                </div>
              ))}
            </div>

            {/* Tips */}
            <div className="bg-primary/5 border border-primary/20 rounded-xl p-4 text-sm space-y-1">
              <p className="font-medium text-foreground text-sm mb-2">Tips</p>
              <p className="text-sm">• {MAX_GUESSES} guesses per song — each wrong one plays 5 more seconds</p>
              <p className="text-sm">• Hit Hint after a wrong guess for clues</p>
              <p className="text-sm">• Close spellings count, no need to be exact</p>
              {guessMode === "both" && <p className="text-sm">• "Both" mode gives partial credit for getting one right</p>}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

function PlayingScreen({
  game, track, isPlaying, clipTimer, clipDurationMs, guessAttempt,
  guess, onGuessChange, onSubmit, onPlayClip, onMoreTime, onNext, onGiveUp,
  result, revealed, wrongGuesses, hints, onShowHint, pointsEarned,
  voiceState, onToggleVoice, sdkReady, playerError, guessMode, onLogout,
}: {
  game: GameState; track: SpotifyTrack; isPlaying: boolean; clipTimer: number;
  clipDurationMs: number; guessAttempt: number;
  guess: string; onGuessChange: (v: string) => void;
  onSubmit: () => void; onPlayClip: () => void; onMoreTime: () => void;
  onNext: () => void; onGiveUp: () => void;
  result: GuessResult; revealed: boolean;
  wrongGuesses: string[]; hints: string[]; onShowHint: () => void;
  pointsEarned: number;
  voiceState: string; onToggleVoice: () => void; sdkReady: boolean;
  playerError: string | null; guessMode: GuessMode; onLogout: () => void;
}) {
  const roundNum = game.currentIndex + 1;
  const progress = clipDurationMs > 0 ? (clipTimer / (clipDurationMs / 1000)) * 100 : 0;
  const attemptsLeft = MAX_GUESSES - guessAttempt;
  const albumArt = getAlbumArt(track);

  // Determine feedback message
  const feedbackMsg = (() => {
    if (result === "correct") return `That's it! +${pointsEarned} pts 🎉`;
    if (result === "partial") return `Close! You got part of it — +${pointsEarned} pts`;
    if (result === "wrong" && revealed) return `The answer was coming up… better luck next time!`;
    return null;
  })();

  const feedbackColor = result === "correct"
    ? "bg-green-500/10 border-green-500/30 text-green-400"
    : result === "partial"
    ? "bg-amber-500/10 border-amber-500/30 text-amber-400"
    : "bg-muted/50 border-border text-muted-foreground";

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-5 py-3 border-b border-border">
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="font-mono text-xs">{roundNum}/{game.totalRounds}</Badge>
          {game.streak >= 2 && (
            <Badge className="bg-orange-500/20 text-orange-400 border-orange-500/30 text-xs">
              <Zap className="w-3 h-3 mr-1" />{game.streak}x
            </Badge>
          )}
          <Badge variant="outline" className="text-xs text-muted-foreground hidden sm:flex">{GUESS_MODE_LABELS[guessMode]}</Badge>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono font-bold flex items-center gap-1"><Trophy className="w-4 h-4 text-primary" />{game.score}</span>
          <button onClick={onLogout} className="text-muted-foreground hover:text-foreground"><LogOut className="w-4 h-4" /></button>
        </div>
      </header>

      {/* 3-column game layout */}
      <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-0 divide-y md:divide-y-0 md:divide-x divide-border overflow-hidden">

        {/* Column 1 — Guessing matrix (attempts) */}
        <div className="flex flex-col p-5 space-y-3">
          <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Your guesses</p>

          {/* Attempt bubbles */}
          <div className="space-y-2 flex-1">
            {Array.from({ length: MAX_GUESSES }).map((_, i) => {
              const pastGuess = wrongGuesses[i];
              const isCurrent = i === guessAttempt && result === null;
              const isEmpty = i > guessAttempt || (i === guessAttempt && result === null && !pastGuess);
              return (
                <div
                  key={i}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-all ${
                    pastGuess
                      ? "bg-red-500/5 border-red-500/20 text-muted-foreground"
                      : isCurrent
                      ? "bg-primary/5 border-primary/30 text-foreground"
                      : "bg-muted/20 border-border/30 text-muted-foreground/40"
                  }`}
                >
                  <span className="text-sm font-mono w-5 shrink-0 text-muted-foreground">{i + 1}</span>
                  {pastGuess ? (
                    <>
                      <XCircle className="w-3 h-3 shrink-0 text-red-400" />
                      <span className="truncate italic">{pastGuess}</span>
                    </>
                  ) : isCurrent ? (
                    <span className="text-sm text-primary animate-pulse">← your turn</span>
                  ) : (
                    <span className="text-sm opacity-40">—</span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Hints list — all revealed hints shown stacked */}
          {hints.length > 0 && (
            <div className="space-y-1.5">
              {hints.map((h, i) => (
                <div key={i} className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 text-sm text-amber-300">
                  <span className="text-amber-500 font-bold mr-2">#{i + 1}</span>{h}
                </div>
              ))}
            </div>
          )}

          {/* Result feedback */}
          {result !== null && feedbackMsg && (
            <div className={`flex items-center gap-2 p-3 rounded-xl border text-sm animate-in fade-in duration-300 ${feedbackColor}`}>
              {result === "correct" && <CheckCircle className="w-4 h-4 shrink-0" />}
              {result === "partial" && <Star className="w-4 h-4 shrink-0" />}
              {result === "wrong" && <span className="text-lg">😅</span>}
              <p className="font-medium">{feedbackMsg}</p>
            </div>
          )}
        </div>

        {/* Column 2 — Album art + playback */}
        <div className="flex flex-col items-center justify-between p-5 space-y-4">
          <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider self-start">Now playing</p>

          {/* Album art — hidden while playing, revealed when round done */}
          <div className={`transition-all duration-700 ${revealed ? "opacity-100 scale-100" : "opacity-0 scale-75 pointer-events-none"}`}>
            <div className="w-48 h-48 mx-auto rounded-2xl shadow-2xl overflow-hidden">
              {albumArt ? (
                <img src={albumArt} alt="Album" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full bg-card flex items-center justify-center"><Music className="w-16 h-16 text-muted-foreground" /></div>
              )}
            </div>
            <div className="text-center space-y-1 mt-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
              <p className="font-bold text-xl">{track.name}</p>
              <p className="text-muted-foreground">{track.artists.map(a => a.name).join(", ")}</p>
              <p className="text-sm text-muted-foreground">{track.album.name}</p>
            </div>
          </div>

          {/* Placeholder when not yet revealed */}
          {!revealed && (
            <div className="w-48 h-48 mx-auto rounded-2xl bg-card border border-border flex items-center justify-center">
              <Music className="w-16 h-16 text-muted-foreground/30" />
            </div>
          )}

          {/* Clip timer */}
          {isPlaying && (
            <div className="w-full space-y-1">
              <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${progress}%` }} />
              </div>
              <div className="flex justify-between text-sm text-muted-foreground font-mono">
                <span className="flex items-center gap-1"><Volume2 className="w-3 h-3 animate-pulse" /> Playing…</span>
                <span>{clipTimer.toFixed(1)}s</span>
              </div>
            </div>
          )}

          {/* Play button */}
          {result === null && (
            <Button
              data-testid="button-play-clip"
              onClick={onPlayClip}
              disabled={!sdkReady || isPlaying || !!playerError}
              className="w-full h-14 text-base font-semibold"
            >
              {isPlaying
                ? <><Volume2 className="w-5 h-5 mr-2 animate-pulse" />Playing…</>
                : <><Play className="w-5 h-5 mr-2" />Play {clipDurationMs / 1000}s clip</>}
            </Button>
          )}

          {/* Next button */}
          {result !== null && (
            <Button data-testid="button-next" onClick={onNext} className="w-full h-12 text-base">
              {game.currentIndex + 1 >= game.totalRounds ? "See Results" : <>Next Song <SkipForward className="w-4 h-4 ml-1" /></>}
            </Button>
          )}

          {playerError && <p className="text-xs text-destructive text-center">{playerError}</p>}
        </div>

        {/* Column 3 — Text input + controls */}
        <div className="flex flex-col p-5 space-y-4">
          <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            {result === null ? `Guess ${guessAttempt + 1} of ${MAX_GUESSES}` : "Round complete"}
          </p>

          {result === null ? (
            <>
              {/* Attempts left indicator */}
              <div className="flex gap-1">
                {Array.from({ length: MAX_GUESSES }).map((_, i) => (
                  <div key={i} className={`h-1.5 flex-1 rounded-full transition-all ${i < guessAttempt ? "bg-red-400/60" : i === guessAttempt ? "bg-primary" : "bg-muted"}`} />
                ))}
              </div>

              {/* Input */}
              <div className="space-y-2">
                <div className="flex gap-2">
                  <Input
                    data-testid="input-guess"
                    placeholder={`Guess the ${GUESS_MODE_LABELS[guessMode].toLowerCase()}…`}
                    value={guess}
                    onChange={e => onGuessChange(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && guess.trim() && onSubmit()}
                    className="flex-1 h-12 text-base border-2 border-yellow-400 focus:border-yellow-300 focus:ring-yellow-400/30 placeholder:text-muted-foreground/60"
                    autoFocus
                  />
                  <Button
                    data-testid="button-voice"
                    variant={voiceState === "listening" ? "destructive" : "outline"}
                    size="icon" className="h-12 w-12 shrink-0"
                    onClick={onToggleVoice}
                    title="Voice input"
                  >
                    {voiceState === "listening" ? <MicOff className="w-5 h-5 animate-pulse" /> : <Mic className="w-5 h-5" />}
                  </Button>
                </div>
                {voiceState === "listening" && <p className="text-sm text-primary text-center animate-pulse">Listening… say your answer</p>}

                <Button data-testid="button-submit" onClick={onSubmit} disabled={!guess.trim()} className="w-full h-11">
                  Submit Guess
                </Button>
              </div>

              {/* Action buttons */}
              <div className="flex gap-2">
                {guessAttempt > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 text-amber-400 border-amber-500/30 hover:bg-amber-500/10"
                    onClick={onShowHint}
                  >
                    <Lightbulb className="w-4 h-4 mr-1" />Hint
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="flex-1 text-muted-foreground hover:text-destructive"
                  onClick={onGiveUp}
                >
                  <Flag className="w-4 h-4 mr-1" />Give Up
                </Button>
              </div>

              {/* Mode reminder */}
              <div className="bg-card border border-border rounded-lg p-3 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">Mode: </span>{GUESS_MODE_LABELS[guessMode]}
                {guessMode === "both" && <span className="block mt-1 opacity-70">Tip: type both "Song — Artist" or just the song for partial credit</span>}
                {guessMode === "either" && <span className="block mt-1 opacity-70">Tip: just the song title or artist name both work</span>}
              </div>
            </>
          ) : (
            /* Round complete summary */
            <div className="space-y-3">
              <div className={`p-4 rounded-xl border ${feedbackColor}`}>
                <div className="flex items-center gap-2 mb-2">
                  {result === "correct" && <CheckCircle className="w-5 h-5" />}
                  {result === "partial" && <Star className="w-5 h-5" />}
                  {result === "wrong" && <span className="text-xl">😅</span>}
                  <span className="font-semibold">{feedbackMsg}</span>
                </div>
                {result !== "wrong" && (
                  <p className="text-sm opacity-80">Guessed on attempt {guessAttempt + 1}</p>
                )}
              </div>

              <div className="bg-card border border-border rounded-xl p-4 space-y-2 text-sm">
                <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">The answer</p>
                <p className="font-bold text-foreground">{track.name}</p>
                <p className="text-muted-foreground">{track.artists.map(a => a.name).join(", ")}</p>
                <p className="text-sm text-muted-foreground">{track.album.name}</p>
              </div>

              <div className="grid grid-cols-3 gap-2 text-center text-sm">
                <div className="bg-card border border-border rounded-lg p-2">
                  <p className="font-bold text-lg text-foreground">{game.score}</p>
                  <p className="text-muted-foreground">Score</p>
                </div>
                <div className="bg-card border border-border rounded-lg p-2">
                  <p className="font-bold text-lg text-foreground">{game.streak}</p>
                  <p className="text-muted-foreground">Streak</p>
                </div>
                <div className="bg-card border border-border rounded-lg p-2">
                  <p className="font-bold text-lg text-foreground">{game.roundsWon}/{game.currentIndex + 1}</p>
                  <p className="text-muted-foreground">Correct</p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function GameOverScreen({ game, user, onPlayAgain, onLogout }: {
  game: GameState; user: SpotifyUser; onPlayAgain: () => void; onLogout: () => void;
}) {
  const accuracy = Math.round((game.roundsWon / game.totalRounds) * 100);
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6">
      <div className="max-w-sm w-full space-y-8 text-center">
        <div className="space-y-3">
          <div className="w-24 h-24 rounded-3xl bg-primary/10 flex items-center justify-center mx-auto">
            <Trophy className="w-12 h-12 text-primary" />
          </div>
          <div>
            <h2 className="text-3xl font-bold">{game.score} pts</h2>
            <p className="text-muted-foreground">Nice work, {user.display_name.split(" ")[0]}!</p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Correct", value: `${game.roundsWon}/${game.totalRounds}` },
            { label: "Accuracy", value: `${accuracy}%` },
            { label: "Best Streak", value: `${game.bestStreak}x` },
          ].map(({ label, value }) => (
            <div key={label} className="bg-card border border-border rounded-xl p-4 space-y-1">
              <p className="text-xl font-bold">{value}</p>
              <p className="text-sm text-muted-foreground">{label}</p>
            </div>
          ))}
        </div>
        <div className="space-y-3">
          <Button data-testid="button-play-again" className="w-full h-12 text-base font-semibold" onClick={onPlayAgain}>Play Again</Button>
          <Button variant="ghost" size="sm" className="w-full text-muted-foreground" onClick={onLogout}>
            <LogOut className="w-3 h-3 mr-1" /> Disconnect
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Error Boundary ───────────────────────────────────────────────────────────
class ErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null };
  static getDerivedStateFromError(e: Error) { return { error: e.message + "\n" + e.stack }; }
  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-background flex items-center justify-center p-6">
          <div className="max-w-lg w-full bg-card border border-destructive/30 rounded-xl p-6 space-y-3">
            <p className="font-bold text-destructive">Something crashed — please copy this and share it:</p>
            <pre className="text-xs text-muted-foreground whitespace-pre-wrap break-all bg-muted p-3 rounded overflow-auto max-h-64">{this.state.error}</pre>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export { ErrorBoundary };
