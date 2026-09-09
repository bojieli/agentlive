import { createInterface } from "node:readline";
const mode = process.argv[2];
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
if (mode === "oversized") process.stdout.write("x".repeat(2000));
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === "echo")
    send({ id: message.id, result: message.params });
  if (message.method === "notify") {
    send({ method: "event", params: { text: "first" } });
    send({ method: "event", params: { text: "second" } });
    send({ id: message.id, result: true });
  }
  if (message.method === "unicode") {
    const bytes = Buffer.from(
      JSON.stringify({ method: "event", params: { text: "海🦦" } }) + "\n",
    );
    for (const byte of bytes) process.stdout.write(Buffer.from([byte]));
    send({ id: message.id, result: true });
  }
  if (message.method === "ask")
    send({ id: "operator", method: "approval", params: {} });
  if (message.id === "operator")
    send({ id: 1, result: message.error?.code ?? message.result });
}
