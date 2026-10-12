"use strict";
const { build, version } = require("esbuild");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs"), path = require("node:path");
const root = path.resolve(__dirname, "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const hash = data => createHash("sha256").update(data).digest("hex");
(async () => {
    const files = ["package.json", "package-lock.json", "DebugFlags.ts",
        ...fs.readdirSync(path.join(root, "voice")).filter(n => n.endsWith(".ts") && !n.endsWith(".test.ts")).map(n => "voice/" + n),
        ...fs.readdirSync(__dirname).filter(n => /\.(ts|html|css|cjs|json)$/.test(n) && !n.includes(".test.")).map(n => "client/" + n)].sort();
    const sourceHashes = Object.fromEntries(files.map(name => [name, hash(fs.readFileSync(path.join(root, name)))]));
    const identity = { schemaVersion: 1, sourceCommit: git("rev-parse", "HEAD"),
        workingTreeDirty: git("status", "--porcelain") !== "",
        toolchain: { node: process.version, esbuild: version, platform: process.platform, arch: process.arch },
        inputHashes: sourceHashes };
    const buildId = hash(JSON.stringify(identity));
    const dir = path.join(root, "client-dist"); fs.mkdirSync(dir, { recursive: true });
    await build({ absWorkingDir: root, entryPoints: ["client/main.ts"], outfile: "client-dist/client.js",
        bundle: true, format: "esm", target: ["es2020"], sourcemap: false,
        define: { __EXPERIMENT_BUILD__: JSON.stringify({ buildId, sourceCommit: identity.sourceCommit }) }, logLevel: "silent" });
    for (const file of ["index.html", "style.css"]) fs.copyFileSync(path.join(__dirname, file), path.join(dir, file));
    const assets = Object.fromEntries(["client.js", "index.html", "style.css"].map(name => [name, hash(fs.readFileSync(path.join(dir, name)))]));
    fs.writeFileSync(path.join(dir, "build.json"), JSON.stringify({ ...identity, buildId, assets }, null, 2) + "\n");
    console.log("Experimental client built: " + buildId.slice(0, 16));
})().catch(() => { console.error("Client build failed"); process.exitCode = 1; });
