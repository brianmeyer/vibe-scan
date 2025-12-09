# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/claude-code) when working with this codebase.

## Project Overview

Vibe Scan is a GitHub App that analyzes pull requests for "vibe-coded" (AI-generated/prototype) production risks. It combines static analysis with LLM-powered review to identify scaling issues, concurrency problems, missing error handling, and other patterns that commonly cause production failures.

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
├── server.ts              # Express server entry point
├── config.ts              # Environment variable config
├── config/
│   ├── schema.ts          # VibeScanConfig type definitions
│   └── loadConfig.ts      # .vibescan.yml loader
├── core/
│   ├── rules.ts           # RuleId types, default configs
│   └── suppression.ts     # Inline suppression directives
├── analyzer.ts            # Static analysis (1300+ lines - needs splitting)
├── llm.ts                 # Groq/OpenAI LLM integration
├── scoring.ts             # Vibe Score computation
└── github.ts              # GitHub webhook handlers, PR check runs
```

## Key Concepts

### Static Analysis Rules (src/core/rules.ts)
- `RuleId`: Union of all rule identifiers (e.g., `UNBOUNDED_QUERY`, `UNSAFE_IO`)
- `RuleLevel`: `"error" | "warning" | "info" | "off"`
- Rules are categorized: scaling, concurrency, error handling, data integrity, code quality

### LLM Analysis (src/llm.ts)
- Uses Groq API (OpenAI-compatible) with llama-3.1-8b-instant
- 6 issue kinds: `SCALING_RISK`, `CONCURRENCY_RISK`, `ENVIRONMENT_ASSUMPTION`, `DATA_CONTRACT_RISK`, `OBSERVABILITY_GAP`, `RESILIENCE_GAP`
- LLM is **advisory only** - does NOT affect the Vibe Score

### Configuration (src/config/)
- `.vibescan.yml` in repo root configures rules, file ignores, scoring
- Supports per-path rule overrides
- Prototype zones (relaxed rules for experimental code)

### Suppression Directives (src/core/suppression.ts)
```typescript
// vibescan-ignore-file ALL
// vibescan-ignore-line RULE_ID
// vibescan-ignore-next-line RULE_ID,ANOTHER_RULE
```

### Vibe Score (src/scoring.ts)
- 0-100 score based on static findings only
- Scaling/concurrency issues have higher penalties
- Rule level (error/warning/info) applies weight multiplier

## Environment Variables

Required for GitHub App:
- `GITHUB_APP_ID`
- `GITHUB_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`

Required for LLM:
- `GROQ_API_KEY`

## Common Tasks

### Adding a New Static Rule
1. Add the rule ID to `RuleId` type in `src/core/rules.ts`
2. Add default config in `DEFAULT_RULE_CONFIG`
3. Add detection logic in `src/analyzer.ts`
4. Categorize in `RULE_CATEGORIES` if applicable

### Modifying LLM Prompt
- Edit `buildVibePrompt()` in `src/llm.ts`
- The 6 issue kinds are documented in the prompt

### Testing Config Loading
- Fixtures in `tests/fixtures/vibescan-config/`
- Test file: `tests/config.test.ts`
