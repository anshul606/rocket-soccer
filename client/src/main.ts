import { io, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  PlayerInput,
  ServerToClientEvents,
  TeamId,
} from "@rocket-soccer/shared";
import { MatchView } from "./matchView.js";

const canvas = document.getElementById("c") as HTMLCanvasElement;
const view = new MatchView(canvas);

const el = (id: string) => document.getElementById(id)!;

let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
let playerId: string | null = sessionStorage.getItem("rs_pid");
let roomCode: string | null = sessionStorage.getItem("rs_room");
let isHost = false;
let matchActive = false;
let keys = new Set<string>();
let lastBoostNorm = 0;

function showMenu() {
  el("menu").classList.remove("hidden");
  el("lobby").classList.add("hidden");
  el("hud").classList.add("hidden");
  el("help").classList.add("hidden");
}

function showLobby() {
  el("menu").classList.add("hidden");
  el("lobby").classList.remove("hidden");
  el("hud").classList.add("hidden");
  el("help").classList.add("hidden");
}

function showMatchHud() {
  el("menu").classList.add("hidden");
  el("lobby").classList.add("hidden");
  el("hud").classList.remove("hidden");
  el("help").classList.remove("hidden");
  el("end-screen").classList.add("hidden");
  el("countdown-overlay").classList.add("hidden");
}

function fmtTime(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function wireSocket() {
  socket?.disconnect();
  socket = io({
    transports: ["websocket"],
    path: "/socket.io",
  });

  socket.on("assignedPlayer", ({ playerId: pid, roomCode: code }) => {
    playerId = pid;
    roomCode = code;
    sessionStorage.setItem("rs_pid", pid);
    sessionStorage.setItem("rs_room", code);
  });

  socket.on("lobbyUpdate", ({ roomCode: code, players, you, matchLive }) => {
    roomCode = code;
    sessionStorage.setItem("rs_room", code);
    const me = players.find((p) => p.id === you);
    isHost = me?.isHost ?? false;
    if (matchLive) {
      matchActive = true;
      showMatchHud();
    } else {
      matchActive = false;
      view.clearCars();
      showLobby();
    }
    el("lobby-code").textContent = code;
    const ul = el("player-list") as HTMLUListElement;
    ul.innerHTML = "";
    for (const p of players) {
      const li = document.createElement("li");
      const side = p.team === "blue" ? "Blue" : "Orange";
      const on = p.online ? "" : " (offline)";
      li.textContent = `${p.name}${on} — ${side}${p.ready ? " ✓" : ""}${p.isHost ? " · host" : ""}`;
      ul.appendChild(li);
    }
    (el("team") as HTMLSelectElement).value = me?.team ?? "blue";
    el("btn-start").classList.toggle("hidden", !isHost);
    el("lobby-msg").textContent = isHost ? "Ready up → Start match (invite friends via room code)" : "Waiting for host to start…";
    if (!matchLive) {
      ready = false;
      (el("btn-ready") as HTMLButtonElement).textContent = "Ready";
    }
  });

  socket.on("snapshot", (snap) => {
    if (!matchActive) {
      matchActive = true;
      showMatchHud();
    }
    view.pushSnapshot(snap);
    el("score").textContent = `${snap.scores.blue} — ${snap.scores.orange}`;
    el("timer").textContent = fmtTime(snap.matchSecondsRemaining);
    const me = playerId ? snap.cars[playerId] : null;
    const b = me ? Math.max(0, Math.min(1, me.boost / 100)) : 0;
    lastBoostNorm = b;
    (el("boost-bar") as HTMLDivElement).style.width = `${b * 100}%`;
    if (snap.countdown !== undefined) {
      el("countdown-overlay").classList.remove("hidden");
      el("countdown-text").textContent = snap.countdown > 0 ? snap.countdown.toString() : "GO!";
    } else {
      el("countdown-overlay").classList.add("hidden");
    }

    if (snap.phase === "goal_pause") {
      el("phase-msg").textContent = "GOAL!";
    } else if (snap.phase === "ended") {
      el("phase-msg").textContent = "";
      el("end-screen").classList.remove("hidden");
      const { blue, orange } = snap.scores;
      const win = blue === orange ? "Draw" : blue > orange ? "Blue wins!" : "Orange wins!";
      el("end-title").textContent = win;
      el("end-score").textContent = `${blue} - ${orange}`;
      el("btn-rematch").classList.toggle("hidden", !isHost);
    } else {
      el("phase-msg").textContent = "";
      el("end-screen").classList.add("hidden");
    }
  });
}

function buildInput(): PlayerInput {
  const w = keys.has("w") || keys.has("W") || keys.has("ArrowUp");
  const s = keys.has("s") || keys.has("S") || keys.has("ArrowDown");
  let throttle = 0;
  if (w) throttle += 1;
  if (s) throttle -= 1;
  let steer = 0;
  if (keys.has("a") || keys.has("A") || keys.has("ArrowLeft")) steer -= 1;
  if (keys.has("d") || keys.has("D") || keys.has("ArrowRight")) steer += 1;
  return {
    throttle,
    steer,
    brake: keys.has("x") || keys.has("X"),
    jumpPressed: keys.has(" ") || keys.has("Space"),
    boost: keys.has("Shift") || keys.has("ShiftLeft") || keys.has("ShiftRight") || keys.has("z") || keys.has("Z"),
    drift: keys.has("Control") || keys.has("ControlLeft") || keys.has("ControlRight"),
  };
}

const GAME_KEYS = new Set([" ", "Shift", "Control", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

window.addEventListener("keydown", (e) => {
  // Prevent browser defaults for game keys (Space scrolls, Shift selects, etc)
  if (matchActive && GAME_KEYS.has(e.key)) e.preventDefault();
  // Store both key name and code for cross-platform reliability
  keys.add(e.key);
  keys.add(e.code); // e.g. "ShiftLeft", "ShiftRight", "Space"
  if (e.key === "c" || e.key === "C") {
    view.ballCam = !view.ballCam;
  }
  if (e.key === "r" || e.key === "R") {
    socket?.emit("resetCar");
  }
});

window.addEventListener("keyup", (e) => {
  keys.delete(e.key);
  keys.delete(e.code);
});

window.addEventListener("blur", () => {
  keys.clear();
});

setInterval(() => {
  if (!socket || !matchActive) return;
  socket.emit("input", buildInput());
}, 1000 / 30);

el("btn-create").addEventListener("click", () => {
  const name = (el("name") as HTMLInputElement).value.trim() || "Player";
  el("menu-msg").textContent = "";
  wireSocket();
  socket!.emit("createRoom", name, (res) => {
    if (!res.ok) {
      el("menu-msg").textContent = res.error ?? "Could not create room";
      socket?.disconnect();
      socket = null;
    }
  });
});

el("btn-join").addEventListener("click", () => {
  el("join-row").classList.remove("hidden");
});

el("btn-join-go").addEventListener("click", () => {
  const name = (el("name") as HTMLInputElement).value.trim() || "Player";
  const code = (el("code") as HTMLInputElement).value.trim().toUpperCase();
  el("menu-msg").textContent = "";
  wireSocket();
  socket!.emit("joinRoom", { code, name }, (res) => {
    if (!res.ok) {
      el("menu-msg").textContent = res.error ?? "Join failed";
      socket?.disconnect();
      socket = null;
    }
  });
});

el("team").addEventListener("change", () => {
  const team = (el("team") as HTMLSelectElement).value as TeamId;
  socket?.emit("setTeam", team);
});

let ready = false;
el("btn-ready").addEventListener("click", () => {
  ready = !ready;
  socket?.emit("setReady", ready);
  el("btn-ready").textContent = ready ? "Unready" : "Ready";
});

el("btn-start").addEventListener("click", () => {
  socket?.emit("startMatch");
});

el("btn-rematch")?.addEventListener("click", () => {
  el("end-screen").classList.add("hidden");
  socket?.emit("startMatch");
});

el("btn-menu")?.addEventListener("click", () => {
  socket?.disconnect();
  socket = null;
  sessionStorage.removeItem("rs_pid");
  sessionStorage.removeItem("rs_room");
  matchActive = false;
  view.clearCars();
  showMenu();
});

function tryReconnect() {
  const pid = sessionStorage.getItem("rs_pid");
  const code = sessionStorage.getItem("rs_room");
  if (!pid || !code) return;
  wireSocket();
  socket!.emit("reconnect", { code, playerId: pid }, (res) => {
    if (!res.ok) {
      socket?.disconnect();
      socket = null;
      sessionStorage.removeItem("rs_pid");
      sessionStorage.removeItem("rs_room");
    }
  });
}

tryReconnect();

view.startLoop(
  () => playerId,
  () => lastBoostNorm,
);

showMenu();
