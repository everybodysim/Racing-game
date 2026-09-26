// Official "Hide Trees" mod metadata. The visual swap is implemented
// directly in js/Track.js at track build time (it needs access to the
// decoration scatter, which a sandboxed runtime mod can't reach). This
// file exists so the mod shows up in the Mod Manager catalog
// (mods/mods.json) and follows the same install/uninstall lifecycle as
// the other official mods.
//
// VISUAL EFFECT ONLY: it never touches physics, colliders, or timing,
// and js/main.js whitelists the mod id (next to freecam and
// video-recorder) so leaderboard runs stay fully valid. Trees have no
// collision anyway — this purely swaps the scattered forest meshes for
// the flat empty deco plane. Applies on the next track load / reload.
export const HIDE_TREES_MOD = {
	id: 'hide-trees',
	name: 'Hide Trees',
	description: 'Replaces every auto-placed tree with the empty green deco plane. Visual only — leaderboard times still count.'
};
