# Authentication Architecture — CVAT 3D Enhancer

## 1. CVAT Authentication Mechanisms Verified (CVAT v2.81.0)

Inspection of the official `cvat-ai/cvat` (`v2.81.0`) repository verified:

- **Default Authentication Classes** (`cvat/settings/base.py`):
  - `rest_framework.authentication.TokenAuthentication`
  - `cvat.apps.access_tokens.authentication.AccessTokenAuthentication` (`keyword = "Bearer"`)
  - Session authentication via HTTP-only `sessionid` cookie and `csrftoken` (`CSRF_COOKIE_NAME = "csrftoken"`).
- **Authenticated User Endpoint**:
  - `GET /api/users/self` returns the authenticated user profile (`id`, `username`, `email`, `is_staff`) with HTTP `200 OK`, or `401/403` when unauthenticated or expired.

## 2. Authentication Flow

1. **Origin Validation**: `validateCvatOrigin()` verifies that the current origin is in the authorized allowlist (`https://app.cvat.ai`, `http://localhost:8080`, `http://127.0.0.1:8080`) and enforces HTTPS for all non-localhost origins.
2. **Primary Method — Existing CVAT Browser Session (`CvatSessionProvider`)**:
   - Executes a same-origin `GET /api/users/self` request with `credentials: 'same-origin'`.
   - Never accesses `document.cookie`, `localStorage`, or `sessionStorage`.
   - Never prompts for a password or token when the browser session is already active.
3. **Optional Fallback — Personal Access Token (`PersonalAccessTokenProvider`)**:
   - If the user explicitly supplies a PAT in the Overview tab, it is validated against `GET /api/users/self` using `Authorization: Bearer <PAT>` and `credentials: 'omit'`.
   - Stored exclusively in `EphemeralSessionStorageAdapter` (in-memory `Map` + `chrome.storage.session` restricted to `TRUSTED_CONTEXTS`).
   - Never persisted in `chrome.storage.local` and never sent across `PageBridge`.
4. **Expiration & Revocation Handling**:
   - If a previously authenticated session returns `401/403`, state transitions to `expired` (`SESSION_EXPIRED`).
   - If a PAT returns `401/403`, `PersonalAccessTokenProvider.clear()` immediately purges the token from memory/session storage and transitions to `expired` (`TOKEN_REVOKED`).
