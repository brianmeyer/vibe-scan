# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/claude-code) when working with this codebase.

## Project Overview

Vibe Scale is a GitHub App that analyzes pull requests for "vibe-coded" (AI-generated/prototype) production risks. It combines **AST-based static analysis** with **LLM-powered review** to identify scaling issues, concurrency problems, missing error handling, and other patterns that commonly cause production failures.

## Build & Development Commands

```bash
npm run dev      # Start development server with ts-node
npm run build    # Compile TypeScript to dist/
npm run start    # Run compiled server from dist/
npm test         # Run tests (requires Jest setup)
```

## Architecture

```
src/
├── index.ts               # Express server entry point (webhooks, health check)
├── env.ts                 # Environment variable config
├── redis.ts               # Redis client singleton for token quota
├── logger.ts              # Structured JSON logging for production
├── analysis/              # Static analysis modules
│   ├── analyzer.ts        # Main analysis orchestration
│   ├── ast.ts             # AST analysis coordinator (hybrid AST+regex)
│   ├── ast/               # Language-specific AST analyzers
│   │   ├── typescript.ts  # TypeScript/JavaScript via ts-morph
│   │   ├── python.ts      # Python via tree-sitter
│   │   ├── go.ts          # Go via tree-sitter
│   │   └── ruby.ts        # Ruby via tree-sitter
│   ├── patterns.ts        # Detection pattern constants (regex)
│   ├── helpers.ts         # Analysis helper functions
│   ├── rules.ts           # RuleId types, default configs
│   ├── scoring.ts         # Vibe Score computation
│   └── structure.ts       # Code structure extraction for LLM context
├── config/                # Configuration system
│   ├── schema.ts          # VibeScaleConfig type definitions
│   ├── loader.ts          # .vibescale.yml loader
│   └── suppression.ts     # Inline suppression directives
└── integrations/          # External service integrations
    ├── github.ts          # GitHub webhook handlers, PR check runs
    └── llm.ts             # Groq/OpenAI LLM integration + token quota

Deployment:
├── Dockerfile             # Multi-stage Docker build for Railway
├── railway.toml           # Railway configuration (health checks, restart policy)
└── .dockerignore          # Docker build exclusions
```

## Key Concepts

### AST Analysis System (src/analysis/ast.ts, src/analysis/ast/)

**Hybrid analysis**: Combines AST parsing with regex fallback for maximum coverage.

| Language | Parser | Capabilities |
|----------|--------|--------------|
| TypeScript/JavaScript | ts-morph | Full type info, scope detection |
| Python | tree-sitter | Function/class boundaries |
| Go | tree-sitter | Goroutine detection |
| Ruby | tree-sitter | Block/method scopes |
| Others | Regex fallback | Pattern matching |

**Key functions:**
- `canAnalyzeWithAST(language)` - Check if AST analysis is available
- `analyzeWithAST(content, language, config)` - Run AST analysis
- `getIgnoredRanges(content, language)` - Extract comment/string ranges to filter regex

**AST advantages:**
- Scope-aware detection (inside try/catch, loops, route handlers)
- Comment and string literal filtering (reduces false positives)
- Type information for TypeScript

### Static Analysis Rules (src/analysis/rules.ts)

23 rules across 6 categories:

| Category | Rule IDs |
|----------|----------|
| **Scaling** | `UNBOUNDED_QUERY`, `UNBOUNDED_COLLECTION_PROCESSING`, `MISSING_BATCHING`, `NO_CACHING`, `MEMORY_RISK`, `LOOPED_IO`, `BLOCKING_OPERATION` |
| **Concurrency** | `SHARED_FILE_WRITE`, `RETRY_STORM_RISK`, `BUSY_WAIT_OR_TIGHT_LOOP`, `CHECK_THEN_ACT_RACE`, `GLOBAL_MUTATION` |
| **Error Handling** | `UNSAFE_IO`, `SILENT_ERROR`, `ASYNC_MISUSE` |
| **Data Integrity** | `UNVALIDATED_INPUT`, `DATA_SHAPE_ASSUMPTION`, `MIXED_RESPONSE_SHAPES`, `HARDCODED_SECRET` |
| **Code Quality** | `TEMPORARY_HACK`, `CONSOLE_DEBUG` |
| **Architecture/Security** | `STATEFUL_SERVICE`, `PROTOTYPE_INFRA`, `UNSAFE_EVAL`, `HARDCODED_URL` |

**Types:**
- `RuleId`: Union of all rule identifiers
- `RuleLevel`: `"error" | "warning" | "info" | "off"`
- `RULE_CATEGORIES`: Maps rules to categories for weighted scoring

### Analysis Modes (src/analysis/analyzer.ts)

1. **PR Patch Analysis** (`analyzePullRequestPatchesWithConfig`)
   - Analyzes changed lines in diff patches
   - Fast, focused on what changed

2. **Full File Scanning** (Phase 1)
   - Critical issues anywhere in touched files
   - Rules: `STATEFUL_SERVICE`, `PROTOTYPE_INFRA`, `HARDCODED_SECRET`, `UNSAFE_EVAL`, `GLOBAL_MUTATION`

3. **Baseline Repository Scan** (`analyzeRepository`)
   - One-time full repo analysis for new installations
   - Establishes baseline metrics

### Code Structure Extraction (src/analysis/structure.ts)

Extracts file structure for LLM context to reduce token usage:

```typescript
extractFileStructure(content, language)
// Returns: imports, classes, functions, decorators

extractCompactStructure(content, language)
// Returns: "42 lines, 5 imports, 2 classes, 8 functions"
```

### LLM Analysis (src/integrations/llm.ts)

- Uses Groq API (OpenAI-compatible) with `llama-3.1-8b-instant`
- **Advisory only** - does NOT affect the Vibe Score
- Temperature: 0.1, Max tokens: 4096

**6 issue kinds:**
- `SCALING_RISK` - Performance/cost issues
- `CONCURRENCY_RISK` - Race conditions
- `ENVIRONMENT_ASSUMPTION` - Hidden infra assumptions
- `DATA_CONTRACT_RISK` - Data shape issues
- `OBSERVABILITY_GAP` - Missing logging/metrics
- `RESILIENCE_GAP` - Missing fault tolerance

**Token quota:**
- Monthly per-installation limits stored in Redis
- Keys: `vibe:usage:{installationId}:{YYYY-MM}`
- Auto-expires after 35 days
- `isQuotaExceeded()`, `recordTokenUsage()`, `getTokenUsage()`

### Configuration (src/config/)

**Schema** (src/config/schema.ts):
- `VibeScaleConfig` - Main config type
- `RuleConfig` - Per-rule configuration
- `ScoringConfig` - Vibe Score settings

**Loading** (src/config/loader.ts):
- Loads `.vibescale.yml` from repo
- Falls back to default config
- Supports path-specific overrides
- Prototype zone support

### Suppression Directives (src/config/suppression.ts)

Three scopes (works in any language's comment syntax):
```
vibescale-ignore-file ALL|RULE_ID[,RULE_ID...]
vibescale-ignore-line ALL|RULE_ID[,RULE_ID...]
vibescale-ignore-next-line ALL|RULE_ID[,RULE_ID...]
```

### Vibe Score (src/analysis/scoring.ts)

- 0-100 score based on static findings only
- `computeVibeScore(findings, config)` - Main function
- Scaling/concurrency/security rules have heavier penalties
- Rule level multipliers: error (1.0), warning (0.5), info (0.2)

**Score labels:**
- 90-100: Excellent
- 75-89: Good
- 60-74: Moderate risk
- 40-59: Risky
- 0-39: Critical risk

### GitHub Integration (src/integrations/github.ts)

**Webhook handlers:**
- `pull_request` - PR opened/updated/synchronize
- `check_suite` - Check suite requested

**Key functions:**
- `createInstallationOctokit(installationId)` - Auth for API calls
- `fetchPullRequestFiles()` - Get PR diff patches
- `fetchFileContent()` - Get full file content (50KB limit)
- `fetchRepoConfig()` - Load .vibescale.yml

**Check run results:**
- Creates detailed check run with findings summary
- Posts PR comment for high-risk scores
- Architecture risk breakdown in summary

## Environment Variables

Required for GitHub App:
- `GITHUB_APP_ID`
- `GITHUB_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`

Required for LLM:
- `GROQ_API_KEY`

Required for Production:
- `REDIS_URL` - Redis connection string (required for token quota protection)
- `MONTHLY_TOKEN_QUOTA` - Optional, default 100,000 tokens/month per installation

Set by Railway automatically:
- `PORT` - Server port (Railway sets this dynamically)
- `NODE_ENV` - Set to "production" in Dockerfile

## Common Tasks

### Adding a New Static Rule

1. Add the rule ID to `RuleId` type in `src/analysis/rules.ts`
2. Add default config in `DEFAULT_RULE_CONFIG`
3. Add detection patterns in `src/analysis/patterns.ts`
4. Add detection logic in `src/analysis/analyzer.ts`
5. For AST detection: add to relevant analyzer in `src/analysis/ast/`
6. Categorize in `RULE_CATEGORIES` for weighted scoring
7. Add description in `RULE_DESCRIPTIONS` for reporting

### Adding AST Support for a New Language

1. Create `src/analysis/ast/{language}.ts`
2. Implement `analyze{Language}(content, config): Finding[]`
3. Add to `canAnalyzeWithAST()` in `src/analysis/ast.ts`
4. Add to `analyzeWithAST()` switch statement
5. Handle parse errors gracefully (fall back to regex)

### Modifying LLM Prompt

- Edit `buildVibePrompt()` in `src/integrations/llm.ts`
- The 6 issue kinds are documented in the prompt
- Consider token usage (structure extraction helps)

### Testing Config Loading

- Fixtures in `tests/fixtures/vibescale-config/`
- Test file: `tests/config.test.ts`

## Production Features

### Server Endpoints (src/index.ts)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Status page with version |
| `/health` | GET | Health check (Redis latency, GitHub config status) |
| `/webhook` | POST | GitHub webhook handler |

### Health Check (`/health`)

Returns JSON with:
- `status`: "healthy" | "degraded" | "unhealthy"
- `timestamp`: ISO timestamp
- `uptime`: Server uptime in seconds
- `checks.redis`: { status, latency }
- `checks.github`: { status }

### Token Quota (src/integrations/llm.ts)

- Monthly per-installation token limits stored in Redis
- Keys: `vibe:usage:{installationId}:{YYYY-MM}`
- Automatically expires after 35 days
- Skips LLM analysis when quota exceeded (returns null)

### Rate Limiting (src/index.ts)

- General: 100 req/min
- Webhooks: 60 req/min
- Health checks excluded from rate limiting
- Uses `express-rate-limit`
- Requires `trust proxy` for Railway/load balancers

### Async Webhook Processing

- Responds to GitHub immediately (200 OK)
- Processes analysis in background (fire and forget)
- Prevents GitHub webhook timeouts (10 second limit)
- Errors logged but don't crash server

### Graceful Shutdown

- Handles SIGTERM/SIGINT signals
- Sets `isShuttingDown` flag to reject new requests (503)
- Closes HTTP server
- Closes Redis connections cleanly

### Structured Logging (src/logger.ts)

- Production: JSON format for log aggregators
- Development: Human-readable format
- Levels: debug, info, warn, error
- Includes metadata (deliveryId, event, error details)
