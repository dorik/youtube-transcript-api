-- Repair the C1 cache-hit corruption and enforce the completed/result invariant.
--
-- The old enqueueBatch() inserted cache-hit videos straight as `completed`
-- with no `result`. Those rows can never be served (the transcript was never
-- written) and they poison every future de-dup: findDuplicateRequest() would
-- re-serve the empty row forever.
--
-- 1. Delete the corrupt rows. They carry no transcript and no credit charge,
--    so dropping them loses nothing — a fresh request will re-fetch cleanly.
--    (transcript_batches.total may then over-count children for a few old
--    batches; that is cosmetic and only affects already-broken batches.)
-- 2. Add a CHECK constraint so a row can only be `completed` when it actually
--    carries a `result` — turning any future silent data loss into a loud,
--    debuggable write error. Every code path that sets `completed`
--    (markCompleted) writes `result` in the same UPDATE, so this holds.

DELETE FROM transcript_requests
  WHERE status = 'completed' AND result IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'transcript_requests_completed_has_result'
  ) THEN
    ALTER TABLE transcript_requests
      ADD CONSTRAINT transcript_requests_completed_has_result
      CHECK (status <> 'completed' OR result IS NOT NULL);
  END IF;
END $$;
