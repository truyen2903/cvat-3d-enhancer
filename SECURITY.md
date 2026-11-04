# Security Policy — CVAT 3D Enhancer

## Supported Versions

| Version | Supported | Target CVAT Runtime |
| --- | --- | --- |
| `0.1.x` | Yes | CVAT `v2.81.0` (`cvat-canvas3d` `0.0.10`) |

## Reporting a Vulnerability

If you discover a security vulnerability in **CVAT 3D Enhancer**, please report it privately rather than opening a public issue:

1. **Report Channel**: Contact the repository maintainers via GitHub Private Vulnerability Reporting (Security Advisories) or your organization's application security contact.
2. **Required Details**:
   - Affected extension version and browser version.
   - CVAT server version and deployment type (`app.cvat.ai` or self-hosted).
   - Step-by-step reproduction or proof-of-concept.
   - Impact assessment (e.g., cross-context bridge bypass, credential exposure, XSS).
3. **Response SLA**:
   - Acknowledgment within **48 hours**.
   - Triage and remediation plan within **5 business days**.

## Non-Negotiable Security Invariants

- **Zero Credential Persistence on Disk**: Personal Access Tokens (PATs) are never stored in `chrome.storage.local`, `localStorage`, or `sessionStorage`. They reside exclusively in memory or `chrome.storage.session` (`TRUSTED_CONTEXTS`).
- **No `document.cookie` Scraping**: Browser sessions are verified strictly via same-origin `GET /api/users/self` with `credentials: 'same-origin'`.
- **Authenticated Page Bridge**: All messages between `content.ts` and `page-bridge.ts` require a per-session cryptographic token, strict command allowlisting, and Zod schema validation.
- **Shadow DOM UI Isolation**: All UI is rendered inside a Shadow DOM host using React safe text binding without `innerHTML` or `dangerouslySetInnerHTML`.
