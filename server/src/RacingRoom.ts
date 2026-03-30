import { Room, Client } from "colyseus";
import { Schema, MapSchema, type } from "@colyseus/schema";

const VEHICLE_MODELS = [
	"vehicle-truck-yellow",
	"vehicle-truck-green",
	"vehicle-truck-purple",
	"vehicle-truck-red",
];

// Track constants (mirrored from js/Track.js)
const CELL_RAW = 9.99;
const GRID_SCALE = 0.75;
const ORIENT_DEG: Record<number, number> = { 0: 0, 10: 180, 16: 90, 22: 270 };

const TYPE_NAMES = ["track-straight", "track-corner", "track-bump", "track-finish"];
const ORIENT_TO_GODOT = [0, 16, 10, 22];

const DEFAULT_TRACK: TrackCell[] = [
	[-3, -3, "track-corner", 16],
	[-2, -3, "track-straight", 22],
	[-1, -3, "track-straight", 22],
	[0, -3, "track-corner", 0],
	[-3, -2, "track-straight", 0],
	[0, -2, "track-straight", 0],
	[-3, -1, "track-corner", 10],
	[-2, -1, "track-corner", 0],
	[0, -1, "track-straight", 0],
	[-2, 0, "track-straight", 10],
	[0, 0, "track-finish", 0],
	[-2, 1, "track-straight", 10],
	[0, 1, "track-straight", 0],
	[-2, 2, "track-corner", 10],
	[-1, 2, "track-straight", 16],
	[0, 2, "track-corner", 22],
];

type TrackCell = [number, number, string, number];

function decodeCells(str: string): TrackCell[] {
	const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
	const binary = Buffer.from(base64, "base64");
	const cells: TrackCell[] = [];
	for (let i = 0; i + 2 < binary.length; i += 3) {
		const gx = binary[i] - 128;
		const gz = binary[i + 1] - 128;
		const packed = binary[i + 2];
		const ti = (packed >> 2) & 0x03;
		const oi = packed & 0x03;
		cells.push([gx, gz, TYPE_NAMES[ti], ORIENT_TO_GODOT[oi]]);
	}
	return cells;
}

function computeSpawn(cells: TrackCell[]) {
	let cell = cells[0];
	for (const c of cells) {
		if (c[2] === "track-finish") { cell = c; break; }
	}
	const x = (cell[0] + 0.5) * CELL_RAW * GRID_SCALE;
	const z = (cell[1] + 0.5) * CELL_RAW * GRID_SCALE;
	const angle = (ORIENT_DEG[cell[3]] ?? 0) * Math.PI / 180;
	return { x, z, angle };
}

function gridSpawnPosition(spawnIndex: number, spawn: { x: number; z: number; angle: number }) {
	const col = spawnIndex % 2;
	const row = Math.floor(spawnIndex / 2);
	const lateral = (col === 0 ? -1 : 1) * 1.2;
	const back = -row * 2.5;
	const cos = Math.cos(spawn.angle);
	const sin = Math.sin(spawn.angle);
	return {
		x: spawn.x + lateral * cos - back * sin,
		y: 0.5,
		z: spawn.z + lateral * sin + back * cos,
		angle: spawn.angle,
	};
}

export class Player extends Schema {
	@type("string") modelKey: string = "";
	@type("float32") spawnAngle: number = 0;
	@type("float32") x: number = 0;
	@type("float32") y: number = 0.5;
	@type("float32") z: number = 0;
	@type("float32") qx: number = 0;
	@type("float32") qy: number = 0;
	@type("float32") qz: number = 0;
	@type("float32") qw: number = 1;
	@type("float32") linearSpeed: number = 0;
	@type("float32") inputX: number = 0;
	@type("float32") inputZ: number = 0;
	@type("float32") bodyPitch: number = 0;
	@type("float32") bodyRoll: number = 0;
}

export class RacingState extends Schema {
	@type({ map: Player }) players = new MapSchema<Player>();
}

export class RacingRoom extends Room {
	private modelIndex = 0;
	private spawn = computeSpawn(DEFAULT_TRACK);

	state = new RacingState();

	onCreate(options: { mapCode?: string }) {
		if (options.mapCode && options.mapCode !== "default") {
			try {
				const cells = decodeCells(options.mapCode);
				this.spawn = computeSpawn(cells);
			} catch (e) {
				console.warn("Invalid map code, using default track");
			}
		}

		this.onMessage("update", (client, message) => {
			const player = this.state.players.get(client.sessionId);
			if (!player) return;

			player.x = message.x;
			player.y = message.y;
			player.z = message.z;
			player.qx = message.qx;
			player.qy = message.qy;
			player.qz = message.qz;
			player.qw = message.qw;
			player.linearSpeed = message.linearSpeed;
			player.inputX = message.inputX;
			player.inputZ = message.inputZ;
			player.bodyPitch = message.bodyPitch;
			player.bodyRoll = message.bodyRoll;
		});
	}

	onJoin(client: Client) {
		const player = new Player();
		player.modelKey = VEHICLE_MODELS[this.modelIndex % VEHICLE_MODELS.length];

		const pos = gridSpawnPosition(this.modelIndex % 10, this.spawn);
		player.x = pos.x;
		player.y = pos.y;
		player.z = pos.z;
		player.spawnAngle = pos.angle;

		// Set initial quaternion from spawn angle
		player.qy = Math.sin(pos.angle / 2);
		player.qw = Math.cos(pos.angle / 2);

		this.modelIndex++;
		this.state.players.set(client.sessionId, player);
		console.log(`Player joined: ${client.sessionId} → ${player.modelKey} (${pos.x.toFixed(1)}, ${pos.z.toFixed(1)})`);
	}

	onLeave(client: Client) {
		this.state.players.delete(client.sessionId);
		console.log(`Player left: ${client.sessionId}`);
	}
}
