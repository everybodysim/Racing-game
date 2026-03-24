import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import express from "express";
import { createServer } from "http";
import path from "path";
import { RacingRoom } from "./RacingRoom";

const app = express();
app.use(express.static(path.join(__dirname, "../../")));

const server = new Server({
	transport: new WebSocketTransport({
		server: createServer(app),
	}),
});

server.define("racing", RacingRoom).filterBy(["mapCode"]);

const port = Number(process.env.PORT) || 3000;
server.listen(port).then(() => {
	console.log(`Racing server → http://localhost:${port}`);
});
