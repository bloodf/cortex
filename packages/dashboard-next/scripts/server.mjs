#!/usr/bin/env node
/** Core loopback ingress: dashboard HTTP and authenticated terminal WebSocket share one origin. */
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3080);
const applicationPort = Number(process.env.CORTEX_DASHBOARD_INTERNAL_PORT || 3082);
const terminalPort = Number(process.env.TERMINAL_PORT || 3081);
if (host !== "127.0.0.1" && host !== "::1") throw new Error("Core ingress must bind loopback; use a selected private reverse proxy for remote access");
if ([port, applicationPort, terminalPort].some((value) => !Number.isInteger(value) || value < 1024 || value > 65535) || new Set([port, applicationPort, terminalPort]).size !== 3) throw new Error("Dashboard, application and terminal ports must be distinct valid unprivileged ports");
const application = spawn(process.execPath, [fileURLToPath(new URL("../.output/server/index.mjs", import.meta.url))], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(applicationPort), NITRO_HOST: "127.0.0.1", NITRO_PORT: String(applicationPort) },
  stdio: "inherit",
});
const connections = new Set();
let stopping = false;

function headersFor(request) {
  const headers = { ...request.headers };
  // Never turn a caller-controlled forwarded address into a trusted identity.
  delete headers.forwarded;
  delete headers["x-forwarded-for"];
  delete headers["x-real-ip"];
  headers["x-real-ip"] = request.socket.remoteAddress || "127.0.0.1";
  return headers;
}

const server = http.createServer((request, response) => {
  const upstream = http.request({ hostname: "127.0.0.1", port: applicationPort, path: request.url, method: request.method, headers: headersFor(request) }, (incoming) => {
    response.writeHead(incoming.statusCode || 502, incoming.headers);
    incoming.pipe(response);
    incoming.on("error", () => response.destroy());
  });
  upstream.on("error", () => {
    if (response.headersSent) response.destroy();
    else {
      response.writeHead(502, { "content-type": "text/plain", "cache-control": "no-store" });
      response.end("Dashboard runtime unavailable\n");
    }
  });
  request.on("aborted", () => upstream.destroy());
  response.on("close", () => {
    if (!response.writableFinished) upstream.destroy();
  });
  request.pipe(upstream);
});
server.on("connection", (socket) => {
  connections.add(socket);
  socket.on("close", () => connections.delete(socket));
});
server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/terminal/ws") {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  // Cookie, Origin and upgrade headers reach the sidecar unchanged. It owns
  // session, live OS membership and origin checks before spawning a shell.
  const upstream = http.request({ hostname: "127.0.0.1", port: terminalPort, path: "/terminal/ws", method: "GET", headers: headersFor(request) });
  upstream.on("upgrade", (incoming, remote, upstreamHead) => {
    let handshake = `HTTP/1.1 ${incoming.statusCode} ${incoming.statusMessage}\r\n`;
    for (let index = 0; index < incoming.rawHeaders.length; index += 2) handshake += `${incoming.rawHeaders[index]}: ${incoming.rawHeaders[index + 1]}\r\n`;
    socket.write(`${handshake}\r\n`);
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) remote.write(head);
    remote.on("error", () => socket.destroy());
    socket.on("error", () => remote.destroy());
    remote.on("close", () => socket.destroy());
    socket.on("close", () => remote.destroy());
    socket.pipe(remote).pipe(socket);
  });
  upstream.on("response", (incoming) => {
    incoming.resume();
    socket.end(`HTTP/1.1 ${incoming.statusCode || 502} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  });
  upstream.on("error", () => {
    if (!socket.destroyed) socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
  upstream.end();
});

function stop(code) {
  if (stopping) return;
  stopping = true;
  server.close();
  for (const socket of connections) socket.destroy();
  application.kill("SIGTERM");
  const deadline = setTimeout(() => {
    application.kill("SIGKILL");
    process.exit(code);
  }, 5000);
  application.once("exit", () => {
    clearTimeout(deadline);
    process.exit(code);
  });
  if (application.exitCode !== null || application.signalCode !== null) {
    clearTimeout(deadline);
    process.exit(code);
  }
}
application.on("error", (error) => {
  console.error(`Dashboard process failed: ${error.message}`);
  stop(1);
});
application.on("exit", (code, signal) => {
  if (!stopping) {
    console.error(`Dashboard process exited (${signal || code})`);
    stop(code || 1);
  }
});
server.on("error", (error) => {
  console.error(`Core ingress failed: ${error.message}`);
  stop(1);
});
process.on("SIGTERM", () => stop(0));
process.on("SIGINT", () => stop(0));
server.listen(port, host, () => console.info(`Cortex core ingress listening on http://${host}:${port}`));
