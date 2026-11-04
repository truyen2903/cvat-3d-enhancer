# Security Baseline & Compliance Mapping — CVAT 3D Enhancer

> [!IMPORTANT]
> **VSOC Compliance Notice**:
> In accordance with project security requirements, **VSOC** is treated as an external organizational compliance requirement. Because the full external VSOC standard name, version, and control catalog document were not supplied in the workspace, **no claim of VSOC certification is made**. All VSOC-designated controls are explicitly marked as `UNVERIFIED — PENDING EXTERNAL VSOC CONTROL SPECIFICATION` in Section 2 below, while the full technical security baseline is implemented and tested.

---

## 1. Implemented Security Baseline (OWASP, ASVS, Chrome MV3)

| Domain | Control Requirement | Implementation Reference | Status |
| --- | --- | --- | --- |
| **Least Privilege (7.1)** | Minimum Chrome permissions (`storage` only); host permissions restricted to authorized CVAT origins; no `<all_urls>` active permission; no privileged Chrome APIs exposed to page scripts. | `manifest.config.ts` | **Implemented & Verified** |
| **Content Security Policy (7.2)** | Restrictive MV3 CSP: `script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none';`. Zero `unsafe-eval`, zero remote scripts, zero dynamic code execution. | `manifest.config.ts`, `scripts/check-secrets.mjs` | **Implemented & Verified** |
| **Secure Runtime Bridge (7.3)** | All messages validated with Zod (`BridgeRequestEnvelopeSchema`, `BridgeResponseEnvelopeSchema`); explicit command allowlist (`BRIDGE_COMMANDS`); origin & sender validation; per-session cryptographic token; prototype pollution guard; zero credentials on bridge. | `src/integration/cvat/bridge/index.ts`, `src/entrypoints/page-bridge.ts` | **Implemented & Verified** |
| **XSS & DOM Security (7.4)** | Shadow DOM UI isolation; React text binding only; zero `innerHTML` / `dangerouslySetInnerHTML`; hex color validation before CSS property assignment; DOM values never trusted as authentication state. | `src/ui/floating-panel/index.tsx`, `src/integration/cvat/dom/index.ts` | **Implemented & Verified** |
| **Authentication Security (7.5)** | Same-origin `/api/users/self` session detection; zero `document.cookie` access; optional PAT kept only in `EphemeralSessionStorageAdapter` (`chrome.storage.session` with `TRUSTED_CONTEXTS`); automatic token redaction in logger; HTTPS enforced for non-localhost origins. | `src/infrastructure/authentication/index.ts`, `src/core/logger.ts` | **Implemented & Verified** |
| **Supply Chain Security (7.6)** | Exact pinned dependency versions in `package.json`; generated `package-lock.json`; `npm audit` clean; automated secret & unsafe-execution scanner (`scripts/check-secrets.mjs`); third-party license table documented below. | `package.json`, `scripts/check-secrets.mjs` | **Implemented & Verified** |
| **Privacy (7.7)** | Zero telemetry or analytics; zero third-party network transmissions; no browsing history collection; annotation data is never transmitted or mutated. | `docs/security.md` (Section 3) | **Implemented & Verified** |

---

## 2. VSOC Compliance Mapping Table (Pending External Specification)

| VSOC Placeholder ID | Control Category | Technical Baseline Implemented in Repository | VSOC Verification Status |
| --- | --- | --- | --- |
| `VSOC-EXT-01` | Extension Permission Minimization | Manifest V3 requests only `storage` permission and explicit CVAT host permissions (`manifest.config.ts`). | **UNVERIFIED** (Awaiting external VSOC standard name, version & control catalog) |
| `VSOC-AUTH-01` | Credential Handling & Session Lifecycle | Session-first auth via `/api/users/self`; PAT restricted to ephemeral memory/`chrome.storage.session`; purged on `401/403` (`src/infrastructure/authentication/index.ts`). | **UNVERIFIED** (Awaiting external VSOC standard name, version & control catalog) |
| `VSOC-IPC-01` | Cross-Context Message Validation | Per-session token, origin check, command allowlist, and Zod validation on all bridge envelopes (`src/integration/cvat/bridge/index.ts`). | **UNVERIFIED** (Awaiting external VSOC standard name, version & control catalog) |
| `VSOC-LOG-01` | Sensitive Data Redaction in Logs | `Logger` redacts `Bearer`, `Token`, `Authorization`, `cookie`, `pat`, and `sessionid` patterns (`src/core/logger.ts`). | **UNVERIFIED** (Awaiting external VSOC standard name, version & control catalog) |
| `VSOC-SC-01` | Dependency & Supply Chain Hygiene | Exact version pinning (`--save-exact`), `package-lock.json`, `npm audit`, and static secret scanning (`scripts/check-secrets.mjs`). | **UNVERIFIED** (Awaiting external VSOC standard name, version & control catalog) |

---

## 3. Privacy Policy

1. **Data Collection**: CVAT 3D Enhancer stores only user-selected visualization preferences (theme preset, cuboid opacity, outline colors, and keyboard shortcuts) locally in `chrome.storage.local`.
2. **No Telemetry or Third-Party Transmission**: The extension contains zero analytics, tracking scripts, or external telemetry endpoints.
3. **Annotation Data Isolation**: All network requests are strictly same-origin calls to the user's active CVAT server (`/api/users/self` and `/api/server/about`). Annotation payloads, point clouds, task names, and project metadata are never transmitted to any third party.

---

## 4. Third-Party Runtime Dependencies & Licenses

| Package | Pinned Version | License | Purpose |
| --- | --- | --- | --- |
| `react` | `18.3.1` | MIT | UI component rendering inside Shadow DOM |
| `react-dom` | `18.3.1` | MIT | DOM root mounting for Shadow DOM panel and popup |
| `zod` | `4.6.7` | MIT | Runtime schema validation for bridge messages, API responses, and configs |
| `zustand` | `5.0.16` | MIT | Lightweight reactive state store for UI synchronization |
