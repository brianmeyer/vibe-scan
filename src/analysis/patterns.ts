/**
 * Pattern constants for static analysis detection rules.
 *
 * These patterns are used by the analyzer to detect various code quality,
 * scaling, and concurrency issues in pull request patches.
 */

// Maximum findings per file to avoid overwhelming output
export const MAX_FINDINGS_PER_FILE = 50;

// Code file extensions we care about
export const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rb", ".java", ".cs"];

// ============================================================================
// General Patterns
// ============================================================================

// Patterns for I/O operations that should have error handling
export const IO_PATTERNS = [
  "fetch(",
  "axios.",
  "request(",
  "fs.",
  "client.query(",
  "db.",
  "execute(",
  "prisma.",
  "mongoose.",
  "redis.",
  "http.",
  "https.",
  "net.",
  "dgram.",
];

// Patterns that indicate error handling is present
export const ERROR_HANDLING_PATTERNS = ["try", "catch", ".catch("];

// Debug logging patterns
export const DEBUG_PATTERNS = ["console.log", "console.error", "console.warn", "console.debug", "print("];

// Validation library patterns
export const VALIDATION_PATTERNS = [
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
];

// Request input patterns
export const REQUEST_INPUT_PATTERNS = [
  "req.body",
  "req.query",
  "req.params",
  "request.body",
  "request.query",
  "request.params",
];

// Route handler patterns
export const ROUTE_HANDLER_PATTERNS = [
  "app.get(",
  "app.post(",
  "app.put(",
  "app.patch(",
  "app.delete(",
  "router.get(",
  "router.post(",
  "router.put(",
  "router.patch(",
  "router.delete(",
  "express.Router",
];

// Loop patterns
export const LOOP_PATTERNS = [
  "for (",
  "for(",
  "for await (",
  "for await(",
  "while (",
  "while(",
  ".forEach(",
  ".map(",
  ".reduce(",
];

// Async patterns
export const ASYNC_PATTERNS = ["async function", "async (", "async("];

// ============================================================================
// Scaling-focused pattern constants
// ============================================================================

// Database/ORM query patterns that may be unbounded
export const DB_QUERY_PATTERNS = [
  "SELECT *",
  "SELECT * FROM",
  ".findMany(",
  ".find(",
  ".findAll(",
  "Model.find(",
  "Model.findAll(",
  ".aggregate(",
  ".query(",
  "prisma.",
  "db.select(",
  "db.query(",
  ".collection(",
  ".getAll(",
];

// Pagination/limit indicators that suggest bounded queries
export const PAGINATION_PATTERNS = [
  ".limit(",
  ".take(",
  ".skip(",
  ".offset(",
  ".page(",
  ".perPage(",
  "LIMIT",
  "OFFSET",
  "TOP ",
  "FETCH FIRST",
  "pageSize",
  "pagination",
  ".slice(",
  ".paginate(",
];

// Collection processing patterns
export const COLLECTION_PROCESSING_PATTERNS = [
  ".map(",
  ".filter(",
  ".reduce(",
  ".forEach(",
  "for (",
  "for(",
  "for of",
  "for await",
];

// Batching indicators
export const BATCHING_PATTERNS = [
  "Promise.all(",
  "Promise.allSettled(",
  "chunk",
  "batch",
  "pageSize",
  "batchSize",
  "bulkWrite",
  "bulkInsert",
  "insertMany",
  "createMany",
  "$transaction",
];

// Memory-risky patterns (loading entire files/datasets into memory)
export const MEMORY_RISK_PATTERNS = [
  "fs.readFileSync(",
  "readFileSync(",
  ".readFile(",
  "JSON.parse(fs.",
  "JSON.parse(readFileSync",
  ".toString()",
  "Buffer.from(",
  ".getObject(",
  ".download(",
  "toArray()",
  ".toArray()",
];

// External API call patterns for caching detection
export const EXTERNAL_CALL_PATTERNS = [
  "fetch(",
  "axios.get(",
  "axios.post(",
  "axios(",
  "http.get(",
  "https.get(",
  "request(",
  "got(",
  "superagent",
];

// ============================================================================
// Concurrency/Contention pattern constants
// ============================================================================

// File write patterns (for SHARED_FILE_WRITE detection)
export const FILE_WRITE_PATTERNS = [
  "fs.writeFile(",
  "fs.writeFileSync(",
  "fs.appendFile(",
  "fs.appendFileSync(",
  "writeFile(",
  "writeFileSync(",
  "appendFile(",
  "appendFileSync(",
];

// Retry-related patterns
export const RETRY_PATTERNS = [
  "retry",
  "retries",
  "maxRetries",
  "numRetries",
  "attempt",
  "attempts",
];

// Backoff/jitter patterns that mitigate retry storms
export const BACKOFF_PATTERNS = [
  "backoff",
  "exponential",
  "jitter",
  "delay *",
  "setTimeout",
  "sleep(",
  "wait(",
];

// Tight loop patterns (for BUSY_WAIT_OR_TIGHT_LOOP detection)
export const TIGHT_LOOP_PATTERNS = [
  "while (true)",
  "while(true)",
  "for (;;)",
  "for(;;)",
  "while (1)",
  "while(1)",
];

// Check-then-act patterns (find/get followed by create/insert)
export const CHECK_PATTERNS = [
  ".findOne(",
  ".findUnique(",
  ".findFirst(",
  ".get(",
  ".getOne(",
  "SELECT.*WHERE",
  ".exists(",
];

export const ACT_PATTERNS = [
  ".create(",
  ".insert(",
  ".insertOne(",
  "INSERT INTO",
  ".save(",
  ".add(",
];
