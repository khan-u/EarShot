"use strict";
// Read-only historical comparison. Run with the source checkout as the sole
// argument. Output records repository-relative names and hashes, never that path.
const fs = require("node:fs"), { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto"), ts = require("typescript");
function main() {
const source = process.argv[2];
if (!source) throw new Error("supply the source checkout as the argument");
const commit = "0106096d9b4b0bb6e8f670f237b646622bd0d425";
const git = (...args) => execFileSync("git", ["--no-optional-locks", "-C", source, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const sha = text => createHash("sha256").update(text).digest("hex");
const files = ["osrs/Game.ts", "osrs/voice/VoiceRTC.ts", "osrs/voice/VoiceMetrics.ts", "osrs/voice/SensorNode.ts"];
function methods(text) {
    const tree = ts.createSourceFile("source.ts", text, ts.ScriptTarget.Latest, true);
    const klass = tree.statements.find(s => ts.isClassDeclaration(s) && s.name?.text === "VoiceRTC");
    const result = {};
    for (const member of klass.members) {
        if (!ts.isMethodDeclaration(member) || !member.body) continue;
        const name = member.name.getText(tree);
        // Compare method bodies after TypeScript erasure and trivia removal;
        // this is narrower than claiming full behavioral equivalence.
        const js = ts.transpileModule(member.body.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2020, removeComments: true } }).outputText;
        const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, js);
        const tokens = [];
        while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) tokens.push(scanner.getToken() === ts.SyntaxKind.StringLiteral ? JSON.stringify(scanner.getTokenValue()) : scanner.getTokenText());
        result[name] = sha(tokens.join(" "));
    }
    return result;
}
const sourceText = git("show", commit + ":osrs/voice/VoiceRTC.ts");
const artifactText = execFileSync("git", ["show", "ea7d2c6:voice/VoiceRTC.ts"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const a = methods(sourceText), b = methods(artifactText);
const report = {
    schemaVersion: 1, sourceRepository: "ts-client", sourceSnapshot: commit,
    snapshotCommitTime: git("show", "-s", "--format=%cI", commit).trim(),
    voiceCheckpoint: git("log", "-1", "--format=%H", commit, "--", "osrs/voice/VoiceRTC.ts").trim(),
    earshotArtifact: "ea7d2c6a6d880a1c41d97e4ca533b17441202c93",
    confirmedDeployedBuild: null,
    status: "source candidate supported by checkout history; browser bundle identity is unrecorded",
    sourceFiles: Object.fromEntries(files.map(name => { const text = git("show", commit + ":" + name); return [name, { sha256: sha(text), gitBlob: git("rev-parse", commit + ":" + name).trim() }]; })),
    voiceMethodsWithMatchingErasedBodyTokens: Object.keys(b).filter(name => a[name] === b[name]),
    voiceMethodsWithDifferentBodies: Object.keys(b).filter(name => a[name] !== b[name]),
    earlierCollection: { dates: ["2026-08-11", "2026-08-12"],
        lastRetainedCheckout: "838e0e2265d9bc450cba23b6fd7e319012030c42",
        limitation: "VoiceMetrics and SensorNode first appear in retained history on August 16; earlier working-tree contents and deployed bundles cannot be recovered from these commit dates." },
};
fs.writeFileSync("client/provenance.json", JSON.stringify(report, null, 2) + "\n");
console.log("Historical comparison recorded; matching method bodies: " + report.voiceMethodsWithMatchingErasedBodyTokens.length);

}
try { main(); } catch { console.error("Historical comparison failed; verify the source checkout and requested Git objects."); process.exitCode = 1; }
