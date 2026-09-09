import { FileLock } from "../../packages/storage/dist/index.js";
await FileLock.acquire(process.argv[2]);
process.send({ locked: true });
setInterval(() => {}, 1000);
