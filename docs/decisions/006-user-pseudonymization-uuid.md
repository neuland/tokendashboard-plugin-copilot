# ADR-006: User Pseudonymization via Random UUID

## Decision
A random UUID is generated on first hook run and stored at `~/.copilot/tokendashboard-plugin/user-id`; it's sent as `user_id` in every batch.

## Why
- Per-user aggregation needs a stable identifier, but must not allow (easy) re-identification of the actual user (privacy/GDPR).
- `SHA-256(username)` looks anonymous but isn't: a company knows all its usernames, so a dictionary lookup (hash every username, compare) reverses it in milliseconds. Not sufficient.
- A random UUID with no derivation from any user attribute cannot be reversed by anyone, including under legal order.
- Deleting `user-id` breaks aggregation continuity for that user (a new UUID is generated, disconnected from history).

## Alternatives considered
HMAC(username, server-secret): enables controlled de-anonymization by whoever holds the key, but the key must be securely distributed and rotated. Would require a breaking migration for historical data.
