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
├── index.ts               # Express server entry point
├── env.ts                 # Environment variable config
├── analysis/              # Static analysis modules
│   ├── analyzer.ts        # Main analysis orchestration
│   ├── patterns.ts        # Detection pattern constants
│   ├── helpers.ts         # Analysis helper functions
│   ├── rules.ts           # RuleId types, default configs
│   └── scoring.ts         # Vibe Score computation
├── config/                # Configuration system
│   ├── schema.ts          # VibeScanConfig type definitions
│   ├── loader.ts          # .vibescan.yml loader
│   └── suppression.ts     # Inline suppression directives
└── integrations/          # External service integrations
    ├── github.ts          # GitHub webhook handlers, PR check runs
    └── llm.ts             # Groq/OpenAI LLM integration
```

## Key Concepts

### Static Analysis Rules (src/analysis/rules.ts)
- `RuleId`: Union of all rule identifiers (e.g., `UNBOUNDED_QUERY`, `UNSAFE_IO`)
- `RuleLevel`: `"error" | "warning" | "info" | "off"`
- Rules are categorized: scaling, concurrency, error handling, data integrity, code quality

### LLM Analysis (src/integrations/llm.ts)
- Uses Groq API (OpenAI-compatible) with llama-3.1-8b-instant
- 6 issue kinds: `SCALING_RISK`, `CONCURRENCY_RISK`, `ENVIRONMENT_ASSUMPTION`, `DATA_CONTRACT_RISK`, `OBSERVABILITY_GAP`, `RESILIENCE_GAP`
- LLM is **advisory only** - does NOT affect the Vibe Score

### Configuration (src/config/)
- `.vibescan.yml` in repo root configures rules, file ignores, scoring
- Supports per-path rule overrides
- Prototype zones (relaxed rules for experimental code)

### Suppression Directives (src/config/suppression.ts)
```typescript
// vibescan-ignore-file ALL
// vibescan-ignore-line RULE_ID
// vibescan-ignore-next-line RULE_ID,ANOTHER_RULE
```

### Vibe Score (src/analysis/scoring.ts)
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
1. Add the rule ID to `RuleId` type in `src/analysis/rules.ts`
2. Add default config in `DEFAULT_RULE_CONFIG`
3. Add detection patterns in `src/analysis/patterns.ts`
4. Add detection logic in `src/analysis/analyzer.ts`
5. Categorize in `RULE_CATEGORIES` if applicable

### Modifying LLM Prompt
- Edit `buildVibePrompt()` in `src/integrations/llm.ts`
- The 6 issue kinds are documented in the prompt

### Testing Config Loading
- Fixtures in `tests/fixtures/vibescan-config/`
- Test file: `tests/config.test.ts`
