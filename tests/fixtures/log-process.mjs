import { open } from "node:fs/promises";
import { JsonlLog } from "../../packages/storage/dist/index.js";
const [path, mode] = process.argv.slice(2);
const log = await JsonlLog.open(path, { parse: (value) => value });
await log.append([{ text: "durably captured before process death" }]);
if (mode === "torn") {
  await log.close();
  const file = await open(path, "a");
  await file.write('{"sequence":2,"value":');
  await file.sync();
}
process.send({ committed: log.boundary.sequence }, () =>
  process.kill(process.pid, "SIGKILL"),
);
