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
  shuffleArray,
  SPOTIFY_CLIENT_ID,
  type SpotifyTokens,
  type SpotifyUser,
  type SpotifyPlaylist,
  type SpotifyTrack,
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
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────
type GameView = "setup" | "source-select" | "playing" | "result" | "game-over";

interface GameState {
  tracks: SpotifyTrack[];
  currentIndex: number;
  score: number;
  streak: number;
  bestStreak: number;
  roundsWon: number;
  totalRounds: number;
  clipDuration: number; // ms to play
}

const CLIP_DURATION_MS = 3000; // 3 seconds
const ROUNDS_PER_GAME = 10;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function normalizeGuess(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isCorrectGuess(guess: string, track: SpotifyTrack): boolean {
  const normGuess = normalizeGuess(guess);
  const normTitle = normalizeGuess(track.name);
  // Exact match OR title contains guess (for partial matches)
  if (normGuess === normTitle) return true;
  if (normTitle.includes(normGuess) && normGuess.length >= 3) return true;
  // Also accept artist match alone for tough cases
  const artistNames = track.artists.map((a) => normalizeGuess(a.name));
  if (artistNames.some((a) => normGuess === a || a.includes(normGuess))) return false; // artist only doesn't count
  return false;
}

function getAlbumArt(track: SpotifyTrack): string {
  return track.album.images?.[0]?.url || "";
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function Game() {
  const { toast } = useToast();

  // Auth state
  const [tokens, setTokens] = useState<SpotifyTokens | null>(null);
  const [user, setUser] = useState<SpotifyUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [clientIdMissing, setClientIdMissing] = useState(false);

  // Source selection
  const [playlists, setPlaylists] = useState<SpotifyPlaylist[]>([]);
  const [loadingPlaylists, setLoadingPlaylists] = useState(false);
  const [selectedSource, setSelectedSource] = useState<"liked" | string>("liked");

  // Game state
  const [view, setView] = useState<GameView>("setup");
  const [game, setGame] = useState<GameState | null>(null);
  const [guess, setGuess] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [result, setResult] = useState<"correct" | "wrong" | null>(null);
  const [loadingTracks, setLoadingTracks] = useState(false);
  const [sdkReady, setSdkReady] = useState(false);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [clipTimer, setClipTimer] = useState<number>(CLIP_DURATION_MS / 1000);
  const [revealed, setRevealed] = useState(false);

  const playerRef = useRef<any>(null);
  const clipTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tokensRef = useRef<SpotifyTokens | null>(null);

  // Keep tokensRef in sync
  useEffect(() => {
    tokensRef.current = tokens;
  }, [tokens]);

  // ─── Token helpers ──────────────────────────────────────────────
  const getValidToken = useCallback(async (): Promise<string | null> => {
    const t = tokensRef.current;
    if (!t) return null;
    if (Date.now() < t.expires_at - 60000) return t.access_token;
    // refresh
    const refreshed = await refreshToken(t.refresh_token);
    if (!refreshed) return null;
    setTokens(refreshed);
    return refreshed.access_token;
  }, []);

  // ─── Handle OAuth callback ──────────────────────────────────────
  useEffect(() => {
    if (!SPOTIFY_CLIENT_ID) {
      setClientIdMissing(true);
      setAuthLoading(false);
      return;
    }

    // Check for ?code= in URL (Spotify redirected back after login)
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");

    if (code && state) {
      // Clean the URL immediately so it doesn't re-trigger on refresh
      window.history.replaceState({}, "", window.location.pathname);
      setAuthLoading(true);
      exchangeCodeForToken(code, state).then(async (t) => {
        if (!t) {
          toast({ title: "Auth failed", description: "Could not exchange code for token.", variant: "destructive" });
          setAuthLoading(false);
          return;
        }
        setTokens(t);
        try {
          const u = await getCurrentUser(t.access_token);
          setUser(u);
        } catch {}
        setAuthLoading(false);
      });
    } else {
      setAuthLoading(false);
    }
  }, []);

  // (tokens kept in React state only — sessionStorage blocked in sandboxed iframe)

  // ─── Load Spotify Web Playback SDK ──────────────────────────────
  useEffect(() => {
    if (!tokens) return;

    // Load SDK script
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
        getOAuthToken: async (cb: (token: string) => void) => {
          const t = await getValidToken();
          if (t) cb(t);
        },
        volume: 0.8,
      });

      player.addListener("ready", ({ device_id }: { device_id: string }) => {
        setDeviceId(device_id);
        setSdkReady(true);
        setPlayerError(null);
      });

      player.addListener("not_ready", () => {
        setSdkReady(false);
        setPlayerError("Player went offline. Refresh the page.");
      });

      player.addListener("initialization_error", ({ message }: any) => {
        setPlayerError(`Init error: ${message}`);
      });

      player.addListener("authentication_error", ({ message }: any) => {
        setPlayerError(`Auth error: ${message}. Make sure you have Spotify Premium.`);
      });

      player.addListener("account_error", ({ message }: any) => {
        setPlayerError(`Account error: ${message}. Spotify Premium is required for web playback.`);
      });

      player.connect();
      playerRef.current = player;
    };

    return () => {
      if (playerRef.current) {
        playerRef.current.disconnect();
      }
    };
  }, [tokens, getValidToken]);

  // ─── Load playlists ─────────────────────────────────────────────
  const loadPlaylists = useCallback(async () => {
    const token = await getValidToken();
    if (!token) return;
    setLoadingPlaylists(true);
    try {
      const pl = await getUserPlaylists(token);
      setPlaylists(pl);
    } catch (e) {
      toast({ title: "Could not load playlists", variant: "destructive" });
    }
    setLoadingPlaylists(false);
  }, [getValidToken, toast]);

  useEffect(() => {
    if (tokens && view === "source-select") {
      loadPlaylists();
    }
  }, [tokens, view, loadPlaylists]);

  // ─── Start game ─────────────────────────────────────────────────
  const startGame = useCallback(async () => {
    const token = await getValidToken();
    if (!token) return;
    setLoadingTracks(true);

    try {
      let tracks: SpotifyTrack[];
      if (selectedSource === "liked") {
        tracks = await getLikedTracks(token);
      } else {
        tracks = await getPlaylistTracks(selectedSource, token);
      }

      if (tracks.length < 5) {
        toast({
          title: "Not enough tracks",
          description: "Need at least 5 tracks. Try a different playlist.",
          variant: "destructive",
        });
        setLoadingTracks(false);
        return;
      }

      const shuffled = shuffleArray(tracks).slice(0, ROUNDS_PER_GAME);
      setGame({
        tracks: shuffled,
        currentIndex: 0,
        score: 0,
        streak: 0,
        bestStreak: 0,
        roundsWon: 0,
        totalRounds: shuffled.length,
        clipDuration: CLIP_DURATION_MS,
      });
      setGuess("");
      setResult(null);
      setRevealed(false);
      setView("playing");
    } catch (e) {
      toast({ title: "Failed to load tracks", description: String(e), variant: "destructive" });
    }
    setLoadingTracks(false);
  }, [getValidToken, selectedSource, toast]);

  // ─── Play clip ──────────────────────────────────────────────────
  const playClip = useCallback(async () => {
    if (!game || !deviceId || !sdkReady || isPlaying) return;

    const track = game.tracks[game.currentIndex];
    const token = await getValidToken();
    if (!token) return;

    setIsPlaying(true);
    setClipTimer(CLIP_DURATION_MS / 1000);

    try {
      await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          uris: [track.uri],
          position_ms: 0,
        }),
      });

      // Countdown timer
      let remaining = CLIP_DURATION_MS / 1000;
      clipTimerRef.current = setInterval(() => {
        remaining -= 0.1;
        setClipTimer(Math.max(0, remaining));
      }, 100);

      // Stop after clip duration
      stopTimerRef.current = setTimeout(async () => {
        if (clipTimerRef.current) clearInterval(clipTimerRef.current);
        const t = await getValidToken();
        if (t) {
          await fetch(`https://api.spotify.com/v1/me/player/pause?device_id=${deviceId}`, {
            method: "PUT",
            headers: { Authorization: `Bearer ${t}` },
          });
        }
        setIsPlaying(false);
        setClipTimer(0);
      }, CLIP_DURATION_MS);
    } catch (e) {
      setIsPlaying(false);
      toast({ title: "Playback failed", description: "Check your Spotify connection.", variant: "destructive" });
    }
  }, [game, deviceId, sdkReady, isPlaying, getValidToken, toast]);

  // ─── Submit guess ────────────────────────────────────────────────
  const submitGuess = useCallback((guessText: string) => {
    if (!game || result !== null) return;
    const track = game.tracks[game.currentIndex];
    const correct = isCorrectGuess(guessText, track);

    // Stop playback
    if (clipTimerRef.current) clearInterval(clipTimerRef.current);
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current);

    getValidToken().then((t) => {
      if (t && deviceId) {
        fetch(`https://api.spotify.com/v1/me/player/pause?device_id=${deviceId}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${t}` },
        }).catch(() => {});
      }
    });
    setIsPlaying(false);

    const pointsEarned = correct ? Math.max(1, Math.ceil(clipTimer)) : 0;
    const newStreak = correct ? game.streak + 1 : 0;
    const newBestStreak = Math.max(game.bestStreak, newStreak);

    setGame((prev) =>
      prev
        ? {
            ...prev,
            score: prev.score + pointsEarned,
            streak: newStreak,
            bestStreak: newBestStreak,
            roundsWon: correct ? prev.roundsWon + 1 : prev.roundsWon,
          }
        : prev
    );
    setResult(correct ? "correct" : "wrong");
    setRevealed(true);
  }, [game, result, clipTimer, deviceId, getValidToken]);

  // ─── Next round ───────────────────────────────────────────────────
  const nextRound = useCallback(async () => {
    if (!game) return;
    const nextIndex = game.currentIndex + 1;

    if (nextIndex >= game.totalRounds) {
      // Game over — save score
      if (user) {
        try {
          await apiRequest("POST", "/api/scores", {
            spotifyUserId: user.id,
            displayName: user.display_name,
            score: game.score,
            streak: game.streak,
            bestStreak: game.bestStreak,
            gamesPlayed: 1,
            roundsWon: game.roundsWon,
          });
        } catch {}
      }
      setView("game-over");
      return;
    }

    setGame((prev) => (prev ? { ...prev, currentIndex: nextIndex } : prev));
    setGuess("");
    setResult(null);
    setRevealed(false);
    setIsPlaying(false);
    setClipTimer(CLIP_DURATION_MS / 1000);
  }, [game, user]);

  // ─── Voice input ─────────────────────────────────────────────────
  const { state: voiceState, toggle: toggleVoice } = useVoiceInput({
    onResult: (transcript) => {
      setGuess(transcript);
      submitGuess(transcript);
    },
    onError: (err) => {
      toast({ title: "Voice error", description: err, variant: "destructive" });
    },
  });

  // ─── Logout ───────────────────────────────────────────────────────
  const logout = () => {
    setTokens(null);
    setUser(null);
    setView("setup");
    if (playerRef.current) playerRef.current.disconnect();
  };

  // ─────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────

  // Client ID missing
  if (clientIdMissing) {
    return <SetupRequired />;
  }

  // Loading auth
  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  // Not authenticated
  if (!tokens || !user) {
    return <LoginScreen onLogin={initiateSpotifyLogin} />;
  }

  // Source select
  if (view === "source-select") {
    if (!user) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      );
    }
    return (
      <SourceSelectScreen
        user={user}
        playlists={playlists}
        loading={loadingPlaylists}
        selectedSource={selectedSource}
        onSelect={setSelectedSource}
        onStart={startGame}
        onBack={() => setView("setup")}
        loadingTracks={loadingTracks}
        onLogout={logout}
      />
    );
  }

  // Game over
  if (view === "game-over" && game && user) {
    return (
      <GameOverScreen
        game={game}
        user={user}
        onPlayAgain={() => setView("source-select")}
        onLogout={logout}
      />
    );
  }

  // Playing
  if (view === "playing" && game) {
    const track = game.tracks[game.currentIndex];
    return (
      <PlayingScreen
        game={game}
        track={track}
        isPlaying={isPlaying}
        clipTimer={clipTimer}
        guess={guess}
        onGuessChange={setGuess}
        onSubmit={() => submitGuess(guess)}
        onPlayClip={playClip}
        onNext={nextRound}
        result={result}
        revealed={revealed}
        voiceState={voiceState}
        onToggleVoice={toggleVoice}
        sdkReady={sdkReady}
        playerError={playerError}
        onLogout={logout}
      />
    );
  }

  // Setup / home
  return (
    <HomeScreen
      user={user}
      sdkReady={sdkReady}
      playerError={playerError}
      onStart={() => {
        console.log("Choose Songs clicked, user:", user, "tokens:", tokens);
        setView("source-select");
      }}
      onLogout={logout}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-screens
// ─────────────────────────────────────────────────────────────────────────────

function SetupRequired() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="max-w-lg w-full space-y-6">
        <div className="text-center space-y-3">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto">
            <AlertTriangle className="w-8 h-8 text-primary" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">Setup Required</h1>
          <p className="text-muted-foreground">
            To run this game, you need to create a Spotify app and add your Client ID.
          </p>
        </div>
        <div className="bg-card border border-border rounded-xl p-5 space-y-4 text-sm">
          <p className="font-semibold text-foreground">Quick setup (2 minutes):</p>
          <ol className="space-y-2 text-muted-foreground list-decimal list-inside">
            <li>
              Go to{" "}
              <a
                href="https://developer.spotify.com/dashboard"
                target="_blank"
                rel="noreferrer"
                className="text-primary underline"
              >
                developer.spotify.com/dashboard
              </a>{" "}
              and create an app
            </li>
            <li>Set Redirect URI to: <code className="bg-muted px-1 rounded">{window.location.origin + window.location.pathname}</code></li>
            <li>Copy your Client ID</li>
            <li>
              Create a <code className="bg-muted px-1 rounded">.env</code> file in the project root:
              <pre className="mt-2 bg-muted rounded p-3 overflow-x-auto">
                {`VITE_SPOTIFY_CLIENT_ID=your_client_id_here`}
              </pre>
            </li>
            <li>Restart the dev server</li>
          </ol>
        </div>
      </div>
    </div>
  );
}

function LoginScreen({ onLogin }: { onLogin: () => void }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="max-w-sm w-full text-center space-y-8">
        {/* Logo */}
        <div className="space-y-4">
          <div className="w-20 h-20 rounded-3xl bg-primary flex items-center justify-center mx-auto shadow-lg shadow-primary/30">
            <Music className="w-10 h-10 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-3xl font-bold text-foreground tracking-tight">Name That Tune</h1>
            <p className="text-muted-foreground mt-1">Identify songs from the first 3 seconds</p>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center gap-3 bg-card border border-border rounded-lg p-3 text-sm text-muted-foreground">
            <Headphones className="w-4 h-4 shrink-0 text-primary" />
            <span>Requires Spotify Premium for full playback</span>
          </div>
          <div className="flex items-center gap-3 bg-card border border-border rounded-lg p-3 text-sm text-muted-foreground">
            <Mic className="w-4 h-4 shrink-0 text-primary" />
            <span>Guess with voice or by typing</span>
          </div>
        </div>

        <Button
          data-testid="button-login"
          onClick={onLogin}
          className="w-full h-12 text-base font-semibold bg-[#1DB954] hover:bg-[#1ed760] text-black"
        >
          <svg className="w-5 h-5 mr-2" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
          </svg>
          Connect with Spotify
        </Button>
      </div>
    </div>
  );
}

function HomeScreen({
  user,
  sdkReady,
  playerError,
  onStart,
  onLogout,
}: {
  user: SpotifyUser;
  sdkReady: boolean;
  playerError: string | null;
  onStart: () => void;
  onLogout: () => void;
}) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background p-6">
      <div className="max-w-sm w-full space-y-8">
        {/* Header */}
        <div className="text-center space-y-3">
          <div className="w-20 h-20 rounded-3xl bg-primary flex items-center justify-center mx-auto shadow-lg shadow-primary/30">
            <Music className="w-10 h-10 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-3xl font-bold text-foreground">Name That Tune</h1>
            <p className="text-muted-foreground">Hey, {user.display_name.split(" ")[0]}!</p>
          </div>
        </div>

        {/* SDK status */}
        {playerError ? (
          <div className="flex items-start gap-3 bg-destructive/10 border border-destructive/30 rounded-xl p-4 text-sm text-destructive">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{playerError}</span>
          </div>
        ) : !sdkReady ? (
          <div className="flex items-center gap-3 bg-card border border-border rounded-xl p-4 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin shrink-0" />
            <span>Initializing Spotify player…</span>
          </div>
        ) : (
          <div className="flex items-center gap-3 bg-card border border-border rounded-xl p-4 text-sm text-foreground">
            <div className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
            <span>Spotify player ready</span>
          </div>
        )}

        {/* How it works */}
        <div className="space-y-2">
          {[
            { icon: Play, text: "Hit Play — 3 seconds of a random song" },
            { icon: Mic, text: "Guess by voice or typing" },
            { icon: Trophy, text: "Score points and build streaks" },
          ].map(({ icon: Icon, text }, i) => (
            <div key={i} className="flex items-center gap-3 text-sm text-muted-foreground">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                <Icon className="w-4 h-4 text-primary" />
              </div>
              {text}
            </div>
          ))}
        </div>

        <div className="space-y-3">
          <Button
            data-testid="button-play"
            className="w-full h-12 text-base font-semibold"
            onClick={onStart}
            disabled={!sdkReady}
          >
            Choose Songs & Play
            <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
          <Button variant="ghost" size="sm" className="w-full text-muted-foreground" onClick={onLogout}>
            <LogOut className="w-3 h-3 mr-1" /> Disconnect Spotify
          </Button>
        </div>
      </div>
    </div>
  );
}

function SourceSelectScreen({
  user,
  playlists,
  loading,
  selectedSource,
  onSelect,
  onStart,
  onBack,
  loadingTracks,
  onLogout,
}: {
  user: SpotifyUser;
  playlists: SpotifyPlaylist[];
  loading: boolean;
  selectedSource: string;
  onSelect: (src: string) => void;
  onStart: () => void;
  onBack: () => void;
  loadingTracks: boolean;
  onLogout: () => void;
}) {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="flex items-center justify-between px-5 py-4 border-b border-border">
        <button onClick={onBack} className="text-muted-foreground hover:text-foreground text-sm flex items-center gap-1">
          ← Back
        </button>
        <span className="font-semibold text-sm">Choose your music</span>
        <button onClick={onLogout} className="text-muted-foreground hover:text-foreground">
          <LogOut className="w-4 h-4" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-5 space-y-3 max-w-md mx-auto w-full">
        {/* Liked songs */}
        <button
          data-testid="source-liked"
          onClick={() => onSelect("liked")}
          className={`w-full flex items-center gap-4 p-4 rounded-xl border text-left transition-all ${
            selectedSource === "liked"
              ? "border-primary bg-primary/10"
              : "border-border bg-card hover:border-primary/50"
          }`}
        >
          <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center shrink-0">
            <Heart className="w-6 h-6 text-white" />
          </div>
          <div>
            <p className="font-semibold text-foreground">Liked Songs</p>
            <p className="text-xs text-muted-foreground">Your saved tracks</p>
          </div>
          {selectedSource === "liked" && <CheckCircle className="w-5 h-5 text-primary ml-auto" />}
        </button>

        {/* Playlists */}
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          playlists.map((pl) => (
            <button
              key={pl.id}
              data-testid={`source-playlist-${pl.id}`}
              onClick={() => onSelect(pl.id)}
              className={`w-full flex items-center gap-4 p-4 rounded-xl border text-left transition-all ${
                selectedSource === pl.id
                  ? "border-primary bg-primary/10"
                  : "border-border bg-card hover:border-primary/50"
              }`}
            >
              <div className="w-12 h-12 rounded-lg bg-muted flex items-center justify-center shrink-0 overflow-hidden">
                {pl.images?.[0]?.url ? (
                  <img src={pl.images[0].url} alt={pl.name} className="w-full h-full object-cover" />
                ) : (
                  <ListMusic className="w-6 h-6 text-muted-foreground" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-foreground truncate">{pl.name}</p>
                <p className="text-xs text-muted-foreground">{pl.tracks?.total ?? "?"} tracks</p>
              </div>
              {selectedSource === pl.id && <CheckCircle className="w-5 h-5 text-primary shrink-0" />}
            </button>
          ))
        )}
      </div>

      <div className="p-5 border-t border-border">
        <Button
          data-testid="button-start-game"
          className="w-full h-12 text-base font-semibold"
          onClick={onStart}
          disabled={loadingTracks}
        >
          {loadingTracks ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Loading tracks…
            </>
          ) : (
            <>Start Game ({ROUNDS_PER_GAME} rounds)</>
          )}
        </Button>
      </div>
    </div>
  );
}

function PlayingScreen({
  game,
  track,
  isPlaying,
  clipTimer,
  guess,
  onGuessChange,
  onSubmit,
  onPlayClip,
  onNext,
  result,
  revealed,
  voiceState,
  onToggleVoice,
  sdkReady,
  playerError,
  onLogout,
}: {
  game: GameState;
  track: SpotifyTrack;
  isPlaying: boolean;
  clipTimer: number;
  guess: string;
  onGuessChange: (v: string) => void;
  onSubmit: () => void;
  onPlayClip: () => void;
  onNext: () => void;
  result: "correct" | "wrong" | null;
  revealed: boolean;
  voiceState: string;
  onToggleVoice: () => void;
  sdkReady: boolean;
  playerError: string | null;
  onLogout: () => void;
}) {
  const roundNum = game.currentIndex + 1;
  const totalRounds = game.totalRounds;
  const progress = (clipTimer / (CLIP_DURATION_MS / 1000)) * 100;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Top bar */}
      <header className="flex items-center justify-between px-5 py-3 border-b border-border">
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="font-mono text-xs">
            {roundNum}/{totalRounds}
          </Badge>
          {game.streak >= 2 && (
            <Badge className="bg-orange-500/20 text-orange-400 border-orange-500/30 text-xs">
              <Zap className="w-3 h-3 mr-1" />
              {game.streak}x streak
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 font-mono font-bold text-foreground">
            <Trophy className="w-4 h-4 text-primary" />
            {game.score}
          </div>
          <button onClick={onLogout} className="text-muted-foreground hover:text-foreground">
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      <div className="flex-1 flex flex-col items-center justify-between p-6 max-w-md mx-auto w-full">
        {/* Album art area */}
        <div className="w-full space-y-6">
          <div
            className={`w-48 h-48 mx-auto rounded-2xl shadow-2xl overflow-hidden transition-all duration-500 ${
              revealed ? "scale-100 opacity-100" : "scale-90 opacity-30 blur-sm"
            }`}
          >
            {getAlbumArt(track) ? (
              <img src={getAlbumArt(track)} alt="Album art" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full bg-card flex items-center justify-center">
                <Music className="w-16 h-16 text-muted-foreground" />
              </div>
            )}
          </div>

          {/* Revealed info */}
          {revealed && (
            <div className="text-center space-y-1 animate-in fade-in slide-in-from-bottom-2 duration-300">
              <p className="font-bold text-xl text-foreground">{track.name}</p>
              <p className="text-muted-foreground">{track.artists.map((a) => a.name).join(", ")}</p>
              <p className="text-xs text-muted-foreground/60">{track.album.name}</p>
            </div>
          )}
        </div>

        {/* Play button + timer */}
        <div className="w-full space-y-4">
          {/* Progress bar */}
          {isPlaying && (
            <div className="space-y-1">
              <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-muted-foreground font-mono">
                <span>Playing…</span>
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
              className="w-full h-14 text-lg font-semibold"
              size="lg"
            >
              {isPlaying ? (
                <>
                  <Volume2 className="w-5 h-5 mr-2 animate-pulse" /> Playing…
                </>
              ) : (
                <>
                  <Play className="w-5 h-5 mr-2" /> Play 3-Second Clip
                </>
              )}
            </Button>
          )}

          {/* SDK error */}
          {playerError && (
            <p className="text-xs text-destructive text-center">{playerError}</p>
          )}

          {/* Guess area */}
          {result === null ? (
            <div className="space-y-3">
              <div className="flex gap-2">
                <Input
                  data-testid="input-guess"
                  placeholder="Song title…"
                  value={guess}
                  onChange={(e) => onGuessChange(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && guess.trim() && onSubmit()}
                  className="flex-1 h-12 text-base"
                />
                <Button
                  data-testid="button-voice"
                  variant={voiceState === "listening" ? "destructive" : "outline"}
                  size="icon"
                  className="h-12 w-12 shrink-0"
                  onClick={onToggleVoice}
                  title={voiceState === "listening" ? "Stop listening" : "Voice input"}
                >
                  {voiceState === "listening" ? (
                    <MicOff className="w-5 h-5 animate-pulse" />
                  ) : (
                    <Mic className="w-5 h-5" />
                  )}
                </Button>
              </div>
              {voiceState === "listening" && (
                <p className="text-xs text-primary text-center animate-pulse">
                  Listening… say the song title
                </p>
              )}
              <Button
                data-testid="button-submit-guess"
                onClick={onSubmit}
                disabled={!guess.trim()}
                className="w-full"
                variant="secondary"
              >
                Submit Guess
              </Button>
            </div>
          ) : (
            /* Result */
            <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
              <div
                className={`flex items-center gap-3 p-4 rounded-xl border ${
                  result === "correct"
                    ? "bg-green-500/10 border-green-500/30 text-green-400"
                    : "bg-destructive/10 border-destructive/30 text-destructive"
                }`}
              >
                {result === "correct" ? (
                  <CheckCircle className="w-5 h-5 shrink-0" />
                ) : (
                  <XCircle className="w-5 h-5 shrink-0" />
                )}
                <div>
                  <p className="font-semibold">
                    {result === "correct" ? `Correct! +${Math.max(1, Math.ceil(clipTimer))} pts` : "Not quite!"}
                  </p>
                  {guess && <p className="text-xs opacity-70">You said: "{guess}"</p>}
                </div>
              </div>
              <Button
                data-testid="button-next"
                onClick={onNext}
                className="w-full h-12 text-base"
              >
                {game.currentIndex + 1 >= game.totalRounds ? (
                  <>See Results</>
                ) : (
                  <>
                    Next Song <SkipForward className="w-4 h-4 ml-1" />
                  </>
                )}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function GameOverScreen({
  game,
  user,
  onPlayAgain,
  onLogout,
}: {
  game: GameState;
  user: SpotifyUser;
  onPlayAgain: () => void;
  onLogout: () => void;
}) {
  const accuracy = Math.round((game.roundsWon / game.totalRounds) * 100);

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6">
      <div className="max-w-sm w-full space-y-8 text-center">
        {/* Trophy */}
        <div className="space-y-3">
          <div className="w-24 h-24 rounded-3xl bg-primary/10 flex items-center justify-center mx-auto">
            <Trophy className="w-12 h-12 text-primary" />
          </div>
          <div>
            <h2 className="text-3xl font-bold text-foreground">{game.score} pts</h2>
            <p className="text-muted-foreground">Game over, {user.display_name.split(" ")[0]}!</p>
          </div>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Correct", value: `${game.roundsWon}/${game.totalRounds}` },
            { label: "Accuracy", value: `${accuracy}%` },
            { label: "Best Streak", value: `${game.bestStreak}x` },
          ].map(({ label, value }) => (
            <div key={label} className="bg-card border border-border rounded-xl p-4 space-y-1">
              <p className="text-xl font-bold text-foreground">{value}</p>
              <p className="text-xs text-muted-foreground">{label}</p>
            </div>
          ))}
        </div>

        <div className="space-y-3">
          <Button data-testid="button-play-again" className="w-full h-12 text-base font-semibold" onClick={onPlayAgain}>
            Play Again
          </Button>
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
            <pre className="text-xs text-muted-foreground whitespace-pre-wrap break-all bg-muted p-3 rounded overflow-auto max-h-64">
              {this.state.error}
            </pre>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export { ErrorBoundary };
