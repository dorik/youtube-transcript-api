-- Cache for translated transcripts.
--
-- Kept separate from `cached_transcripts` (005) on purpose: that table's
-- `language` column means "the language the transcript text is actually in,
-- straight from YouTube/Whisper". A translated payload also happens to be in
-- the target language, but the upstream source differs (translator output
-- vs native captions), the timestamps came from the original, and
-- semantically it's a different artifact. Mixing them would risk serving a
-- translated transcript when a caller asks for native captions in that
-- same language.
--
-- Key is (video_id, source_language, target_language). Source language is
-- part of the key because the same target (e.g. 'fr') translated from
-- different source languages produces different text.
CREATE TABLE IF NOT EXISTS translated_transcripts (
  video_id VARCHAR(20) NOT NULL,
  source_language VARCHAR(20) NOT NULL,
  target_language VARCHAR(20) NOT NULL,
  -- Which translator produced this row. Lets us invalidate / re-translate
  -- entries from a worse engine (e.g. 'google') later without nuking
  -- 'openai' rows. Not part of the PK by design: only one cached
  -- translation per (video, src, tgt) at a time.
  translator VARCHAR(50),
  transcript_text TEXT NOT NULL,
  segments JSONB NOT NULL,
  character_count INTEGER,
  segment_count INTEGER,
  first_cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  access_count INTEGER NOT NULL DEFAULT 1,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  PRIMARY KEY (video_id, source_language, target_language)
);

CREATE INDEX IF NOT EXISTS idx_translated_transcripts_video_id
  ON translated_transcripts(video_id);
CREATE INDEX IF NOT EXISTS idx_translated_transcripts_expires_at
  ON translated_transcripts(expires_at);
CREATE INDEX IF NOT EXISTS idx_translated_transcripts_access_count
  ON translated_transcripts(access_count);
