// TURN / STUN relay configuration.
//
// === WHY THIS EXISTS ======================================================
// Public static TURN credentials are effectively extinct (the old OpenRelay
// openrelayproject/openrelayproject pair was retired — metered.ca now requires
// an account, and its TLS endpoint serves a certificate for a different
// domain). Shipping TURN servers with invalid credentials means the relay
// layer silently NEVER works: users behind symmetric NAT / CGNAT / UDP-blocked
// school networks can't establish P2P at all. Failed TURN candidates are
// silently dropped by ICE, so including dead TURN servers is zero-risk, but
// including NO working TURN servers caps P2P at "consumer NAT only".
//
// === HOW TO ENABLE TURN (5 minutes, one-time) =============================
// 1. Create a free account at one of:
//      • https://www.expressturn.com  — free 1TB/month, TCP+UDP on 3478/80/443
//      • https://www.metered.ca       — free 20GB/month via their Open Relay
// 2. Copy the username/password pair from their dashboard into
//    TURN_STATIC_CREDENTIALS below, OR — if you prefer rotating credentials —
//    stand up a tiny JSON endpoint (any worker) that returns
//    { username, credential, ttlMs } and put its URL in TURN_CREDENTIALS_URL.
//    The client fetches it once per page load, caches with TTL, and silently
//    falls back to STUN-only if it fails. No code changes needed either way.
// ==========================================================================

// Static credentials. Empty = TURN disabled (STUN-only ICE) until filled in.
export const TURN_STATIC_CREDENTIALS = {
	username: '',
	credential: '',
};

// Optional: URL returning { username, credential, ttlMs? } JSON. Takes
// precedence over the static pair when set. Kept empty by default.
export const TURN_CREDENTIALS_URL = '';

// STUN servers. Multiple providers because STUN reachability varies by network
// (Google is blocked in some schools; Cloudflare in others; redundancy is free).
// openrelay.metered.ca is deliberately absent: metered retired the public
// credentials and its TLS endpoint serves a cert for a different domain.
export const TURN_STUN_SERVERS = [
	'stun:stun.l.google.com:19302',
	'stun:stun.cloudflare.com:3478',
];

// TURN relay URLs used whenever we have credentials. Ordered so ICE tries UDP
// first (fast), then TCP 443 (survives UDP-blocked firewalls). turns: (TLS) is
// only reachable on hosts with a valid certificate for their hostname — openrelay
// currently serves a *.relay.metered.ca cert for openrelay.metered.ca, so its
// turns: endpoint is dead in every browser. Do not add it back without re-testing.
export const TURN_RELAY_URLS = [
	'turn:turn.expressturn.com:3478?transport=udp',
	'turn:turn.expressturn.com:3478?transport=tcp',
	'turn:turn.expressturn.com:443?transport=tcp',
];

const TURN_FETCH_TIMEOUT_MS = 4000;
const TURN_DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

let iceServersPromise = null;
let iceServersExpiresAt = 0;
let iceServersCredentialsUrl = null;
let forceReset = false;

async function fetchTurnCredentials( credentialsUrl ) {

	if ( ! credentialsUrl ) return null;
	const controller = new AbortController();
	const timeoutId = setTimeout( () => controller.abort(), TURN_FETCH_TIMEOUT_MS );
	try {

		const response = await fetch( credentialsUrl, { signal: controller.signal } );
		if ( ! response.ok ) return null;
		const data = await response.json();
		const username = String( data?.username || '' ).trim();
		const credential = String( data?.credential || '' ).trim();
		if ( ! username || ! credential ) return null;
		const ttlMs = Number( data?.ttlMs );
		return {
			username,
			credential,
			ttlMs: Number.isFinite( ttlMs ) && ttlMs > 0 ? ttlMs : TURN_DEFAULT_TTL_MS,
		};

	} catch {

		return null; // blocked network / bad endpoint / bad payload → STUN-only

	} finally {

		clearTimeout( timeoutId );

	}

}

function buildIceServers( credentials ) {

	const iceServers = TURN_STUN_SERVERS.map( ( urls ) => ( { urls } ) );
	if ( credentials && credentials.username && credentials.credential ) {

		iceServers.push( {
			urls: TURN_RELAY_URLS,
			username: credentials.username,
			credential: credentials.credential,
		} );

	}
	return iceServers;

}

// Resolve the iceServers list. Cached until its TTL expires (credentials rotate
// without a page reload on long-lived sessions). Never throws: every failure
// path degrades to STUN-only + legacy candidates.
export async function resolveIceServers( options = {} ) {

	const force = Boolean( options.force );
	const credentialsUrl = options.credentialsUrl || TURN_CREDENTIALS_URL;
	if ( credentialsUrl !== ( ( iceServersPromise && iceServersCredentialsUrl ) || TURN_CREDENTIALS_URL ) ) {

		forceReset = true;

	}
	const now = Date.now();
	if ( ! forceReset && ! force && iceServersPromise && now < iceServersExpiresAt ) return iceServersPromise;

	const promise = ( async () => {

		let credentials = null;
		if ( credentialsUrl ) {

			credentials = await fetchTurnCredentials( credentialsUrl );

		}
		if ( ! credentials && TURN_STATIC_CREDENTIALS.username && TURN_STATIC_CREDENTIALS.credential ) {

			credentials = { ...TURN_STATIC_CREDENTIALS, ttlMs: TURN_DEFAULT_TTL_MS };

		}
		iceServersExpiresAt = Date.now() + ( credentials?.ttlMs || TURN_DEFAULT_TTL_MS );
		return buildIceServers( credentials );

	} )();

	iceServersPromise = promise;
	iceServersCredentialsUrl = credentialsUrl;
	forceReset = false;
	return promise;

}

// Test hook: reset the cache so tests can exercise the fetch/TTL paths.
export function resetIceServersForTests() {

	iceServersPromise = null;
	iceServersExpiresAt = 0;
	iceServersCredentialsUrl = null;
	forceReset = false;

}
