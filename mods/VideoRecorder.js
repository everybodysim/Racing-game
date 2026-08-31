// Official "Video Recorder" mod metadata. The actual recording engine lives in
// js/VideoRecorder.js and is wired up directly in js/main.js (it needs access to
// the renderer canvas and the game's AudioContext, which a sandboxed runtime mod
// can't reach). This file exists so the mod shows up in the Mod Manager catalog
// (mods/mods.json) and follows the same install/uninstall lifecycle as the
// other official mods.
export const VIDEO_RECORDER_MOD = {
	id: 'video-recorder',
	name: 'Video Recorder',
	description: 'Record high-FPS, high-quality gameplay video (with game audio) and download it for YouTube. Adds a recorder button above the car selector and a settings panel.'
};
