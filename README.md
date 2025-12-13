# Vibe Scale

**AI-Powered Architectural Linter for GitHub**

[![Vibe Score](https://img.shields.io/badge/vibe--scale-enabled-brightgreen)](https://github.com/brianmeyer/vibe-scale)

Vibe Scale is a GitHub App that catches "vibe-coded" production risks before they ship. It combines **fast static analysis** with **deep AI reasoning** to identify scaling issues, concurrency bugs, and architectural anti-patterns that commonly cause production failures in AI-generated or prototype code.

---

## The Problem: Vibe-Coded Production Failures

"Vibe coding" produces code that *works on your laptop* but *breaks at scale*:

| Pattern | What It Looks Like | What Happens in Production |
|---------|-------------------|---------------------------|
| **In-Memory State** | `const cache = {}` in a service | State lost on restart, inconsistent across replicas |
| **Unbounded Queries** | `SELECT * FROM users` | OOM crash when table grows |
| **Race Conditions** | Check-then-act without locks | Data corruption under concurrent requests |
| **Silent Failures** | Empty catch blocks | Bugs hidden until customer impact |
| **Hardcoded Secrets** | `apiKey = "sk-..."` | Credentials leaked in version control |

These patterns pass code review because they work in demos. Vibe Scale catches them before production.

---

## How It Works

```
┌────────────────────────────────────────────────────────────────────────────┐
│                           GitHub Pull Request                              │
└────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  TIER 1: Static Analysis (Fast, Deterministic)                             │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐        │
│  │   AST Parsing   │ +  │  Regex Patterns │ +  │  Full File Scan │        │
│  │  (ts-morph,     │    │  (23 rules,     │    │  (Critical      │        │
│  │   tree-sitter)  │    │   all languages)│    │   issues only)  │        │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘        │
└────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  SMART FUNNEL: selectLlmCandidates()                                       │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│  • If findings are obvious (HARDCODED_SECRET, UNSAFE_EVAL) → Skip AI       │
│  • If findings need reasoning (UNBOUNDED_QUERY, SILENT_ERROR) → Use AI     │
│  • Ranks files by severity, selects top 3 candidates                       │
└────────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    │ Only if fuzzy risks detected  │
                    ▼                               ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  TIER 2: AI Analysis (Deep Reasoning)                                      │
│  ┌─────────────────────────────────────────────────────────────────┐      │
│  │  1. Fetch full file content                                      │      │
│  │  2. redactSecrets() → Strip API keys, passwords                 │      │
│  │  3. extractFileStructure() → Imports, classes, functions        │      │
│  │  4. Send to Groq (Qwen3-32B) for deep analysis                  │      │
│  │  5. Validate static findings, filter false positives            │      │
│  └─────────────────────────────────────────────────────────────────┘      │
└────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  REPORTING                                                                 │
│  • Check Run with detailed findings breakdown                              │
│  • Vibe Score (0-100) based on static analysis                             │
│  • Architecture Risk Summary by category                                   │
│  • PR Comment for high-risk PRs (score < 60)                              │
└────────────────────────────────────────────────────────────────────────────┘
```

### Tier 1: Static Analysis

Fast, deterministic detection using AST parsing and regex patterns:

| Language | Parser | Capabilities |
|----------|--------|--------------|
| TypeScript/JavaScript | ts-morph | Full type info, scope-aware detection |
| Python | tree-sitter | Function/class boundaries |
| Go | tree-sitter | Goroutine detection |
| Ruby | tree-sitter | Block/method scopes |
| Others | Regex | Pattern matching fallback |

**23 detection rules** across 6 categories:

| Category | Rules |
|----------|-------|
| **Scaling** | `UNBOUNDED_QUERY`, `UNBOUNDED_COLLECTION_PROCESSING`, `MISSING_BATCHING`, `NO_CACHING`, `MEMORY_RISK`, `LOOPED_IO`, `BLOCKING_OPERATION` |
| **Concurrency** | `SHARED_FILE_WRITE`, `RETRY_STORM_RISK`, `BUSY_WAIT_OR_TIGHT_LOOP`, `CHECK_THEN_ACT_RACE`, `GLOBAL_MUTATION` |
| **Error Handling** | `UNSAFE_IO`, `SILENT_ERROR`, `ASYNC_MISUSE` |
| **Data Integrity** | `UNVALIDATED_INPUT`, `DATA_SHAPE_ASSUMPTION`, `MIXED_RESPONSE_SHAPES`, `HARDCODED_SECRET` |
| **Code Quality** | `TEMPORARY_HACK`, `CONSOLE_DEBUG` |
| **Architecture** | `STATEFUL_SERVICE`, `PROTOTYPE_INFRA`, `UNSAFE_EVAL`, `HARDCODED_URL` |

### The Smart Funnel

Not all findings need AI validation. The `selectLlmCandidates()` function implements a cost-saving strategy:

```typescript
// Rules that are simple pattern matches - fast model is sufficient
SIMPLE_RULES = ["TEMPORARY_HACK", "CONSOLE_DEBUG", "HARDCODED_SECRET",
                "HARDCODED_URL", "UNSAFE_EVAL", "BLOCKING_OPERATION"]

// Rules that require deeper reasoning to validate properly
COMPLEX_RULES = ["UNBOUNDED_QUERY", "SILENT_ERROR", "LOOPED_IO",
                 "MISSING_BATCHING", "STATEFUL_SERVICE", "GLOBAL_MUTATION",
                 "CHECK_THEN_ACT_RACE", "RETRY_STORM_RISK"]
```

**Result:** AI is only invoked when findings are ambiguous, saving ~70% on API costs.

### Tier 2: AI Analysis

For complex findings, Vibe Scale sends code to Groq's LLM for deep reasoning:

| Issue Kind | What It Catches |
|------------|-----------------|
| `SCALING_RISK` | N+1 queries, unbounded loops, memory growth |
| `CONCURRENCY_RISK` | Race conditions, deadlocks, resource contention |
| `ENVIRONMENT_ASSUMPTION` | Hardcoded paths, missing env vars |
| `DATA_CONTRACT_RISK` | Unvalidated inputs, shape assumptions |
| `OBSERVABILITY_GAP` | Missing logging, silent failures |
| `RESILIENCE_GAP` | No retries, missing circuit breakers |

**AI findings are advisory only** — they do NOT affect the numeric Vibe Score.

### Vibe Score

A 0-100 score indicating production readiness:

| Score | Label | Action |
|-------|-------|--------|
| 90-100 | Excellent | Ship it |
| 75-89 | Good | Minor review |
| 60-74 | Moderate risk | Review before production |
| 40-59 | Risky | Significant issues |
| 0-39 | Critical risk | Do not merge |

**Scoring weights:**
- Scaling/concurrency/security rules: **1.5x penalty**
- Rule levels: error (1.0), warning (0.5), info (0.2)

---

## Key Features

### Hybrid Analysis Engine

Combines the best of both approaches:

- **AST Analysis**: Scope-aware detection, filters comments/strings, understands code structure
- **Regex Patterns**: Fast fallback for unsupported languages, catches simple patterns
- **Graceful Fallback**: If AST parsing fails, automatically falls back to regex

### Cost Controls

**Smart Skip**: Skips AI for obvious findings (saves API costs)

```typescript
// If all findings are in SIMPLE_RULES, skip LLM entirely
if (findings.every(f => SIMPLE_RULES.has(f.kind))) {
  return []; // No LLM candidates
}
```

**Circuit Breaker**: Redis-backed monthly token quotas per installation

```typescript
// Check quota before LLM call
if (await isQuotaExceeded(installationId)) {
  return null; // Skip LLM, continue with static only
}
```

### Security: Secret Redaction

All code is stripped of secrets before leaving your infrastructure:

```typescript
function redactSecrets(content: string): string {
  // Matches API keys, passwords, tokens, connection strings
  for (const pattern of SECRET_PATTERNS) {
    content = content.replace(pattern, "[REDACTED_SECRET]");
  }
  return content;
}
```

**Your code is never stored.** Analysis happens in ephemeral processes.

### Resilience: Fire-and-Forget Webhooks

GitHub requires webhook responses within 10 seconds. Vibe Scale:

1. Verifies signature synchronously
2. Responds `200 OK` immediately
3. Processes analysis in background

```typescript
// Respond immediately - GitHub expects response within 10 seconds
res.status(200).json({ ok: true });

// Process webhook in background (fire and forget)
webhooks.receive({ id, name, payload }).catch((err) => {
  logger.error("Webhook handler error", { error: err.message });
});
```

---

## Configuration

Create a `.vibecheck.yml` in your repository root:

```yaml
version: 1

# Rule-level configuration
rules:
  UNBOUNDED_QUERY:
    enabled: true
    level: error
  CONSOLE_DEBUG:
    enabled: false    # Disable for this repo
  TEMPORARY_HACK:
    level: warning    # Downgrade from error

# File patterns to ignore
files:
  ignore:
    - "tests/**"
    - "**/*.spec.ts"
    - "**/*.test.js"
  prototype_zone:
    - "playground/**"
    - "experiments/**"

# Scoring thresholds
scoring:
  high_risk_vibe_score: 60   # PR comment threshold
  weight_multiplier: 1.0     # Global penalty multiplier

# LLM analysis settings
llm:
  enabled: true
  validate_findings: true    # Use AI to filter false positives
  confidence_threshold: 0.6  # Minimum confidence to show finding

# Path-specific overrides
overrides:
  - patterns:
      - "src/infra/**"
    rules:
      NO_CACHING:
        level: error
```

### Inline Suppressions

Suppress findings with comments in any language:

```typescript
// Suppress all rules for the entire file
/* vibecheck-ignore-file ALL */

// Suppress specific rule for next line
// vibecheck-ignore-next-line UNBOUNDED_QUERY
const users = await db.users.findMany();

// Suppress on same line
const data = await fetch("/api"); // vibecheck-ignore-line UNSAFE_IO

// Suppress multiple rules
// vibecheck-ignore-next-line UNSAFE_IO,SILENT_ERROR
```

```python
# vibecheck-ignore-file ALL

# vibecheck-ignore-next-line UNBOUNDED_QUERY
users = db.query("SELECT * FROM users")
```

---

## Deployment

### Prerequisites

1. **GitHub App** with these permissions:
   - Pull requests: Read & Write
   - Checks: Read & Write
   - Contents: Read
   - Webhook events: `pull_request`, `check_suite`

2. **Groq API Key** (for AI analysis)

3. **Redis** (for token quota tracking)

### Deploy to Railway

1. Create a new project on [Railway](https://railway.app)
2. Add a **Redis** service
3. Connect your GitHub repo
4. Set environment variables:

```bash
# Required - GitHub App
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n..."
GITHUB_WEBHOOK_SECRET=your_webhook_secret

# Required - Infrastructure
REDIS_URL=redis://...   # Railway auto-injects this

# Required - AI Analysis
GROQ_API_KEY=gsk_...

# Optional
MONTHLY_TOKEN_QUOTA=100000   # Default: 100k tokens/month/installation
```

5. Configure public networking
6. Set your GitHub App webhook URL to `https://your-app.up.railway.app/webhook`

### Health Check

```bash
curl https://your-app.up.railway.app/health
```

```json
{
  "status": "healthy",
  "timestamp": "2024-12-13T12:00:00Z",
  "uptime": 3600,
  "checks": {
    "redis": { "status": "connected", "latency": 2 },
    "github": { "status": "ok" }
  }
}
```

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Status page with version |
| `/health` | GET | Health check (Redis, GitHub config) |
| `/webhook` | POST | GitHub webhook handler |
| `/api/analyze` | POST | Programmatic analysis (for GitHub Actions) |

---

## Architecture

```
src/
├── index.ts                 # Express server, webhooks, health check
├── env.ts                   # Environment variable config
├── redis.ts                 # Redis client (token quota)
├── logger.ts                # Structured JSON logging
├── analysis/
│   ├── orchestration.ts     # PR analysis coordinator
│   ├── ast.ts               # AST analysis (hybrid engine)
│   ├── ast/                 # Language-specific parsers
│   │   ├── typescript.ts    # ts-morph
│   │   ├── python.ts        # tree-sitter
│   │   ├── go.ts            # tree-sitter
│   │   └── ruby.ts          # tree-sitter
│   ├── detectors/           # Rule detection modules
│   ├── patterns.ts          # Regex patterns
│   ├── rules.ts             # Rule definitions
│   ├── scoring.ts           # Vibe Score computation
│   └── structure.ts         # Code structure extraction
├── config/
│   ├── schema.ts            # Config type definitions
│   ├── loader.ts            # .vibecheck.yml loader
│   └── suppression.ts       # Inline directive parsing
└── integrations/
    ├── github/              # GitHub App integration
    │   ├── webhooks.ts      # Event handlers
    │   ├── files.ts         # Content fetching, redaction
    │   └── comments.ts      # PR comment generation
    └── llm/                 # AI analysis integration
        ├── analysis.ts      # LLM orchestration
        ├── validation.ts    # Finding validation
        ├── quota.ts         # Token quota management
        └── prompts.ts       # Prompt construction
```

---

## Production Features

- **Async Webhook Processing**: Responds immediately, processes in background
- **Rate Limiting**: 100 req/min (general), 60 req/min (webhooks)
- **Token Quota**: Monthly per-installation limits with Redis TTL
- **Graceful Shutdown**: Clean Redis disconnect on SIGTERM/SIGINT
- **Structured Logging**: JSON logs in production for aggregators
- **Health Checks**: `/health` endpoint for load balancers

---

## License

ISC
