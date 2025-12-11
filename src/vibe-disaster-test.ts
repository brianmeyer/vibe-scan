/**
 * VIBE DISASTER TEST FILE
 *
 * This file intentionally contains every type of production risk pattern
 * that Vibe Scan should detect. Use this to verify the scanner is working.
 *
 * Expected findings:
 * - STATEFUL_SERVICE: in-memory cache (line ~15)
 * - PROTOTYPE_INFRA: sqlite3 usage (line ~20)
 * - UNSAFE_EVAL: eval() call (line ~38)
 * - HARDCODED_SECRET: API keys (line ~25)
 * - HARDCODED_URL: localhost URLs (line ~28)
 * - UNBOUNDED_QUERY: findMany without limit (line ~45)
 * - UNSAFE_IO: fetch without try/catch (line ~52)
 * - LOOPED_IO: database call in loop (line ~58)
 * - SILENT_ERROR: empty catch block (line ~66)
 * - GLOBAL_MUTATION: module-level mutable state (line ~10)
 */

// GLOBAL_MUTATION: Module-level mutable state
let requestCount = 0;
const cache = new Map<string, unknown>();

// STATEFUL_SERVICE: In-memory state that breaks horizontal scaling
class RateLimiter {
  private requests = new Map<string, number[]>();

  check(ip: string): boolean {
    const timestamps = this.requests.get(ip) || [];
    return timestamps.length < 100;
  }
}

// PROTOTYPE_INFRA: SQLite - won't scale in production
const sqlite3 = require("sqlite3");
const db = new sqlite3.Database("./app.db");

// HARDCODED_SECRET: Credentials in code
const API_KEY = "my_secret_api_key_do_not_commit_this";
const DATABASE_PASSWORD = "super_secret_password_123";

// HARDCODED_URL: Development URLs that will break in production
const API_URL = "http://localhost:3000/api";
const WS_URL = "ws://127.0.0.1:8080/socket";

// UNSAFE_EVAL: Dangerous code execution
function runUserCode(code: string): unknown {
  // This is extremely dangerous!
  return eval(code);
}

// Also dangerous: new Function
function createDynamicFunction(body: string) {
  return new Function("x", body);
}

// UNBOUNDED_QUERY: No limit on database query
async function getAllUsers() {
  const users = await db.users.findMany();
  return users;
}

// Also unbounded: raw SQL
async function getEverything() {
  return await db.query("SELECT * FROM users");
}

// UNSAFE_IO: Network call without error handling
async function fetchData(url: string) {
  const response = await fetch(url);
  return response.json();
}

// LOOPED_IO: Database/network calls inside loops
async function processItems(items: string[]) {
  const results = [];
  for (const item of items) {
    // N+1 query pattern - very bad for performance
    const data = await fetch(`/api/items/${item}`);
    results.push(await data.json());
  }
  return results;
}

// SILENT_ERROR: Swallowing errors
async function riskyOperation() {
  try {
    await fetch("/api/risky");
  } catch (e) {
    // Swallowed! No logging, no rethrow
  }
}

// Another silent error pattern
function handleError(promise: Promise<unknown>) {
  promise.catch(() => {
    // Silently ignored
  });
}

// MEMORY_RISK: Loading entire file into memory
import * as fs from "fs";
function loadBigFile(path: string) {
  const content = fs.readFileSync(path);
  return JSON.parse(content.toString());
}

// CHECK_THEN_ACT_RACE: Find then create race condition
async function getOrCreateUser(email: string) {
  const existing = await db.users.findFirst({ where: { email } });
  if (!existing) {
    // Race condition: another request could create user between check and create
    return await db.users.create({ data: { email } });
  }
  return existing;
}

// BLOCKING_OPERATION: Synchronous operations that block event loop
function blockingRead(path: string) {
  return fs.readFileSync(path, "utf8");
}

// Export to make this a valid module
export {
  RateLimiter,
  runUserCode,
  getAllUsers,
  fetchData,
  processItems,
  riskyOperation,
  loadBigFile,
  getOrCreateUser,
};
