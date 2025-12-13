import { analyzeFileContent } from "../src/analysis/detectors/file";

// Test: The old comment with "eval()" should trigger UNSAFE_EVAL
const oldContent = `
export const SIMPLE_RULES = new Set([
  "UNSAFE_EVAL",          // Direct eval() detection
]);
`;

// Test: The new comment without "eval()" should NOT trigger
const newContent = `
export const SIMPLE_RULES = new Set([
  "UNSAFE_EVAL",          // Dynamic code execution detection
]);
`;

console.log("Testing old comment pattern:");
const oldFindings = analyzeFileContent("test.ts", oldContent, {
  rulesToCheck: new Set(["UNSAFE_EVAL"])
});
console.log("  Findings:", oldFindings.length);
for (const f of oldFindings) {
  console.log("    Line " + f.line + ": " + f.snippet);
}

console.log("\nTesting new comment pattern:");
const newFindings = analyzeFileContent("test.ts", newContent, {
  rulesToCheck: new Set(["UNSAFE_EVAL"])
});
console.log("  Findings:", newFindings.length);
