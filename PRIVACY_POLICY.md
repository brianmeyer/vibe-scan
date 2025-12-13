# Privacy Policy

**Effective Date:** December 13, 2024

**Last Updated:** December 13, 2024

Vibe Scale ("we," "our," or "us") is a GitHub App that analyzes Pull Requests for architectural risks. This Privacy Policy explains how we collect, use, and protect your information.

## Information We Collect

When you install Vibe Scale on your GitHub repositories, we access:

- **Repository Metadata:** Repository names, IDs, and organization information necessary to identify installations
- **Pull Request Content:** Temporary access to code files and diffs in Pull Requests via the GitHub API
- **Installation Identifiers:** GitHub App installation IDs used to track usage quotas

## How We Process Your Code

### Static Analysis

Code is analyzed using regex pattern matching and Abstract Syntax Tree (AST) parsing in ephemeral Node.js processes. This analysis happens **entirely in memory** and is discarded immediately after processing. We do not store your source code.

### AI-Assisted Analysis

For complex code patterns, we may send code snippets to Groq, a third-party Large Language Model (LLM) provider, for additional analysis.

**Important safeguards:**

- All code is scanned and stripped of secrets (API keys, passwords, tokens) before being sent to any third party
- Code snippets are sent only for analysis purposes and are not retained by Groq after processing
- **Your code is never used to train AI models**

## Data Retention

| Data Type | Retention Period |
|-----------|------------------|
| Source code | Not stored (processed in memory only) |
| Token usage counters | Duration of installation + 35 days |
| Application logs | 30 days |

**What we store:**

- **Token usage counters:** We maintain a simple counter in Redis linked to your installation ID to enforce monthly usage limits. This contains no code or repository content.
- **Application logs:** Retained for 30 days for debugging and service reliability. Logs do not contain full source code.

**What we do NOT store:**

- Your source code
- Pull Request content
- Repository file contents
- Code snippets sent for analysis

## Third-Party Services

We use the following third-party services to operate Vibe Scale:

| Service | Purpose | Data Shared |
|---------|---------|-------------|
| GitHub | Source code access | Repository metadata, PR content (via API) |
| Groq | AI-powered code analysis | Redacted code snippets |
| Railway | Application hosting | Application logs |
| Redis (via Railway) | Usage tracking | Installation IDs, usage counters |

We do not sell your data to any third party.

## Security

We implement the following security measures:

- All data transmission uses HTTPS/TLS encryption
- Automatic redaction of secrets and credentials before external transmission
- Ephemeral processing with no persistent code storage
- Rate limiting to prevent abuse
- Secure webhook verification for all GitHub communications

## Your Rights

You can exercise the following rights at any time:

- **Access:** Request information about what data we process
- **Deletion:** Uninstall the GitHub App to stop all data processing; usage counters are automatically deleted after 35 days
- **Restriction:** Configure the app via `.vibescan.yml` to limit analysis scope

To uninstall Vibe Scale, visit your GitHub organization or account settings and remove the app from your installations.

## Children's Privacy

Vibe Scale is a developer tool not intended for use by children under 13. We do not knowingly collect information from children.

## Changes to This Policy

We may update this Privacy Policy from time to time. We will notify users of significant changes by updating the "Last Updated" date at the top of this document.

## Contact

If you have questions about this Privacy Policy or our data practices, please open an issue at our GitHub repository or contact us through GitHub.

---

**Summary:** Vibe Scale analyzes your code in memory, does not store it, strips secrets before any external transmission, and never uses your code to train AI models. Your code stays yours.
