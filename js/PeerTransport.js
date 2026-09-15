// ─────────────────────────────────────────────────────────────────────────────
// PeerTransport — picks which multiplayer transport the game loads.
//
//   default                                            → js/SupabasePeer.js
//   localStorage['racing-mp-backend'] === 'peerjs'      → PeerJS (escape hatch)
//
// If the Supabase backend fails to load (no credentials yet, CDN hiccup),
// we fall back to PeerJS so multiplayer always boots. PeerJS stays exactly
// as lazy as it is today: it is only imported when the supabase flag is off.
// ─────────────────────────────────────────────────────────────────────────────

let backend = null;
// Default: Supabase (the PeerJS escape hatch stays available).
let wanted = 'supabase';
try { wanted = localStorage.getItem( 'racing-mp-backend' ) || 'supabase'; } catch { /* private mode */ }

if ( wanted === 'supabase' ) {
	try {
		backend = ( await import( './SupabasePeer.js?v=3' ) ).default;
	} catch ( e ) {
		console.warn( '[MP] Supabase transport unavailable, falling back to PeerJS:', e );
		backend = null;
	}
}
if ( ! backend ) {
	backend = ( await import( 'https://esm.sh/peerjs@1.5.5?bundle' ) ).default;
}

export default backend;
