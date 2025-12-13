#!/usr/bin/env npx ts-node
/**
 * Quick script to test the analyzer on local files.
 *
 * Usage:
 *   npx ts-node scripts/test-analyzer.ts [directory]
 *   npx ts-node scripts/test-analyzer.ts src/integrations/llm
 */

import * as fs from "fs";
import * as path from "path";
import { analyzeRepository, BASELINE_SCAN_RULES } from "../src/analysis/baseline";

function walkDir(dir: string, fileList: string[] = []): string[] {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filepath = path.join(dir, file);
    const stat = fs.statSync(filepath);
    if (stat.isDirectory()) {
      if (!file.startsWith(".") && file !== "node_modules" && file !== "dist") {
        walkDir(filepath, fileList);
      }
    } else {
      fileList.push(filepath);
    }
  }
  return fileList;
}

const targetDir = process.argv[2] || "src";
console.log(`\n📂 Analyzing: ${targetDir}\n`);

const files = walkDir(targetDir);
const fileContents = new Map<string, string>();

for (const file of files) {
  try {
    fileContents.set(file, fs.readFileSync(file, "utf-8"));
  } catch {
    // Skip unreadable files
  }
}

console.log(`Found ${fileContents.size} files\n`);

const result = analyzeRepository(fileContents, {
  rulesToCheck: BASELINE_SCAN_RULES,
});

console.log(`✅ Files analyzed: ${result.filesAnalyzed}`);
console.log(`⏭️  Files skipped: ${result.filesSkipped}`);
console.log(`🔍 Total findings: ${result.findings.length}\n`);

// Group findings by rule
const byRule = new Map<string, typeof result.findings>();
for (const f of result.findings) {
  const list = byRule.get(f.kind) || [];
  list.push(f);
  byRule.set(f.kind, list);
}

for (const [rule, findings] of byRule) {
  console.log(`\n📌 ${rule} (${findings.length} findings):`);
  for (const f of findings.slice(0, 5)) {
    console.log(`   ${f.file}:${f.line} - ${f.message.slice(0, 60)}...`);
  }
  if (findings.length > 5) {
    console.log(`   ... and ${findings.length - 5} more`);
  }
}
