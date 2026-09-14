// Multiplayer Editor — a repo-file mod, exactly like Freecam / TAS etc.
// (see mods/mods.json + js/main.js loadRuntimeMods()).
//
// In the GAME this mod is deliberately INERT: it exports only metadata, so
// toRuntimeMod() finds no runtime and nothing runs — it cannot modify
// gameplay, which is why leaderboard submissions stay valid with it
// installed. Its entire effect lives in the TRACK EDITOR: when this mod
// is installed, editor.html swaps the minimap for the multiplayer panel
// (Host / Join / room code) built from js/EditorMultiplayer.js, letting
// players edit one track together live.

export const MULTIPLAYER_EDITOR_MOD = {
	id: 'multiplayer-editor',
	name: 'Multiplayer Editor',
	description: 'Collaborative track editing in the Track Editor. Install once, then open the Track Editor: the minimap is replaced with Host / Join multiplayer controls — host a room, share the 6-letter code, and everyone edits the same track live. Does not modify gameplay; leaderboard times are unaffected.'
};

export default MULTIPLAYER_EDITOR_MOD;
