/**
 * Leader-only background maintenance.
 *
 * Everything here is idempotent and safe to run late, but NOT safe to run
 * concurrently on two instances — rollup upserts would race and partition DDL
 * would fight. Each task therefore runs inside `withFence`, so a scheduler that
 * lost its advisory lock without noticing is rejected by the fencing token
 * rather than trusted.
 */
export { rollup5m, rollup1h, refreshLatencyBaselines } from "./rollups";
export { enforceRawRetention, maintainPartitions } from "./retention";
export { updateRegionQuarantine, detectFlapping } from "./regions";
export { checkCertificateExpiry, checkHeartbeats } from "./incidents";
