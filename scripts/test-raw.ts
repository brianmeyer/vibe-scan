import { analyzeFileContent } from "../src/analysis/detectors/file";
import * as fs from "fs";

const content = fs.readFileSync("src/integrations/llm/types.ts", "utf-8");
const findings = analyzeFileContent("src/integrations/llm/types.ts", content, {
  rulesToCheck: new Set(["UNSAFE_EVAL", "UNSAFE_IO", "HARDCODED_SECRET"])
});

console.log("Raw findings (before suppression):", findings.length);
for (const f of findings) {
  console.log("  " + f.kind + " at line " + f.line + ": " + (f.snippet || "").slice(0, 50));
}
