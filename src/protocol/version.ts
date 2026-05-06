/**
 * Plugin↔Daemon protocol version. Bumped when wire format breaks compat.
 *
 * Mismatch handling: daemon rejects register from plugin with mismatched
 * version, replies register_reject with reason="protocol_mismatch" and the
 * expected version. Plugin logs and exits (or stays in reconnect loop with
 * a clear stderr message).
 */

export const PROTOCOL_VERSION = 1
