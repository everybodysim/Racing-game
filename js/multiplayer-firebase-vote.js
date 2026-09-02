// Pure helpers for the Firebase-backed public-server map vote plus room player
// count. Kept free of DOM/PeerJS/THREE so they are unit-testable in Node.
//
// The public-server room doc lives at racing-rooms/<CODE> with:
//   players/<uid>            { x,y,z,ry,carKey,cosmetics,name,mapSignature,updatedAt }
//   mapSignature            written by the current host (mirror tick)
//   status                 'hosting' while a host is present
//   vote                   { voteId, playUrl, trackName, initiatorId, startedAt,
//                            initiatorVote, polledAt, votes:{<uid>:'yes'|'no'} }
//   vote.result            { passed, playUrl, trackName, yes, no, total, resolvedAt }
//
// All of these are written one-writer-per-subpath, so Firebase RTDB merges them
// without clobbering (the host writes mapSignature; each player writes only their
// own players/<own> and vote/votes/<own>; the initiator writes the vote root + result).

// Build a normalized snapshot from a Firebase `vote` doc, or null when the doc is
// missing/invalid or its voteId string is empty. `durationMs` is the open window.
export function normalizeFirebaseVoteDoc( voteDoc, durationMs ) {

        if ( ! voteDoc || typeof voteDoc !== 'object' ) return null;
        const voteId = String( voteDoc.voteId || '' ).trim();
        if ( ! voteId ) return null;
        const startedAt = Number( voteDoc.startedAt );
        if ( ! Number.isFinite( startedAt ) || startedAt <= 0 ) return null;
        const votes = {};
        const rawVotes = typeof voteDoc.votes === 'object' && voteDoc.votes ? voteDoc.votes : {};
        for ( const [ pid, vote ] of Object.entries( rawVotes ) ) {

                const v = vote === 'no' ? 'no' : 'yes';
                if ( pid && typeof pid === 'string' ) votes[ pid ] = v;

        }
        const initiatorId = String( voteDoc.initiatorId || '' );
        // The initiator's own per-uid vote (if they cast via vote/votes/<own>) wins;
        // initiatorVote is only a default so the initiator's 'yes' shows up even
        // when they never cast a per-uid vote (they can still vote No later)。
        if ( initiatorId && ! Object.prototype.hasOwnProperty.call( votes, initiatorId ) ) votes[ initiatorId ] = voteDoc.initiatorVote === 'no' ? 'no' : 'yes';
        const validDuration = Number.isFinite( durationMs ) && durationMs > 0 ? Number( durationMs ) : 0;
        const resultDoc = typeof voteDoc.result === 'object' && voteDoc.result ? voteDoc.result : null;
        return {
                voteId,
                initiatorId,
                playUrl: String( voteDoc.playUrl || '' ),
                trackName: String( voteDoc.trackName || 'Shared track' ),
                startedAt,
                endsAt: validDuration > 0 ? startedAt + validDuration : startedAt,
                votes,
                polledAt: Number( voteDoc.polledAt ) || 0,
                result: resultDoc ? {
                        passed: Boolean( resultDoc.passed ),
                        playUrl: String( resultDoc.playUrl || voteDoc.playUrl || '' ),
                        trackName: String( resultDoc.trackName || voteDoc.trackName || 'Shared track' ),
                        yes: Math.max( 0, Number( resultDoc.yes ) || 0 ),
                        no: Math.max( 0, Number( resultDoc.no ) || 0 ),
                        total: Math.max( 0, Number( resultDoc.total ) || 0 ),
                } : null,
        };

}

// Tally a votes map into yes/no/total and the pass decision (strictly > ratio yes,
// with at least one vote)。 Same math as the PeerJS vote path.

export function tallyFirebaseVotes( votes, passRatio ) {

        let yes = 0, no = 0;
        const v = typeof votes === 'object' && votes ? votes : {};
        for ( const vote of Object.values( v ) ) {

                if ( vote === 'yes' ) yes ++;
                else if ( vote === 'no' ) no ++;

        }
        const total = yes + no;
        const ratio = Number( passRatio );
        const passes = total > 0 && ( yes / total ) > ( Number.isFinite( ratio ) ? ratio : 0.60 );
        return { yes, no, total, passed: passes };

}

// Fresh-player count from a room doc `players` map： entries whose updatedAt is
// within `staleMs` of `now`, plus our own id when it isn't listed (we always count).
export function countFreshRoomPlayers( players, now, staleMs, selfId ) {

        let n = 0;
        const map = typeof players === 'object' && players ? players : {};
        for ( const entry of Object.values( map ) ) {

                if ( ! entry || typeof entry !== 'object' ) continue;
                const updatedAt = Number( entry.updatedAt ) || 0;
                if ( ! Number.isFinite( updatedAt ) ) continue;
                const check = Number.isFinite( staleMs ) && staleMs >= 0 ? staleMs : 0;
                if ( now - updatedAt > check ) continue;
                n ++;

        }
        const self = String( selfId || '' );
        if ( self && ! Object.prototype.hasOwnProperty.call( map, self ) ) n ++;
        return n;

}