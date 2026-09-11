// Local-only fixture run with native Node. stdin contains generated test TLS
// material; stdout reports protocol boundaries, never real provider traffic.
import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { createConnection } from "node:net";

if (process.versions.bun) throw new Error("This network fixture requires native Node");
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const config = JSON.parse(raw);
const counts = { connects: 0, requests: 0, connections: 0, closedConnections: 0 };
const publish = (event, details = {}) => process.stdout.write(`${JSON.stringify({ event, ...counts, ...details })}\n`);
const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});

const backend = createHttpsServer({ cert: config.cert, key: config.key }, (request, response) => {
  counts.requests++;
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    publish("request", { method: request.method, authorization: request.headers.authorization, proxyAuthorization: request.headers["proxy-authorization"], body });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "proxied-job" }));
  });
});
backend.on("connection", (socket) => {
  counts.connections++;
  publish("backend_connection");
  socket.once("close", () => { counts.closedConnections++; publish("backend_close"); });
});
backend.on("secureConnection", () => publish("backend_tls"));
backend.on("tlsClientError", (error) => publish("backend_tls_error", { code: error.code }));
const targetPort = await listen(backend);

const proxy = createHttpServer();
proxy.on("connect", (request, socket, head) => {
  counts.connects++;
  publish("connect", { method: request.method, headers: request.headers, headBytes: head.length });
  const upstream = createConnection({ host: "127.0.0.1", port: targetPort }, () => {
    publish("proxy_target_connected");
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    socket.pipe(upstream); upstream.pipe(socket);
    socket.once("data", (chunk) => publish("proxy_client_data", { bytes: chunk.length }));
    upstream.once("data", (chunk) => publish("proxy_target_data", { bytes: chunk.length }));
  });
  socket.once("error", (error) => { publish("proxy_client_error", { code: error.code }); upstream.destroy(); });
  upstream.once("error", (error) => { publish("proxy_target_error", { code: error.code }); socket.destroy(); });
});
const proxyPort = await listen(proxy);
publish("listening", { targetPort, proxyPort, nodeVersion: process.versions.node });
