-- Persist the optional denial reason an admin enters when revoking an approval.
-- Distinct from `reason`, which holds the original request justification set at
-- mint time. Previously the UI collected this reason but silently dropped it.
ALTER TABLE pending_approvals ADD COLUMN IF NOT EXISTS decision_reason TEXT;
