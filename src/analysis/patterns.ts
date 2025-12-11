/**
 * Pattern constants for static analysis detection rules.
 *
 * These patterns are used by the analyzer to detect various code quality,
 * scaling, and concurrency issues in pull request patches.
 *
 * Patterns can be either:
 * - string: Simple substring matching (legacy, for backward compatibility)
 * - RegExp: Flexible matching with whitespace tolerance
 *
 * Use the matchesPattern() helper to check content against patterns.
 */

// Maximum findings per file to avoid overwhelming output
export const MAX_FINDINGS_PER_FILE = 50;

// Code file extensions we care about
export const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rb", ".java", ".cs"];

// Pattern type that supports both string and RegExp
export type Pattern = string | RegExp;

/**
 * Check if content matches a pattern (string or RegExp).
 * For strings, uses includes(). For RegExp, uses test().
 */
export function matchesPattern(content: string, pattern: Pattern): boolean {
  if (typeof pattern === "string") {
    return content.includes(pattern);
  }
  return pattern.test(content);
}

/**
 * Check if content matches any pattern in the array.
 */
export function matchesAnyPattern(content: string, patterns: Pattern[]): boolean {
  return patterns.some((pattern) => matchesPattern(content, pattern));
}

// ============================================================================
// General Patterns
// ============================================================================

// Patterns for I/O operations that should have error handling
// Includes TypeScript/JavaScript and Python patterns
export const IO_PATTERNS: Pattern[] = [
  // JavaScript/TypeScript
  /fetch\s*\(/,
  /axios\s*\./,
  /axios\s*\(/,
  /request\s*\(/,
  /fs\s*\./,
  /client\s*\.\s*query\s*\(/,
  /db\s*\./,
  /execute\s*\(/,
  /prisma\s*\./,
  /mongoose\s*\./,
  /redis\s*\./,
  /http\s*\./,
  /https\s*\./,
  /net\s*\./,
  /dgram\s*\./,
  // Python
  /requests\s*\.\s*(?:get|post|put|delete|patch|head|options)\s*\(/,
  /urllib\s*\./,
  /httpx\s*\./,
  /aiohttp\s*\./,
  /open\s*\(/,
  /cursor\s*\.\s*execute\s*\(/,
  /session\s*\.\s*(?:query|execute)\s*\(/,
];

// Patterns that indicate error handling is present
export const ERROR_HANDLING_PATTERNS: Pattern[] = [
  "try",
  "catch",
  ".catch(",
  // Python
  "except",
  "except:",
  "finally:",
];

// Debug logging patterns
export const DEBUG_PATTERNS: Pattern[] = [
  "console.log",
  "console.error",
  "console.warn",
  "console.debug",
  // Python
  /print\s*\(/,
  /logging\s*\.\s*(?:debug|info|warning|error)\s*\(/,
  /logger\s*\.\s*(?:debug|info|warning|error)\s*\(/,
];

// Validation library patterns
export const VALIDATION_PATTERNS: Pattern[] = [
  "zod",
  "yup",
  "Joi",
  "joi",
  "schema",
  "validate",
  "class-validator",
  "io-ts",
  "ajv",
  "validator",
  "sanitize",
  "parse",
  "safeParse",
  // Python
  "pydantic",
  "marshmallow",
  "cerberus",
  "voluptuous",
];

// Request input patterns
export const REQUEST_INPUT_PATTERNS: Pattern[] = [
  // Express/Node
  "req.body",
  "req.query",
  "req.params",
  "request.body",
  "request.query",
  "request.params",
  // Flask/Django
  "request.json",
  "request.form",
  "request.args",
  "request.data",
  "request.GET",
  "request.POST",
];

// Route handler patterns
export const ROUTE_HANDLER_PATTERNS: Pattern[] = [
  // Express
  /app\s*\.\s*(?:get|post|put|patch|delete)\s*\(/,
  /router\s*\.\s*(?:get|post|put|patch|delete)\s*\(/,
  "express.Router",
  // Flask
  /@app\s*\.\s*route\s*\(/,
  /@blueprint\s*\.\s*route\s*\(/,
  // FastAPI
  /@app\s*\.\s*(?:get|post|put|patch|delete)\s*\(/,
  /@router\s*\.\s*(?:get|post|put|patch|delete)\s*\(/,
  // Django
  /def\s+\w+\s*\(\s*request/,
];

// Loop patterns
export const LOOP_PATTERNS: Pattern[] = [
  // JavaScript/TypeScript
  /for\s*\(/,
  /for\s+await\s*\(/,
  /while\s*\(/,
  /\.forEach\s*\(/,
  /\.map\s*\(/,
  /\.reduce\s*\(/,
  // Python
  /for\s+\w+\s+in\s+/,
  /while\s+\w+/,
  /async\s+for\s+/,
];

// Async patterns
export const ASYNC_PATTERNS: Pattern[] = [
  // JavaScript/TypeScript
  /async\s+function/,
  /async\s*\(/,
  // Python
  /async\s+def\s+/,
  /await\s+/,
];

// ============================================================================
// Scaling-focused pattern constants
// ============================================================================

// Database/ORM query patterns that may be unbounded
export const DB_QUERY_PATTERNS: Pattern[] = [
  // SQL
  /SELECT\s+\*/i,
  /SELECT\s+\*\s+FROM/i,
  // JavaScript/TypeScript ORMs
  /\.findMany\s*\(/,
  /\.find\s*\(/,
  /\.findAll\s*\(/,
  /Model\s*\.\s*find\s*\(/,
  /Model\s*\.\s*findAll\s*\(/,
  /\.aggregate\s*\(/,
  /\.query\s*\(/,
  /prisma\s*\./,
  /db\s*\.\s*select\s*\(/,
  /db\s*\.\s*query\s*\(/,
  /\.collection\s*\(/,
  /\.getAll\s*\(/,
  // Python SQLAlchemy (require ORM context to avoid matching JS Array.filter)
  /\.query\s*\(\s*\w+\s*\)/,
  /session\s*\.\s*query\s*\(/,
  /\.query\s*\([^)]*\)\s*\.filter\s*\(/, // session.query(Model).filter()
  /\.filter_by\s*\(/, // SQLAlchemy-specific (JS doesn't have filter_by)
  /\.all\s*\(\s*\)/, // .all() is typically ORM
  // Django ORM
  /\.objects\s*\.\s*(?:all|filter|exclude)\s*\(/,
  /QuerySet/,
];

// Pagination/limit indicators that suggest bounded queries
export const PAGINATION_PATTERNS: Pattern[] = [
  /\.limit\s*\(/,
  /\.take\s*\(/,
  /\.skip\s*\(/,
  /\.offset\s*\(/,
  /\.page\s*\(/,
  /\.perPage\s*\(/,
  /LIMIT\s+\d/i,
  /OFFSET\s+\d/i,
  /TOP\s+\d/i,
  /FETCH\s+FIRST/i,
  "pageSize",
  "pagination",
  /\.slice\s*\(/,
  /\.paginate\s*\(/,
  // Python
  /\[\s*:\s*\d+\s*\]/,  // Slice notation [:10]
  /\.first\s*\(\s*\)/,
  /\.one\s*\(\s*\)/,
];

// Collection processing patterns
export const COLLECTION_PROCESSING_PATTERNS: Pattern[] = [
  /\.map\s*\(/,
  /\.filter\s*\(/,
  /\.reduce\s*\(/,
  /\.forEach\s*\(/,
  /for\s*\(/,
  /for\s+of\b/,
  /for\s+await\b/,
  // Python
  /for\s+\w+\s+in\s+/,
  /\[\s*\w+\s+for\s+/,  // List comprehension
];

// Batching indicators
export const BATCHING_PATTERNS: Pattern[] = [
  /Promise\s*\.\s*all\s*\(/,
  /Promise\s*\.\s*allSettled\s*\(/,
  "chunk",
  "batch",
  "pageSize",
  "batchSize",
  "bulkWrite",
  "bulkInsert",
  "insertMany",
  "createMany",
  "$transaction",
  // Python
  "bulk_create",
  "bulk_update",
  "executemany",
  /asyncio\s*\.\s*gather\s*\(/,
];

// Memory-risky patterns (loading entire files/datasets into memory)
export const MEMORY_RISK_PATTERNS: Pattern[] = [
  // JavaScript/TypeScript
  /fs\s*\.\s*readFileSync\s*\(/,
  /readFileSync\s*\(/,
  /\.readFile\s*\(/,
  /JSON\s*\.\s*parse\s*\(\s*fs\s*\./,
  /\.toString\s*\(\s*\)/,
  /Buffer\s*\.\s*from\s*\(/,
  /\.getObject\s*\(/,
  /\.download\s*\(/,
  /\.toArray\s*\(\s*\)/,
  // Python
  /\.read\s*\(\s*\)/,
  /\.readlines\s*\(\s*\)/,
  /json\s*\.\s*load\s*\(/,
  /pickle\s*\.\s*load\s*\(/,
  /list\s*\(\s*\w+\s*\)/,  // list(iterator)
];

// External API call patterns for caching detection
export const EXTERNAL_CALL_PATTERNS: Pattern[] = [
  /fetch\s*\(/,
  /axios\s*\.\s*(?:get|post|put|delete)\s*\(/,
  /axios\s*\(/,
  /http\s*\.\s*get\s*\(/,
  /https\s*\.\s*get\s*\(/,
  /request\s*\(/,
  /got\s*\(/,
  "superagent",
  // Python
  /requests\s*\.\s*(?:get|post|put|delete)\s*\(/,
  /httpx\s*\.\s*(?:get|post|put|delete)\s*\(/,
];

// ============================================================================
// Concurrency/Contention pattern constants
// ============================================================================

// File write patterns (for SHARED_FILE_WRITE detection)
export const FILE_WRITE_PATTERNS: Pattern[] = [
  /fs\s*\.\s*writeFile\s*\(/,
  /fs\s*\.\s*writeFileSync\s*\(/,
  /fs\s*\.\s*appendFile\s*\(/,
  /fs\s*\.\s*appendFileSync\s*\(/,
  /writeFile\s*\(/,
  /writeFileSync\s*\(/,
  /appendFile\s*\(/,
  /appendFileSync\s*\(/,
  // Python
  /open\s*\([^)]*['"][wa]['"][^)]*\)/,  // open(..., 'w') or open(..., 'a')
  /\.write\s*\(/,
];

// Retry-related patterns
export const RETRY_PATTERNS: Pattern[] = [
  /retry/i,
  /retries/i,
  /maxRetries/i,
  /numRetries/i,
  /attempt/i,
  /attempts/i,
  // Python
  /tenacity/i,
  /backoff/i,
];

// Backoff/jitter patterns that mitigate retry storms
export const BACKOFF_PATTERNS: Pattern[] = [
  /backoff/i,
  /exponential/i,
  /jitter/i,
  "setTimeout",
  /sleep\s*\(/,
  /wait\s*\(/,
  // Python
  /time\s*\.\s*sleep\s*\(/,
  /asyncio\s*\.\s*sleep\s*\(/,
];

// Tight loop patterns (for BUSY_WAIT_OR_TIGHT_LOOP detection)
export const TIGHT_LOOP_PATTERNS: Pattern[] = [
  /while\s*\(\s*true\s*\)/i,
  /while\s*\(\s*1\s*\)/,
  /for\s*\(\s*;\s*;\s*\)/,
  // Python
  /while\s+True\s*:/,
  /while\s+1\s*:/,
];

// Check-then-act patterns (find/get followed by create/insert)
export const CHECK_PATTERNS: Pattern[] = [
  /\.findOne\s*\(/,
  /\.findUnique\s*\(/,
  /\.findFirst\s*\(/,
  /\.get\s*\(/,
  /\.getOne\s*\(/,
  /SELECT\s+.*\s+WHERE/i,
  /\.exists\s*\(/,
  // Python
  /\.first\s*\(\s*\)/,
  /\.get_or_none\s*\(/,
  /\.filter\s*\([^)]+\)\s*\.first\s*\(/,
];

export const ACT_PATTERNS: Pattern[] = [
  /\.create\s*\(/,
  /\.insert\s*\(/,
  /\.insertOne\s*\(/,
  /INSERT\s+INTO/i,
  /\.save\s*\(/,
  /\.add\s*\(/,
  // Python
  /\.objects\s*\.\s*create\s*\(/,
  /session\s*\.\s*add\s*\(/,
];

// ============================================================================
// Security pattern constants
// ============================================================================

// Hardcoded secret patterns (for HARDCODED_SECRET detection)
export const SECRET_PATTERNS: Pattern[] = [
  // Generic key/token/secret assignments with high-entropy values
  /(?:api[_-]?key|apikey|secret[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key|password|passwd|pwd)\s*[:=]\s*['"`][a-zA-Z0-9_\-]{20,}['"`]/i,
  // AWS keys
  /(?:AWS|aws)[_-]?(?:ACCESS|SECRET)[_-]?(?:KEY|ID)\s*[:=]\s*['"`][A-Z0-9]{16,}['"`]/,
  /AKIA[0-9A-Z]{16}/,  // AWS Access Key ID pattern
  // Generic token patterns
  /(?:bearer|token|auth)\s*[:=]\s*['"`][a-zA-Z0-9_\-\.]{20,}['"`]/i,
  // Database connection strings with credentials
  /(?:mongodb|postgres|mysql|redis):\/\/[^:]+:[^@]+@/i,
  // GitHub/GitLab tokens
  /gh[pousr]_[a-zA-Z0-9]{36,}/,  // GitHub tokens
  /glpat-[a-zA-Z0-9\-]{20,}/,    // GitLab tokens
  // Stripe keys
  /sk_(?:live|test)_[a-zA-Z0-9]{24,}/,
  /pk_(?:live|test)_[a-zA-Z0-9]{24,}/,
  // Python specific
  /(?:SECRET_KEY|API_KEY|AUTH_TOKEN)\s*=\s*['"][a-zA-Z0-9_\-]{20,}['"]/,
];

// ============================================================================
// Blocking operation pattern constants
// ============================================================================

// Blocking/synchronous patterns (for BLOCKING_OPERATION detection)
export const BLOCKING_PATTERNS: Pattern[] = [
  // Node.js fs sync operations
  /fs\s*\.\s*readFileSync\s*\(/,
  /fs\s*\.\s*writeFileSync\s*\(/,
  /fs\s*\.\s*appendFileSync\s*\(/,
  /fs\s*\.\s*existsSync\s*\(/,
  /fs\s*\.\s*mkdirSync\s*\(/,
  /fs\s*\.\s*readdirSync\s*\(/,
  /fs\s*\.\s*statSync\s*\(/,
  /fs\s*\.\s*unlinkSync\s*\(/,
  /fs\s*\.\s*copyFileSync\s*\(/,
  /readFileSync\s*\(/,
  /writeFileSync\s*\(/,
  // Node.js child_process sync operations
  /execSync\s*\(/,
  /spawnSync\s*\(/,
  /execFileSync\s*\(/,
  // Node.js crypto sync operations (CPU-intensive)
  /crypto\s*\.\s*pbkdf2Sync\s*\(/,
  /crypto\s*\.\s*scryptSync\s*\(/,
  /crypto\s*\.\s*randomFillSync\s*\(/,
  // Python blocking patterns (in async context)
  /time\s*\.\s*sleep\s*\(/,  // In async code, should use asyncio.sleep
];

// ============================================================================
// Architecture pattern constants (horizontal scaling killers)
// ============================================================================

// Stateful service patterns - in-memory storage that kills horizontal scaling
// These patterns indicate storing state in memory that won't be shared across instances
export const STATEFUL_SERVICE_PATTERNS: Pattern[] = [
  // JavaScript/TypeScript class property assignments with in-memory storage
  /this\s*\.\s*\w+\s*=\s*new\s+Map\s*\(/,
  /this\s*\.\s*\w+\s*=\s*new\s+Set\s*\(/,
  /this\s*\.\s*\w+\s*=\s*new\s+WeakMap\s*\(/,
  /this\s*\.\s*\w+\s*=\s*new\s+WeakSet\s*\(/,
  /this\s*\.\s*\w+\s*=\s*\[\s*\]/,  // this.items = []
  /this\s*\.\s*\w+\s*=\s*\{\s*\}/,  // this.cache = {}
  // Common stateful property names
  /this\s*\.\s*(?:cache|store|storage|sessions|activeConnections|listeners|handlers|subscribers|queue|messageQueue|taskQueue|pending|jobs)\s*=/i,
  // Module-level state that persists across requests
  /^(?:const|let|var)\s+(?:cache|store|sessions|connections|listeners|handlers|queue|messageQueue)\s*=\s*(?:new\s+(?:Map|Set)|{}|\[\])/,
  // Python class-level stateful attributes
  /self\s*\.\s*\w+\s*=\s*(?:dict\s*\(\s*\)|set\s*\(\s*\)|\[\s*\]|\{\s*\})/,
  /self\s*\.\s*(?:cache|store|sessions|connections|listeners|handlers|queue|message_queue)\s*=/i,
  // Go package-level maps (state)
  /^var\s+\w+\s*=\s*make\s*\(\s*map\s*\[/,
  /^var\s+\w+\s+map\s*\[/,
];

// Prototype infrastructure patterns - "toy" infra that won't work in cloud/containers
export const PROTOTYPE_INFRA_PATTERNS: Pattern[] = [
  // SQLite (embedded database - no concurrent access, no distributed deployment)
  /require\s*\(\s*['"]sqlite3['"]\s*\)/,
  /require\s*\(\s*['"]better-sqlite3['"]\s*\)/,
  /import\s+.*\s+from\s+['"]sqlite3['"]/,
  /import\s+.*\s+from\s+['"]better-sqlite3['"]/,
  /new\s+sqlite3\s*\.\s*Database\s*\(/,
  /new\s+Database\s*\(\s*['"][^'"]+\.(?:db|sqlite)/i,
  // LowDB (JSON file database)
  /require\s*\(\s*['"]lowdb['"]\s*\)/,
  /import\s+.*\s+from\s+['"]lowdb['"]/,
  /new\s+Low\s*\(/,
  // NeDB (another embedded database)
  /require\s*\(\s*['"]nedb['"]\s*\)/,
  /import\s+.*\s+from\s+['"]nedb['"]/,
  /new\s+Datastore\s*\(/,
  // JSON file as database (reading/writing data files)
  /JSON\s*\.\s*parse\s*\(\s*(?:fs\s*\.\s*)?readFileSync\s*\(\s*['"][^'"]+\.json['"]/,
  /(?:fs\s*\.\s*)?writeFileSync\s*\(\s*['"][^'"]+\.json['"]\s*,\s*JSON\s*\.\s*stringify/,
  // Python SQLite
  /import\s+sqlite3/,
  /sqlite3\s*\.\s*connect\s*\(/,
  // Python TinyDB
  /from\s+tinydb\s+import/,
  /TinyDB\s*\(/,
  // File-based session storage
  /session\s*:\s*{\s*secret.*store\s*:\s*.*FileStore/,
  /new\s+FileStore\s*\(/,
  // Hardcoded file paths for data storage (not just config)
  /(?:data|db|database|storage)(?:Path|File|Dir)?\s*[:=]\s*['"][./]/i,
];

// ============================================================================
// Security pattern constants
// ============================================================================

// Unsafe eval patterns - code execution vulnerabilities
export const UNSAFE_EVAL_PATTERNS: Pattern[] = [
  // JavaScript/TypeScript
  /\beval\s*\(/,
  /new\s+Function\s*\(/,
  /setTimeout\s*\(\s*['"`]/,  // setTimeout with string (not function)
  /setInterval\s*\(\s*['"`]/,  // setInterval with string (not function)
  // Python exec() - use negative lookbehind to exclude JS regex .exec() method calls
  /(?<!\.)exec\s*\(/,
  /\beval\s*\(/,
  /compile\s*\([^)]*,\s*['"]exec['"]/,
];

// Hardcoded URL patterns - should use config/env vars
export const HARDCODED_URL_PATTERNS: Pattern[] = [
  // Hardcoded localhost/127.0.0.1 (common in dev, breaks in prod)
  /['"`]https?:\/\/localhost[:/]/,
  /['"`]https?:\/\/127\.0\.0\.1[:/]/,
  /['"`]https?:\/\/0\.0\.0\.0[:/]/,
  // Hardcoded API URLs (should be configurable)
  /(?:api|service|backend)(?:Url|Endpoint|Host|Base)\s*[:=]\s*['"`]https?:\/\//i,
  // Hardcoded port numbers in URLs
  /['"`]https?:\/\/[^'"`:]+:\d{4,5}[/'"`]/,
  // Hardcoded WebSocket URLs
  /['"`]wss?:\/\/localhost/,
  /['"`]wss?:\/\/127\.0\.0\.1/,
];
