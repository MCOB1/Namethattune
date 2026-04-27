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
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────
type GameView = "setup" | "source-select" | "playing" | "game-over";
type GuessMode = "song" | "artist" | "either" | "both";

interface GameState {
  tracks: SpotifyTrack[];
  currentIndex: number;
  score: number;
  streak: number;
  bestStreak: number;
  roundsWon: number;
  totalRounds: number;
}

// Clip steps in ms: 3s, 6s, 9s, 30s (full preview)
const CLIP_STEPS = [3000, 6000, 9000, 30000];
const ROUNDS_PER_GAME = 10;

// Points awarded based on clip step used (fewer seconds = more points)
const STEP_POINTS = [5, 3, 2, 1];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function normalize(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

function titleMatch(guess: string, track: SpotifyTrack): boolean {
  const g = normalize(guess);
  const t = normalize(track.name);
  return g === t || (t.includes(g) && g.length >= 3);
}

function artistMatch(guess: string, track: SpotifyTrack): boolean {
  const g = normalize(guess);
  return track.artists.some((a) => {
    const n = normalize(a.name);
    return g === n || (n.includes(g) && g.length >= 3);
  });
}

function checkGuess(guess: string, track: SpotifyTrack, mode: GuessMode): boolean {
  switch (mode) {
    case "song":   return titleMatch(guess, track);
    case "artist": return artistMatch(guess, track);
    case "either": return titleMatch(guess, track) || artistMatch(guess, track);
    case "both":   return titleMatch(guess, track) && artistMatch(guess, track);
  }
}

function getAlbumArt(track: SpotifyTrack): string {
  return track.album.images?.[0]?.url || "";
}

const GUESS_MODE_LABELS: Record<GuessMode, string> = {
  song:   "Song title",
  artist: "Artist name",
  either: "Song or Artist",
  both:   "Song AND Artist",
};

// ─── Main component ───────────────────────────────────────────────────────────
export default function Game() {
  const { toast } = useToast();

  // Auth
  const [tokens, setTokens] = useState<SpotifyTokens | null>(null);
  const [user, setUser] = useState<SpotifyUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [clientIdMissing, setClientIdMissing] = useState(false);

  // Source selection tabs: "mine" | "spotify" | category id
  const [sourceTab, setSourceTab] = useState<"mine" | "spotify">("mine");
  const [myPlaylists, setMyPlaylists] = useState<SpotifyPlaylist[]>([]);
  const [categories, setCategories] = useState<SpotifyCategory[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<SpotifyCategory | null>(null);
  const [categoryPlaylists, setCategoryPlaylists] = useState<SpotifyPlaylist[]>([]);
  const [featuredPlaylists, setFeaturedPlaylists] = useState<SpotifyPlaylist[]>([]);
  const [loadingPlaylists, setLoadingPlaylists] = useState(false);
  const [selectedSource, setSelectedSource] = useState<"liked" | string>("liked");

  // Guess mode
  const [guessMode, setGuessMode] = useState<GuessMode>("either");

  // Game
  const [view, setView] = useState<GameView>("setup");
  const [game, setGame] = useState<GameState | null>(null);
  const [guess, setGuess] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [result, setResult] = useState<"correct" | "wrong" | null>(null);
  const [loadingTracks, setLoadingTracks] = useState(false);
  const [sdkReady, setSdkReady] = useState(false);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);

  // Clip progression
  const [clipStepIndex, setClipStepIndex] = useState(0); // 0=3s, 1=6s, 2=9s, 3=30s
  const [clipTimer, setClipTimer] = useState(CLIP_STEPS[0] / 1000);

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
      setCategories(cats);
      setFeaturedPlaylists(featured);
    } catch {}
    setLoadingPlaylists(false);
  }, [getValidToken]);

  // ─── Load category playlists ─────────────────────────────────────
  const loadCategoryPlaylists = useCallback(async (cat: SpotifyCategory) => {
    const token = await getValidToken();
    if (!token) return;
    setSelectedCategory(cat);
    setCategoryPlaylists([]);
    setLoadingPlaylists(true);
    try { setCategoryPlaylists(await getCategoryPlaylists(cat.id, token)); } catch {}
    setLoadingPlaylists(false);
  }, [getValidToken]);

  useEffect(() => {
    if (!tokens || view !== "source-select") return;
    if (sourceTab === "mine") loadMyPlaylists();
    else loadCategories();
  }, [tokens, view, sourceTab]);

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
      setGuess(""); setResult(null); setRevealed(false);
      setClipStepIndex(0); setClipTimer(CLIP_STEPS[0] / 1000);
      setView("playing");
    } catch (e) {
      toast({ title: "Failed to load tracks", description: String(e), variant: "destructive" });
    }
    setLoadingTracks(false);
  }, [getValidToken, selectedSource, toast]);

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
  const playClip = useCallback(async (stepIndex: number, fromStart: boolean) => {
    if (!game || !deviceId || !sdkReady || isPlaying) return;
    const track = game.tracks[game.currentIndex];
    const token = await getValidToken();
    if (!token) return;

    const durationMs = CLIP_STEPS[stepIndex];
    // When extending, start from where the previous clip ended
    const positionMs = fromStart ? 0 : CLIP_STEPS[stepIndex - 1];

    setIsPlaying(true);
    setClipTimer(durationMs / 1000);

    try {
      if (fromStart) {
        // New song — start from beginning
        await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ uris: [track.uri], position_ms: 0 }),
        });
      } else {
        // Seek to where the previous clip ended and continue
        await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ uris: [track.uri], position_ms: positionMs }),
        });
      }

      const segmentMs = durationMs - positionMs;
      let remaining = segmentMs / 1000;
      setClipTimer(remaining);

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
  }, [game, deviceId, sdkReady, isPlaying, getValidToken, clearTimers, pausePlayback, toast]);

  // ─── More time ───────────────────────────────────────────────────
  const playMoreTime = useCallback(async () => {
    clearTimers();
    await pausePlayback();
    const nextStep = clipStepIndex + 1;
    setClipStepIndex(nextStep);
    // Small delay to let pause settle
    setTimeout(() => playClip(nextStep, false), 400);
  }, [clipStepIndex, clearTimers, pausePlayback, playClip]);

  // ─── Submit guess ────────────────────────────────────────────────
  const submitGuess = useCallback((guessText: string) => {
    if (!game || result !== null || !guessText.trim()) return;
    const track = game.tracks[game.currentIndex];
    const correct = checkGuess(guessText, track, guessMode);

    clearTimers();
    pausePlayback();

    const pointsEarned = correct ? STEP_POINTS[clipStepIndex] : 0;
    const newStreak = correct ? game.streak + 1 : 0;
    const newBestStreak = Math.max(game.bestStreak, newStreak);

    setGame(prev => prev ? {
      ...prev,
      score: prev.score + pointsEarned,
      streak: newStreak,
      bestStreak: newBestStreak,
      roundsWon: correct ? prev.roundsWon + 1 : prev.roundsWon,
    } : prev);

    setResult(correct ? "correct" : "wrong");
    setRevealed(true);
  }, [game, result, guessMode, clipStepIndex, clearTimers, pausePlayback]);

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
    setGuess(""); setResult(null); setRevealed(false);
    setIsPlaying(false); setClipStepIndex(0); setClipTimer(CLIP_STEPS[0] / 1000);
  }, [game, user]);

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
    if (!user) return <Spinner />;
    return (
      <SourceSelectScreen
        user={user}
        sourceTab={sourceTab}
        onTabChange={(tab) => { setSourceTab(tab); setSelectedCategory(null); }}
        myPlaylists={myPlaylists}
        categories={categories}
        selectedCategory={selectedCategory}
        categoryPlaylists={categoryPlaylists}
        featuredPlaylists={featuredPlaylists}
        onSelectCategory={loadCategoryPlaylists}
        loading={loadingPlaylists}
        selectedSource={selectedSource}
        onSelect={setSelectedSource}
        guessMode={guessMode}
        onGuessModeChange={setGuessMode}
        onStart={startGame}
        onBack={() => setView("setup")}
        loadingTracks={loadingTracks}
        onLogout={logout}
        onClearCategory={() => setSelectedCategory(null)}
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
        isPlaying={isPlaying} clipTimer={clipTimer} clipStepIndex={clipStepIndex}
        guess={guess} onGuessChange={setGuess}
        onSubmit={() => submitGuess(guess)}
        onPlayClip={() => playClip(0, true)}
        onMoreTime={playMoreTime}
        onNext={nextRound}
        result={result} revealed={revealed}
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
            <p className="text-muted-foreground mt-1">Identify songs from just 3 seconds</p>
          </div>
        </div>
        <div className="space-y-3">
          {[
            { icon: Headphones, text: "Requires Spotify Premium" },
            { icon: Mic, text: "Guess by voice or typing" },
            { icon: Clock, text: "Progressive hints: 3s → 6s → 9s" },
          ].map(({ icon: Icon, text }, i) => (
            <div key={i} className="flex items-center gap-3 bg-card border border-border rounded-lg p-3 text-sm text-muted-foreground">
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
            { icon: Play, text: "Hit Play — hear the first 3 seconds" },
            { icon: Clock, text: "Need more? Add 3 more seconds each time" },
            { icon: Mic, text: "Guess by voice or typing — song, artist, or both" },
            { icon: Trophy, text: "Score more points for faster guesses" },
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
      className={`w-full flex items-center gap-4 p-4 rounded-xl border text-left transition-all ${selected ? "border-primary bg-primary/10" : "border-border bg-card hover:border-primary/50"}`}
    >
      <div className="w-12 h-12 rounded-lg bg-muted flex items-center justify-center shrink-0 overflow-hidden">
        {playlist.images?.[0]?.url ? (
          <img src={playlist.images[0].url} alt={playlist.name} className="w-full h-full object-cover" />
        ) : (
          <ListMusic className="w-6 h-6 text-muted-foreground" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-foreground truncate">{playlist.name}</p>
        <p className="text-xs text-muted-foreground">{playlist.tracks?.total ?? "?"} tracks</p>
      </div>
      {selected && <CheckCircle className="w-5 h-5 text-primary shrink-0" />}
    </button>
  );
}

function SourceSelectScreen({
  user, sourceTab, onTabChange, myPlaylists, categories, selectedCategory,
  categoryPlaylists, featuredPlaylists, onSelectCategory, loading, selectedSource,
  onSelect, guessMode, onGuessModeChange, onStart, onBack, loadingTracks, onLogout,
}: {
  user: SpotifyUser; sourceTab: "mine" | "spotify";
  onTabChange: (t: "mine" | "spotify") => void;
  myPlaylists: SpotifyPlaylist[]; categories: SpotifyCategory[];
  selectedCategory: SpotifyCategory | null; categoryPlaylists: SpotifyPlaylist[];
  featuredPlaylists: SpotifyPlaylist[]; onSelectCategory: (c: SpotifyCategory) => void;
  loading: boolean; selectedSource: string; onSelect: (s: string) => void;
  guessMode: GuessMode; onGuessModeChange: (m: GuessMode) => void;
  onStart: () => void; onBack: () => void; loadingTracks: boolean; onLogout: () => void;
  onClearCategory: () => void;
}) {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="flex items-center justify-between px-5 py-4 border-b border-border">
        <button onClick={onBack} className="text-muted-foreground hover:text-foreground text-sm">← Back</button>
        <span className="font-semibold text-sm">Choose your music</span>
        <button onClick={onLogout} className="text-muted-foreground hover:text-foreground"><LogOut className="w-4 h-4" /></button>
      </header>

      {/* Guess mode picker */}
      <div className="px-5 pt-4 pb-2 space-y-2">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">What are you guessing?</p>
        <div className="grid grid-cols-2 gap-2">
          {(["song", "artist", "either", "both"] as GuessMode[]).map((m) => (
            <button
              key={m}
              onClick={() => onGuessModeChange(m)}
              className={`p-3 rounded-xl border text-sm font-medium transition-all text-left ${guessMode === m ? "border-primary bg-primary/10 text-primary" : "border-border bg-card text-muted-foreground hover:border-primary/50"}`}
            >
              {GUESS_MODE_LABELS[m]}
            </button>
          ))}
        </div>
      </div>

      {/* Source tabs */}
      <div className="px-5 pt-3 pb-2">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Music source</p>
        <div className="flex gap-2">
          {([["mine", "My Music"], ["spotify", "Spotify Playlists"]] as const).map(([tab, label]) => (
            <button
              key={tab}
              onClick={() => onTabChange(tab)}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${sourceTab === tab ? "bg-primary text-primary-foreground" : "bg-card border border-border text-muted-foreground hover:border-primary/50"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Playlist list */}
      <div className="flex-1 overflow-y-auto px-5 pb-2 space-y-2">
        {loading ? (
          <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
        ) : sourceTab === "mine" ? (
          <>
            {/* Liked songs */}
            <button
              onClick={() => onSelect("liked")}
              className={`w-full flex items-center gap-4 p-4 rounded-xl border text-left transition-all ${selectedSource === "liked" ? "border-primary bg-primary/10" : "border-border bg-card hover:border-primary/50"}`}
            >
              <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center shrink-0">
                <Heart className="w-6 h-6 text-white" />
              </div>
              <div><p className="font-semibold text-foreground">Liked Songs</p><p className="text-xs text-muted-foreground">Your saved tracks</p></div>
              {selectedSource === "liked" && <CheckCircle className="w-5 h-5 text-primary ml-auto" />}
            </button>
            {myPlaylists.map(pl => <PlaylistButton key={pl.id} playlist={pl} selected={selectedSource === pl.id} onSelect={() => onSelect(pl.id)} />)}
          </>
        ) : (
          <>
            {/* Category browser */}
            {!selectedCategory ? (
              <>
                {featuredPlaylists.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider pt-1">Featured</p>
                    {featuredPlaylists.map(pl => <PlaylistButton key={pl.id} playlist={pl} selected={selectedSource === pl.id} onSelect={() => onSelect(pl.id)} />)}
                  </div>
                )}
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider pt-2">Browse by Genre</p>
                <div className="grid grid-cols-2 gap-2">
                  {categories.map(cat => (
                    <button
                      key={cat.id}
                      onClick={() => onSelectCategory(cat)}
                      className="relative h-20 rounded-xl overflow-hidden border border-border bg-card hover:border-primary/50 transition-all text-left"
                    >
                      {cat.icons?.[0]?.url && <img src={cat.icons[0].url} alt={cat.name} className="absolute inset-0 w-full h-full object-cover opacity-40" />}
                      <div className="absolute inset-0 p-3 flex items-end">
                        <span className="font-semibold text-sm text-foreground drop-shadow">{cat.name}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <button onClick={onClearCategory} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground py-1">
                  ← {selectedCategory.name}
                </button>
                {categoryPlaylists.map(pl => <PlaylistButton key={pl.id} playlist={pl} selected={selectedSource === pl.id} onSelect={() => onSelect(pl.id)} />)}
              </>
            )}
          </>
        )}
      </div>

      <div className="p-5 border-t border-border">
        <Button data-testid="button-start-game" className="w-full h-12 text-base font-semibold" onClick={onStart} disabled={loadingTracks}>
          {loadingTracks ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Loading tracks…</> : `Start Game (${ROUNDS_PER_GAME} rounds)`}
        </Button>
      </div>
    </div>
  );
}

function PlayingScreen({
  game, track, isPlaying, clipTimer, clipStepIndex, guess, onGuessChange,
  onSubmit, onPlayClip, onMoreTime, onNext, result, revealed,
  voiceState, onToggleVoice, sdkReady, playerError, guessMode, onLogout,
}: {
  game: GameState; track: SpotifyTrack; isPlaying: boolean; clipTimer: number;
  clipStepIndex: number; guess: string; onGuessChange: (v: string) => void;
  onSubmit: () => void; onPlayClip: () => void; onMoreTime: () => void;
  onNext: () => void; result: "correct" | "wrong" | null; revealed: boolean;
  voiceState: string; onToggleVoice: () => void; sdkReady: boolean;
  playerError: string | null; guessMode: GuessMode; onLogout: () => void;
}) {
  const roundNum = game.currentIndex + 1;
  const currentStepMs = CLIP_STEPS[clipStepIndex];
  const progress = (clipTimer / (currentStepMs / 1000)) * 100;
  const hasMoreTime = clipStepIndex < CLIP_STEPS.length - 1;
  const pointsAvailable = STEP_POINTS[clipStepIndex];

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="flex items-center justify-between px-5 py-3 border-b border-border">
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="font-mono text-xs">{roundNum}/{game.totalRounds}</Badge>
          {game.streak >= 2 && (
            <Badge className="bg-orange-500/20 text-orange-400 border-orange-500/30 text-xs">
              <Zap className="w-3 h-3 mr-1" />{game.streak}x
            </Badge>
          )}
          <Badge variant="outline" className="text-xs text-muted-foreground">{GUESS_MODE_LABELS[guessMode]}</Badge>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono font-bold flex items-center gap-1"><Trophy className="w-4 h-4 text-primary" />{game.score}</span>
          <button onClick={onLogout} className="text-muted-foreground hover:text-foreground"><LogOut className="w-4 h-4" /></button>
        </div>
      </header>

      <div className="flex-1 flex flex-col items-center justify-between p-6 max-w-md mx-auto w-full">
        {/* Album art */}
        <div className="w-full space-y-4">
          <div className={`w-48 h-48 mx-auto rounded-2xl shadow-2xl overflow-hidden transition-all duration-500 ${revealed ? "scale-100 opacity-100 blur-0" : "scale-90 opacity-25 blur-sm"}`}>
            {getAlbumArt(track) ? (
              <img src={getAlbumArt(track)} alt="Album" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full bg-card flex items-center justify-center"><Music className="w-16 h-16 text-muted-foreground" /></div>
            )}
          </div>
          {revealed && (
            <div className="text-center space-y-1 animate-in fade-in slide-in-from-bottom-2 duration-300">
              <p className="font-bold text-xl">{track.name}</p>
              <p className="text-muted-foreground">{track.artists.map(a => a.name).join(", ")}</p>
              <p className="text-xs text-muted-foreground/60">{track.album.name}</p>
            </div>
          )}
        </div>

        <div className="w-full space-y-3">
          {/* Clip steps indicator */}
          <div className="flex gap-1 justify-center">
            {CLIP_STEPS.map((s, i) => (
              <div key={i} className={`h-1 flex-1 rounded-full transition-all ${i < clipStepIndex ? "bg-primary" : i === clipStepIndex ? "bg-primary/50" : "bg-muted"}`} />
            ))}
          </div>

          {/* Timer bar */}
          {isPlaying && (
            <div className="space-y-1">
              <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${progress}%` }} />
              </div>
              <div className="flex justify-between text-xs text-muted-foreground font-mono">
                <span>Playing…</span><span>{clipTimer.toFixed(1)}s</span>
              </div>
            </div>
          )}

          {result === null ? (
            <>
              {/* Play button */}
              <Button
                data-testid="button-play-clip"
                onClick={onPlayClip}
                disabled={!sdkReady || isPlaying || !!playerError}
                className="w-full h-14 text-lg font-semibold"
              >
                {isPlaying ? <><Volume2 className="w-5 h-5 mr-2 animate-pulse" />Playing…</> : <><Play className="w-5 h-5 mr-2" />Play {CLIP_STEPS[clipStepIndex] / 1000}s Clip — {pointsAvailable} pts</>}
              </Button>

              {/* More time button */}
              {clipStepIndex > 0 && hasMoreTime && !isPlaying && (
                <Button variant="outline" className="w-full" onClick={onMoreTime} disabled={isPlaying}>
                  <Clock className="w-4 h-4 mr-2" />Another 3 seconds ({CLIP_STEPS[clipStepIndex + 1] / 1000}s total — {STEP_POINTS[clipStepIndex + 1]} pts)
                </Button>
              )}
              {clipStepIndex === 0 && !isPlaying && (
                <p className="text-xs text-center text-muted-foreground">After playing, you can request more time</p>
              )}
              {clipStepIndex > 0 && !isPlaying && !hasMoreTime && (
                <p className="text-xs text-center text-muted-foreground">Maximum clip reached</p>
              )}

              {playerError && <p className="text-xs text-destructive text-center">{playerError}</p>}

              {/* Guess input */}
              <div className="space-y-2">
                <div className="flex gap-2">
                  <Input
                    data-testid="input-guess"
                    placeholder={`Guess the ${GUESS_MODE_LABELS[guessMode].toLowerCase()}…`}
                    value={guess}
                    onChange={e => onGuessChange(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && guess.trim() && onSubmit()}
                    className="flex-1 h-12 text-base"
                  />
                  <Button
                    data-testid="button-voice"
                    variant={voiceState === "listening" ? "destructive" : "outline"}
                    size="icon" className="h-12 w-12 shrink-0"
                    onClick={onToggleVoice}
                  >
                    {voiceState === "listening" ? <MicOff className="w-5 h-5 animate-pulse" /> : <Mic className="w-5 h-5" />}
                  </Button>
                </div>
                {voiceState === "listening" && <p className="text-xs text-primary text-center animate-pulse">Listening… say your answer</p>}
                <Button data-testid="button-submit" onClick={onSubmit} disabled={!guess.trim()} className="w-full" variant="secondary">
                  Submit Guess
                </Button>
              </div>
            </>
          ) : (
            <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
              <div className={`flex items-center gap-3 p-4 rounded-xl border ${result === "correct" ? "bg-green-500/10 border-green-500/30 text-green-400" : "bg-destructive/10 border-destructive/30 text-destructive"}`}>
                {result === "correct" ? <CheckCircle className="w-5 h-5 shrink-0" /> : <XCircle className="w-5 h-5 shrink-0" />}
                <div>
                  <p className="font-semibold">{result === "correct" ? `Correct! +${STEP_POINTS[clipStepIndex]} pts` : "Not quite!"}</p>
                  {guess && <p className="text-xs opacity-70">You said: "{guess}"</p>}
                </div>
              </div>
              <Button data-testid="button-next" onClick={onNext} className="w-full h-12 text-base">
                {game.currentIndex + 1 >= game.totalRounds ? "See Results" : <>Next Song <SkipForward className="w-4 h-4 ml-1" /></>}
              </Button>
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
            <p className="text-muted-foreground">Game over, {user.display_name.split(" ")[0]}!</p>
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
              <p className="text-xs text-muted-foreground">{label}</p>
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
