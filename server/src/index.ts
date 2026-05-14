import cors from "cors";
import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@rocket-soccer/shared";
import { RoomManager } from "./roomManager.js";

const PORT = Number(process.env.PORT ?? 3000);

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = http.createServer(app);

const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: { origin: "*" },
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Serve frontend in production
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDist = path.join(__dirname, "../../client/dist");

app.use(express.static(clientDist));

app.get("*", (req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

const rooms = new RoomManager(io);

io.on("connection", (socket) => {
  rooms.onConnection(socket);
});

httpServer.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Rocket Soccer server listening on :${PORT}`);
});
