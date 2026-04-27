// Spotify PKCE OAuth helpers
// Users must register their own app at https://developer.spotify.com
// and set VITE_SPOTIFY_CLIENT_ID in .env

export const SPOTIFY_CLIENT_ID = import.meta.env.VITE_SPOTIFY_CLIENT_ID || "";
// Redirect URI — must match what's registered in Spotify Dashboard
export const SPOTIFY_REDIRECT_URI =
  import.meta.env.VITE_SPOTIFY_REDIRECT_URI ||
  window.location.origin + window.location.pathname;

const SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-library-read",
  "playlist-read-private",
  "playlist-read-collaborative",
].join(" ");

// ─── Storage: try localStorage (survives page reload), fall back to memory ───
const memStore: Record<string, string> = {};
function storageSet(key: string, val: string) {
  try { localStorage.setItem(key, val); } catch { memStore[key] = val; }
}
function storageGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return memStore[key] ?? null; }
}
function storageRemove(key: string) {
  try { localStorage.removeItem(key); } catch { delete memStore[key]; }
}

// ─── PKCE helpers ────────────────────────────────────────────────
function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => chars[b % chars.length]).join("");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ─── Auth ────────────────────────────────────────────────────────
export async function initiateSpotifyLogin() {
  const verifier = generateRandomString(128);
  const challenge = await generateCodeChallenge(verifier);
  const state = generateRandomString(16);

  // Save verifier to localStorage so it survives the page reload after Spotify redirect
  storageSet("pkce_verifier", verifier);
  storageSet("pkce_state", state);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: SPOTIFY_CLIENT_ID,
    scope: SCOPES,
    redirect_uri: SPOTIFY_REDIRECT_URI,
    state,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });

  // Navigate directly — Spotify redirects back to this page with ?code=
  window.location.href = `https://accounts.spotify.com/authorize?${params}`;
}

export async function exchangeCodeForToken(code: string, state: string): Promise<SpotifyTokens | null> {
  const storedState = storageGet("pkce_state");
  const verifier = storageGet("pkce_verifier");

  if (!verifier || state !== storedState) {
    console.error("State mismatch or missing verifier");
    return null;
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: SPOTIFY_REDIRECT_URI,
    client_id: SPOTIFY_CLIENT_ID,
    code_verifier: verifier,
  });

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    console.error("Token exchange failed", await response.text());
    return null;
  }

  const tokens: SpotifyTokens = await response.json();
  tokens.expires_at = Date.now() + tokens.expires_in * 1000;

  storageRemove("pkce_verifier");
  storageRemove("pkce_state");

  return tokens;
}

export async function refreshToken(refreshTokenStr: string): Promise<SpotifyTokens | null> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshTokenStr,
    client_id: SPOTIFY_CLIENT_ID,
  });

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) return null;
  const tokens: SpotifyTokens = await response.json();
  tokens.expires_at = Date.now() + tokens.expires_in * 1000;
  if (!tokens.refresh_token) tokens.refresh_token = refreshTokenStr;
  return tokens;
}

// ─── API helpers ─────────────────────────────────────────────────
export async function spotifyFetch(path: string, token: string): Promise<any> {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Spotify API error ${res.status}: ${path}`);
  return res.json();
}

export async function getCurrentUser(token: string): Promise<SpotifyUser> {
  return spotifyFetch("/me", token);
}

export async function getUserPlaylists(token: string, limit = 50): Promise<SpotifyPlaylist[]> {
  const data = await spotifyFetch(`/me/playlists?limit=${limit}`, token);
  return data.items.filter((p: any) => p && p.id && p.tracks);
}

export async function getPlaylistTracks(playlistId: string, token: string): Promise<SpotifyTrack[]> {
  const tracks: SpotifyTrack[] = [];
  let url = `/playlists/${playlistId}/tracks?limit=100&fields=next,items(track(id,name,artists,album,duration_ms,preview_url,uri))`;

  while (url) {
    const data = await spotifyFetch(url, token);
    for (const item of data.items) {
      if (item?.track?.id && item.track.duration_ms > 5000) {
        tracks.push(item.track);
      }
    }
    // Strip base URL for relative calls
    url = data.next ? data.next.replace("https://api.spotify.com/v1", "") : null;
  }

  return tracks;
}

// Hardcoded genre list with search queries — replaces deprecated /browse/categories
export const GENRE_CATEGORIES: SpotifyCategory[] = [
  { id: "70s rock",        name: "70s Rock",        icons: [] },
  { id: "80s hits",        name: "80s Hits",         icons: [] },
  { id: "90s alternative", name: "90s Alternative",  icons: [] },
  { id: "2000s pop",       name: "2000s Pop",        icons: [] },
  { id: "hip hop",         name: "Hip Hop",          icons: [] },
  { id: "pop hits",        name: "Pop Hits",         icons: [] },
  { id: "classic rock",    name: "Classic Rock",     icons: [] },
  { id: "country",         name: "Country",          icons: [] },
  { id: "r&b soul",        name: "R&B & Soul",       icons: [] },
  { id: "jazz",            name: "Jazz",             icons: [] },
  { id: "latin",           name: "Latin",            icons: [] },
  { id: "indie",           name: "Indie",            icons: [] },
  { id: "metal",           name: "Metal",            icons: [] },
  { id: "electronic dance",name: "Electronic / Dance",icons: [] },
  { id: "blues",           name: "Blues",            icons: [] },
  { id: "reggae",          name: "Reggae",           icons: [] },
  { id: "punk rock",       name: "Punk Rock",        icons: [] },
  { id: "broadway musicals",name: "Broadway",        icons: [] },
  { id: "workout hits",    name: "Workout",          icons: [] },
  { id: "christmas holiday",name: "Holiday",         icons: [] },
];

// Live playlist search — works exactly like typing into the Spotify app search bar
export async function searchPlaylists(query: string, token: string): Promise<SpotifyPlaylist[]> {
  if (!query.trim()) return [];
  const q = encodeURIComponent(query.trim());
  const data = await spotifyFetch(`/search?q=${q}&type=playlist&limit=30&market=US`, token);
  const items: any[] = data.playlists?.items || [];
  return items
    .filter((p: any) => p != null && p.id)
    .map((p: any) => ({ ...p, tracks: p.tracks ?? { total: 0 } }));
}

export async function getCategories(token: string): Promise<SpotifyCategory[]> {
  // Return hardcoded list — Spotify deprecated /browse/categories in 2023
  return GENRE_CATEGORIES;
}

// Map genre IDs to Spotify-optimised search queries that surface the best playlists
const GENRE_SEARCH_QUERIES: Record<string, string> = {
  "70s rock":          "70s rock classics",
  "80s hits":          "80s greatest hits",
  "90s alternative":   "90s alternative rock",
  "2000s pop":         "2000s pop hits",
  "hip hop":           "hip hop essentials",
  "pop hits":          "today's top hits",
  "classic rock":      "classic rock anthems",
  "country":           "country hits",
  "r&b soul":          "r&b soul classics",
  "jazz":              "jazz classics",
  "latin":             "latin hits",
  "indie":             "indie essentials",
  "metal":             "metal essentials",
  "electronic dance":  "dance hits electronic",
  "blues":             "blues classics",
  "reggae":            "reggae classics",
  "punk rock":         "punk rock essentials",
  "broadway musicals": "broadway musical hits",
  "workout hits":      "workout hits gym",
  "christmas holiday": "christmas holiday hits",
};

// Search Spotify for playlists — uses curated queries for best results
export async function getCategoryPlaylists(genreId: string, token: string): Promise<SpotifyPlaylist[]> {
  const query = GENRE_SEARCH_QUERIES[genreId] || genreId;
  // Search both with and without "playlist" keyword for maximum results
  const q = encodeURIComponent(query);
  const data = await spotifyFetch(
    `/search?q=${q}&type=playlist&limit=20&market=US`,
    token
  );
  const items: any[] = data.playlists?.items || [];
  // Accept playlists even if tracks.total is 0 — just needs a valid id
  return items
    .filter((p: any) => p != null && p.id)
    .map((p: any) => ({
      ...p,
      tracks: p.tracks ?? { total: 0 },
    }));
}

export async function getFeaturedPlaylists(token: string): Promise<SpotifyPlaylist[]> {
  // Search for curated top-hits playlists as a featured replacement
  const data = await spotifyFetch("/search?q=top+hits+2024&type=playlist&limit=10&market=US", token);
  const items: any[] = data.playlists?.items || [];
  return items
    .filter((p: any) => p != null && p.id)
    .map((p: any) => ({ ...p, tracks: p.tracks ?? { total: 0 } }));
}

export async function getLikedTracks(token: string): Promise<SpotifyTrack[]> {
  const tracks: SpotifyTrack[] = [];
  let url = "/me/tracks?limit=50";

  while (url) {
    const data = await spotifyFetch(url, token);
    for (const item of data.items) {
      if (item?.track?.id && item.track.duration_ms > 5000) {
        tracks.push(item.track);
      }
    }
    url = data.next ? data.next.replace("https://api.spotify.com/v1", "") : null;
    if (tracks.length >= 200) break; // cap at 200 liked songs
  }

  return tracks;
}

// ─── Types ───────────────────────────────────────────────────────
export interface SpotifyTokens {
  access_token: string;
  token_type: string;
  scope: string;
  expires_in: number;
  expires_at: number;
  refresh_token: string;
}

export interface SpotifyUser {
  id: string;
  display_name: string;
  email: string;
  images: { url: string }[];
}

export interface SpotifyCategory {
  id: string;
  name: string;
  icons: { url: string }[];
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  tracks: { total: number };
  images: { url: string }[];
}

export interface SpotifyTrack {
  id: string;
  name: string;
  artists: { name: string }[];
  album: { name: string; images: { url: string }[] };
  duration_ms: number;
  preview_url: string | null;
  uri: string;
}

// ─── Shuffle util ────────────────────────────────────────────────
export function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
