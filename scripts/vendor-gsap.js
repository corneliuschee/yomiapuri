// Keep the offline browser build identical to the version pinned in package-lock.json.
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const destination = path.join(root, "src/frontend/vendor/gsap");
await mkdir(destination, { recursive: true });
await copyFile(path.join(root, "node_modules/gsap/dist/gsap.min.js"), path.join(destination, "gsap.min.js"));
console.log("Updated local GSAP browser build.");
